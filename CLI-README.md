# Pumpfun Volume Market Maker Bot CLI

A comprehensive CLI tool for running the Pumpfun Volume Market Maker Bot with interactive configuration.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the CLI Bot
```bash
npm start
# or
npm run bot
# or
npx ts-node cli-bot.ts
```

## 📋 CLI Configuration

The CLI will ask you for the following configuration:

1. **Distribution Number** (1-500): How many wallets to create and distribute SOL to
2. **Base Mint Address**: The token mint address you want to trade
3. **Total Time Minutes** (1-1440): How long the bot should run
4. **Minimum SOL per Wallet** (0.001-1): Minimum SOL amount per wallet

## 🔄 Bot Workflow

### Step 1: Configuration
- Interactive CLI prompts for all settings
- Validation of Solana addresses
- Confirmation before execution

### Step 2: SOL Distribution
- Distributes SOL from main wallet to random wallets
- Creates `wallet.json` with all wallet data
- Validates sufficient balance

### Step 3: Wallet Splitting
- **20%** → Volume Bot (runVolumeBot)
- **30%** → Market Maker Bot (runMarketMakerBot)  
- **50%** → Big Trade Bot (runBigTradeBot)

### Step 4: Bot Execution
- All three bots run in parallel
- Real-time progress monitoring
- Automatic completion handling

## 📊 Bot Types

### Volume Bot (20% wallets)
- Continuous buy/sell operations
- Random intervals and amounts
- Creates steady volume

### Market Maker Bot (30% wallets)
- Market making strategies
- Balanced buy/sell operations
- Maintains liquidity

### Big Trade Bot (50% wallets)
- Large volume trades
- Creates significant price movements
- Random buy/sell differences

## 🛠️ Commands

```bash
# Start the CLI bot
npm start

# Run specific bot functions (for testing)
npm run gather
npm run test

# TypeScript compilation check
npm run tsc
```

## 📁 File Structure

```
├── cli-bot.ts          # Main CLI interface
├── index.ts            # Bot functions and logic
├── wallet.json         # Generated wallet data
├── data.json           # Additional data storage
└── package.json        # Dependencies and scripts
```

## ⚠️ Important Notes

1. **Main Wallet Balance**: Ensure your main wallet has sufficient SOL
2. **Token Mint**: Use valid Solana token mint addresses
3. **Network**: Configure RPC endpoints in constants
4. **Safety**: Test with small amounts first

## 🔧 Configuration Files

- `constants/constants.ts` - RPC endpoints, private keys, etc.
- `wallet.json` - Generated wallet data
- `data.json` - Additional bot data

## 📈 Example Usage

```bash
$ npm start

🚀 Welcome to Pumpfun Volume Market Maker Bot CLI
================================================

📊 How many wallets to distribute SOL to? (recommended: 50-200): 100
🪙 Enter the token mint address (baseMint): 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr
⏰ How many minutes should the bot run? (recommended: 30-120): 60
💰 Minimum SOL per wallet (recommended: 0.01-0.1): 0.05

✅ Configuration saved:
   📊 Distribution wallets: 100
   🪙 Token mint: 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr
   ⏰ Runtime: 60 minutes
   💰 Min SOL per wallet: 0.05 SOL

🤔 Do you want to proceed with this configuration? (y/n): y

🔄 Step 1: Distributing SOL to wallets...
==========================================
💰 Main wallet balance: 5.234567 SOL
✅ Successfully distributed SOL to 100 wallets
📁 Wallet data saved to wallet.json

🔄 Step 2: Splitting wallets into bot groups...
===============================================
📊 Total wallets: 100
📈 Volume Bot wallets: 20 (20%)
🤖 Market Maker wallets: 30 (30%)
📊 Big Trade wallets: 50 (50%)

🚀 Step 3: Starting main bot operations...
==========================================
🎯 All bots started successfully!
⏰ Running for 60 minutes...

✅ Volume Bot completed
✅ Market Maker Bot completed
✅ Big Trade Bot completed

🎉 All bot operations completed!
```

## 🆘 Troubleshooting

- **Insufficient Balance**: Check main wallet SOL balance
- **Invalid Address**: Ensure token mint address is valid
- **RPC Errors**: Check RPC endpoint configuration
- **Transaction Failures**: Verify network conditions

## 📞 Support

For issues or questions, check the console output for detailed error messages.
