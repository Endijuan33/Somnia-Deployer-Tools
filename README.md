# Somnia Deployer Tools 🚀

A CLI tool for automated ERC20 deployment and transactions on Somnia Testnet. Built with ethers.js and Hardhat.

## Features ✨

- 🛠️ Deploy custom ERC20 contracts with verification
- 💸 Send native STT tokens
- 🪙 Transfer ERC20 tokens
- 🔄 Automatic RPC endpoint selection
- 🔍 Blockchain explorer integration
- 🔐 Secure environment variable management

## Prerequisites 📋

- Node.js v18+
- npm v9+
- Somnia Testnet account with STT balance
- Basic understanding of blockchain transactions

## Installation 💻

```bash
git clone https://github.com/Endijuan33/Somnia-Deployer-Tools.git
cd Somnia-Deployer-Tools
npm install
cp .env.example .env
```

## Configuration ⚙️

Edit `.env` file:

```ini
MAIN_PRIVATE_KEY=0xyour_wallet_private_key
RPC_URL=https://dream-rpc.somnia.network,https://rpc.ankr.com/somnia_testnet,https://somnia-poc.w3us.site/api/eth-rpc
CHAIN_ID=50312
EXPLORER_URL=https://shannon-explorer.somnia.network/
CONTRACT_ADDRESS=
```

| Variable          | Description                          |
|-------------------|--------------------------------------|
| MAIN_PRIVATE_KEY  | Your wallet private key (testnet!)   |
| RPC_URL           | Comma-separated RPC endpoints        |
| CHAIN_ID          | Somnia Testnet chain ID (50312)      |
| EXPLORER_URL      | Transaction explorer URL             |
| CONTRACT_ADDRESS  | [Optional] Pre-deployed contract     |

## Usage 🕹️

Start the interactive CLI:

```bash
npm start
```

### Main Menu Options

1. **Deploy ERC20 Contract** 📄
   - Guided token creation
   - Automatic verification
   - Set name/symbol/decimals/supply

2. **Send STT Tokens** 💰
   - Transfer native currency
   - Custom amount selection
   - Real-time gas estimation

3. **Send ERC20 Tokens** 🪙
   - Token balance checks
   - Address validation
   - Symbol confirmation

4. **Exit** 👋
   - Clean process termination

## Security 🔒

- 🔑 Private keys stored ONLY in environment variables
- 🌐 Testnet-only operations
- 🚫 Never share your `.env` file
- ⚠️ Mainnet use strictly discouraged

## Important Notes 📌

- Maintain minimum 0.5 STT for gas fees
- Contract verification requires Hardhat
- RPC endpoints automatically optimized
- Transaction links open in default browser

## Updating 🔄

```bash
git pull origin main
npm install
```

## License 📄

MIT License - See [LICENSE](LICENSE) for details

## Disclaimer ⚠️

> **Warning:** This tool is for educational purposes only. Use at your own risk on testnet environments only. Not affiliated with Somnia or any blockchain entity. Developers assume no responsibility for financial losses or network issues.
