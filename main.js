import 'dotenv/config';
import fs from 'fs';
import inquirer from 'inquirer';
import { ethers } from 'ethers';
import solc from 'solc';
import chalk from 'chalk';
import { printBanner } from './utils/banner.js';
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);

const rpcUrls = (process.env.RPC_URL || "https://dream-rpc.somnia.network,https://rpc.ankr.com/somnia_testnet,https://somnia-poc.w3us.site/api/eth-rpc")
  .split(",")
  .map(url => url.trim());

let stableProviderCache = { provider: null, timestamp: 0 };

async function selectStableProvider() {
  const cacheDuration = 60000;
  const nowTime = Date.now();
  if (stableProviderCache.provider && nowTime - stableProviderCache.timestamp < cacheDuration) {
    return stableProviderCache.provider;
  }
  let bestProvider = null;
  let bestLatency = Infinity;
  for (const url of rpcUrls) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url);
      const start = Date.now();
      const latestBlock = await provider.getBlock("latest");
      const latency = Date.now() - start;
      const now = Math.floor(Date.now() / 1000);
      if (now - latestBlock.timestamp <= 30) {
        if (latency < bestLatency) {
          bestLatency = latency;
          bestProvider = provider;
        }
      } else {
        logWarning(`⏰ RPC ${url} is not synchronized (block diff ${now - latestBlock.timestamp} sec).`);
      }
    } catch (error) {
      logWarning(`🚫 RPC ${url} error: ${error.message}`);
    }
  }
  if (!bestProvider) {
    bestProvider = new ethers.providers.JsonRpcProvider(rpcUrls[0]);
    logWarning(`⚠️ No RPC meets the requirements. Fallback to: ${rpcUrls[0]}`);
  } else {
    logInfo(`📡 Stable RPC selected: ${bestProvider.connection.url} (latency ${bestLatency}ms)`);
  }
  stableProviderCache = { provider: bestProvider, timestamp: nowTime };
  return bestProvider;
}

const baseWallet = new ethers.Wallet(process.env.MAIN_PRIVATE_KEY);
async function getStableWallet() {
  const provider = await selectStableProvider();
  return baseWallet.connect(provider);
}

async function updateHardhatConfig() {
  const provider = await selectStableProvider();
  const stableUrl = provider.connection.url;
  const configContent = `require("@nomicfoundation/hardhat-verify");

module.exports = {
  solidity: "0.8.28",
  networks: {
    "somnia-testnet": {
      url: "${stableUrl}",
      chainId: 50312,
      accounts: [process.env.MAIN_PRIVATE_KEY]
    }
  },
  etherscan: {
    apiKey: {
      "somnia-testnet": process.env.EXPLORER_API_KEY || "empty"
    },
    customChains: [
      {
        network: "somnia-testnet",
        chainId: 50312,
        urls: {
          apiURL: "https://shannon-explorer.somnia.network/api",
          browserURL: "https://shannon-explorer.somnia.network/"
        }
      }
    ]
  },
  sourcify: {
    enabled: false
  }
};
`;
  fs.writeFileSync("hardhat.config.cjs", configContent);
  logInfo(`📝 Updated Hardhat config with stable RPC: ${stableUrl}`);
}

let CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";
const EXPLORER_URL = process.env.EXPLORER_URL || "";
let contractInstance = null;

function getTimestamp() {
  return new Date().toLocaleTimeString();
}

function logInfo(message) {
  console.log(chalk.blue(`[${getTimestamp()}]-[info] ℹ️ : ${message}`));
}

function logSuccess(message) {
  console.log(chalk.green(`[${getTimestamp()}]-[success] ✅ : ${message}`));
}

function logWarning(message) {
  console.log(chalk.yellow(`[${getTimestamp()}]-[warning] ⚠️ : ${message}`));
}

function logError(message) {
  console.log(chalk.red(`[${getTimestamp()}]-[error] ❌ : ${message}`));
}

async function promptWithBack(questions) {
  const answers = await inquirer.prompt(questions);
  for (const key in answers) {
    if (typeof answers[key] === 'string' && answers[key].trim().toLowerCase() === 'back') {
      logInfo("🔙 'back' detected. Returning to main menu...");
      return null;
    }
  }
  return answers;
}

function printSeparator(length = 50) {
  console.log("=".repeat(length));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function monitorNetwork() {
  try {
    const provider = await selectStableProvider();
    const latestBlock = await provider.getBlock("latest");
    const now = Math.floor(Date.now() / 1000);
    if (now - latestBlock.timestamp > 30) {
      logWarning("⚡ Blockchain is not updating quickly.");
      return false;
    }
    const walletInst = await getStableWallet();
    const balance = await walletInst.getBalance();
    const minBalance = ethers.utils.parseEther("0.01");
    if (balance.lt(minBalance)) {
      logWarning("💰 Insufficient wallet balance.");
      return false;
    }
    return true;
  } catch (error) {
    logError("🚨 Network monitoring error: " + error);
    return false;
  }
}

async function waitForRPCRecovery() {
  while (!(await monitorNetwork())) {
    logWarning("⏳ RPC/network conditions not normal, waiting 10 seconds...");
    await delay(10000);
  }
}

async function sendTransactionWithRetry(txParams, maxRetries = 3) {
  let attempts = 0;
  let updatedGasPrice = txParams.gasPrice || (await (await selectStableProvider()).getGasPrice());
  while (attempts < maxRetries) {
    try {
      const walletInst = await getStableWallet();
      const currentNonce = await walletInst.getTransactionCount("pending");
      const tx = await walletInst.sendTransaction({
        ...txParams,
        nonce: currentNonce,
        gasPrice: updatedGasPrice
      });
      logInfo(`💸 Tx Hash: ${tx.hash}`);
      if (EXPLORER_URL) {
        logInfo(`🔎 Explorer: ${EXPLORER_URL}/tx/${tx.hash}`);
      }
      logInfo("⏳ Waiting for transaction confirmation...");
      await tx.wait();
      return tx;
    } catch (error) {
      const errMsg = error.message.toLowerCase();
      if (errMsg.includes("nonce") && errMsg.includes("too low")) {
        logWarning("🔄 Nonce too low, fetching latest nonce...");
        await delay(5000);
        attempts++;
        continue;
      } else if ((errMsg.includes("fee") || errMsg.includes("gas")) && errMsg.includes("too low")) {
        logWarning("📈 Fee too low, increasing gas price...");
        const currentGasPrice = await (await selectStableProvider()).getGasPrice();
        updatedGasPrice = currentGasPrice.mul(120).div(100);
        attempts++;
        continue;
      } else if (errMsg.includes("502") || errMsg.includes("gateway") || errMsg.includes("enotfound")) {
        attempts++;
        logWarning(`⚠️ Transaction failed due to server/DNS error. Retrying (${attempts}/${maxRetries})...`);
        await delay(10000);
        continue;
      } else {
        throw error;
      }
    }
  }
  throw new Error("❌ Transaction failed after several attempts.");
}

async function compileContractWithHardhat() {
  logInfo("🛠️ Running Hardhat compile...");
  try {
    const { stdout } = await execPromise("npx hardhat compile");
    logSuccess("🛠️ Hardhat compile succeeded.");
  } catch (error) {
    logError("🛠️ Hardhat compile failed: " + error);
    throw error;
  }
  const artifactPath = "artifacts/contracts/CustomToken.sol/CustomToken.json";
  if (!fs.existsSync(artifactPath)) {
    throw new Error("📦 Artifact not found: " + artifactPath);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return { abi: artifact.abi, bytecode: artifact.bytecode.object || artifact.bytecode };
}

async function ensureHardhatInstalled() {
  if (!fs.existsSync("node_modules/hardhat/package.json")) {
    const answer = await promptWithBack([{ type: "confirm", name: "installHardhat", message: "🔧 Hardhat is not installed. Do you want to install it now?", default: true }]);
    if (answer === null) return false;
    if (answer.installHardhat) {
      logInfo("🔧 Installing Hardhat and verification plugin...");
      try {
        await execPromise("npm install --save-dev hardhat @nomicfoundation/hardhat-verify");
        logSuccess("🔧 Hardhat and verification plugin installed successfully.");
      } catch (error) {
        logError("🔧 Failed to install Hardhat: " + error);
        process.exit(1);
      }
    } else {
      logWarning("⚠️ Hardhat is not installed. Automatic verification will not run.");
      return false;
    }
  }
  if (!fs.existsSync("hardhat.config.cjs")) {
    const answer = await promptWithBack([{ type: "confirm", name: "initHardhat", message: "🚀 Hardhat project is not initialized. Do you want to initialize it automatically?", default: true }]);
    if (answer === null) return false;
    if (answer.initHardhat) {
      logInfo("🚀 Initializing minimal Hardhat project...");
      await updateHardhatConfig();
    } else {
      logWarning("⚠️ Hardhat project is not initialized. Automatic verification might fail.");
      return false;
    }
  }
  return true;
}

async function verifyContractHardhat(contractAddress, constructorArgs, maxAttempts = 3) {
  const isInstalled = await ensureHardhatInstalled();
  if (!isInstalled) return false;
  const network = "somnia-testnet";
  const argsString = constructorArgs.map(arg => `"${arg}"`).join(" ");
  const cmd = `npx hardhat verify --network ${network} ${contractAddress} ${argsString}`;
  logInfo(`🔍 Verifying contract with Hardhat: ${cmd}`);
  let attempts = 0;
  while (attempts < maxAttempts) {
    logInfo(`🔍 Contract verification attempt: ${attempts + 1}/${maxAttempts}`);
    try {
      const { stdout } = await execPromise(cmd);
      const lowerOut = stdout.toLowerCase();
      if (lowerOut.includes("verification submitted") || lowerOut.includes("has already been verified") || lowerOut.includes("successfully verified contract")) {
        logSuccess(`🔍 Hardhat verification successful: ${stdout}`);
        return true;
      } else {
        logWarning(`🔍 Attempt ${attempts + 1} failed. Output: ${stdout}`);
      }
    } catch (error) {
      logError(`🔍 Attempt ${attempts + 1} failed: ${error}`);
    }
    attempts++;
    if (attempts < maxAttempts) {
      logInfo("🔍 Retrying contract verification in 5 seconds...");
      await delay(5000);
    }
  }
  logError(`🔍 Contract verification failed after ${maxAttempts} attempts. Please verify manually using Hardhat.`);
  return false;
}

async function deployContract() {
  const answers = await promptWithBack([
    { type: 'input', name: 'name', message: 'Enter Contract Name:' },
    { type: 'input', name: 'symbol', message: 'Enter Contract Symbol:' },
    { type: 'input', name: 'decimals', message: 'Enter Decimals (default 18):', validate: input => {
        if (input.trim().toLowerCase() === 'back') return true;
        if (isNaN(input) || Number(input) <= 0) return 'Must be a valid number';
        return true;
      }
    },
    { type: 'input', name: 'totalSupply', message: 'Enter Total Supply (e.g., 100000):', validate: input => {
        if (input.trim().toLowerCase() === 'back') return true;
        if (isNaN(input) || Number(input) <= 0) return 'Must be a valid number';
        return true;
      }
    }
  ]);
  if (answers === null) return;
  printSeparator();
  logInfo("🚀 Preparing to deploy contract...");
  const { abi, bytecode } = await compileContractWithHardhat();
  const walletInst = await getStableWallet();
  const factory = new ethers.ContractFactory(abi, bytecode, walletInst);
  const totalSupplyInWei = ethers.utils.parseUnits(answers.totalSupply, Number(answers.decimals));
  logInfo("🚀 Sending contract deployment transaction...");
  const contract = await factory.deploy(answers.name, answers.symbol, Number(answers.decimals), totalSupplyInWei);
  logInfo(`🚀 Tx Hash: ${contract.deployTransaction.hash}`);
  if (EXPLORER_URL) {
    logInfo(`🔎 Explorer: ${EXPLORER_URL}/tx/${contract.deployTransaction.hash}`);
  }
  logInfo("🚀 Waiting for transaction confirmation (this may take some time)...");
  await contract.deployed();
  logSuccess(`🚀 Contract successfully deployed at address: ${contract.address}`);
  printSeparator();
  contractInstance = contract;
  CONTRACT_ADDRESS = contract.address;
  updateEnvVariable("CONTRACT_ADDRESS", contract.address);
  logInfo("🔍 Verifying contract automatically with Hardhat...");
  await updateHardhatConfig();
  const verified = await verifyContractHardhat(contract.address, [answers.name, answers.symbol, answers.decimals, totalSupplyInWei.toString()]);
  if (!verified) {
    logWarning("🔍 Contract has not been verified automatically. Please verify manually if needed.");
  } else {
    logSuccess("🔍 Contract verified successfully.");
  }
  logInfo(`📋 Contract Details:
- Name: ${answers.name}
- Symbol: ${answers.symbol}
- Decimals: ${answers.decimals}
- Total Supply: ${answers.totalSupply} (equivalent to ${totalSupplyInWei.toString()} smallest units)
- Address: ${contract.address}
- Verification Status: ${verified ? "Verified" : "Not Verified"}`);
  await inquirer.prompt([{ type: 'input', name: 'return', message: 'Press "Enter" to return to the main menu...' }]);
}

async function sendNativeToken() {
  const answers = await promptWithBack([
    { type: 'input', name: 'destination', message: 'Enter the destination address:' },
    { type: 'input', name: 'amount', message: 'Enter the amount of native token to send:' }
  ]);
  if (answers === null) return;
  printSeparator();
  logInfo("🚀 Preparing to send native token transaction...");
  const destination = answers.destination;
  const amount = ethers.utils.parseUnits(answers.amount, 18);
  await waitForRPCRecovery();
  try {
    if (!CONTRACT_ADDRESS) {
      const tx = await sendTransactionWithRetry({ to: destination, value: amount });
      logSuccess(`💸 Transfer successful. Tx Hash: ${tx.hash}`);
      if (EXPLORER_URL) {
        logInfo(`🔎 Explorer: ${EXPLORER_URL}/tx/${tx.hash}`);
      }
    } else {
      if (!contractInstance) {
        const { abi } = await compileContractWithHardhat();
        contractInstance = new ethers.Contract(CONTRACT_ADDRESS, abi, await getStableWallet());
      }
      contractInstance = contractInstance.connect(await getStableWallet());
      const contractBalance = await contractInstance.provider.getBalance(contractInstance.address);
      if (contractBalance.gte(amount)) {
        const tx = await contractInstance.sendNative(destination, amount);
        logSuccess(`💸 Transfer successful via contract. Tx Hash: ${tx.hash}`);
        if (EXPLORER_URL) {
          logInfo(`🔎 Explorer: ${EXPLORER_URL}/tx/${tx.hash}`);
        }
      } else {
        logWarning("⚠️ Contract does not have enough native tokens. Using main wallet instead.");
        const tx = await sendTransactionWithRetry({ to: destination, value: amount });
        logSuccess(`💸 Transfer successful. Tx Hash: ${tx.hash}`);
        if (EXPLORER_URL) {
          logInfo(`🔎 Explorer: ${EXPLORER_URL}/tx/${tx.hash}`);
        }
      }
    }
  } catch (err) {
    logError(`❌ Transfer failed: ${err}`);
  }
  await inquirer.prompt([{ type: 'input', name: 'return', message: 'Press "Enter" to return to the main menu...' }]);
}

async function sendERC20Token() {
  if (!CONTRACT_ADDRESS) {
    logError("❌ Contract not deployed. Please deploy the contract first.");
    await delay(5000);
    return;
  }
  if (!contractInstance) {
    const { abi } = await compileContractWithHardhat();
    contractInstance = new ethers.Contract(CONTRACT_ADDRESS, abi, await getStableWallet());
  }
  const answers = await promptWithBack([
    { type: 'input', name: 'destination', message: 'Enter the destination address:' },
    { type: 'input', name: 'amount', message: 'Enter the token amount to send:' },
    { type: 'input', name: 'tokenSymbol', message: 'Enter the token symbol (must match deployed token):' }
  ]);
  if (answers === null) return;
  printSeparator();
  const deployedSymbol = await contractInstance.symbol();
  if (deployedSymbol !== answers.tokenSymbol) {
    logError(`❌ Token with symbol ${answers.tokenSymbol} not found. Deployed token is ${deployedSymbol}.`);
    await delay(5000);
    return;
  }
  logInfo("🚀 Preparing to send ERC20 token transaction...");
  const tokenDecimals = await contractInstance.decimals();
  const amountInSmallestUnit = ethers.utils.parseUnits(answers.amount, tokenDecimals);
  try {
    contractInstance = contractInstance.connect(await getStableWallet());
    const tx = await contractInstance.sendToken(answers.destination, amountInSmallestUnit);
    logSuccess(`🪙 Transfer successful. Tx Hash: ${tx.hash}`);
    if (EXPLORER_URL) {
      logInfo(`🔎 Explorer: ${EXPLORER_URL}/tx/${tx.hash}`);
    }
  } catch (err) {
    logError(`❌ Transfer failed: ${err}`);
  }
  await inquirer.prompt([{ type: 'input', name: 'return', message: 'Press "Enter" to return to the main menu...' }]);
}

function updateEnvVariable(key, value) {
  const envPath = '.env';
  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const newLine = `${key}=${value}`;
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, newLine);
  } else {
    envContent += `\n${newLine}`;
  }
  fs.writeFileSync(envPath, envContent);
  logInfo(`📝 .env file updated: ${key}=${value}`);
}

async function mainMenu() {
  printBanner();
  try {
    const answer = await promptWithBack([
      { type: 'list', name: 'action', message: 'Select an option (use number or arrow keys):', choices: [
          { name: '1. Deploy New Contract (Create ERC20 Token)', value: 'deploy' },
          { name: '2. Send Native Token (STT)', value: 'sendNative' },
          { name: '3. Send ERC20 Token (if custom token is deployed)', value: 'sendERC20' },
          { name: '4. Exit', value: 'exit' }
        ]
      }
    ]);
    if (answer === null) return mainMenu();
    if (answer.action === 'deploy') {
      await deployContract();
    } else if (answer.action === 'sendNative') {
      await sendNativeToken();
    } else if (answer.action === 'sendERC20') {
      await sendERC20Token();
    } else if (answer.action === 'exit') {
      console.clear();
      logInfo("🚪 Exiting safely...");
      process.exit(0);
    }
  } catch (error) {
    logError(`⚠️ Error in main menu: ${error}`);
  }
  mainMenu();
}

process.on("unhandledRejection", (reason, promise) => {
  console.error(`[${new Date().toLocaleTimeString()}]-[error] ❌ : Unhandled Rejection: ${reason}`);
});

mainMenu();
