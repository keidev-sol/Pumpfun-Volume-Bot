# Enhanced Pumpfun Volume Market Maker Bot CLI

## 🚀 New Features

The CLI has been completely upgraded with a modern menu-driven interface featuring three main modes:

### 💼 Wallet Manager
- **Generate Wallets + Mixer**: Create batches of wallets with SOL distribution
- **View Wallets**: Check SOL and token balances across all wallets
- **Sell Tokens**: Rotate through wallets selling specified percentages
- **Collect SOL**: Gather all SOL from wallets back to main wallet
- **Transfer All Tokens**: Move all tokens to one wallet, sell, and collect

### 🤖 Market Maker Mode
- **Start Bot**: Launch the market maker bot with custom runtime
- **Configure Bot**: Adjust bot parameters and settings
- **View Bot Status**: Monitor bot performance and wallet status

### 💰 Sell Mode
- **Percentage-based Selling**: Set custom sell percentages (0-100%)
- **Time Intervals**: Configure delays between sales (in minutes)
- **Wallet Rotation**: Automatically cycles through all wallets
- **Continuous Operation**: Runs indefinitely until manually stopped

### ⚙️ Legacy Bot Mode
- **Original Functionality**: Access to the previous bot implementation
- **Full Configuration**: Complete setup with SOL distribution and bot splitting

## 📋 Usage

### Starting the CLI
```bash
npm run start
# or
npm run bot
```

### Menu Navigation
The CLI uses arrow keys and Enter to navigate through menus. All options are clearly labeled with emojis for easy identification.

## 🔧 Key Features

### Wallet Manager - Generate Wallets + Mixer
1. **Input**: Number of wallets to generate (e.g., 100)
2. **Input**: Total SOL amount to distribute
3. **Process**: 
   - Generates first batch of wallets
   - Generates second batch (mixer wallets)
   - Distributes SOL to first batch
   - Saves both batches to separate files
4. **Output**: `wallet.json` and `mixer.json` files

### View Wallets
- **Real-time Balance Checking**: Queries Solana network for current balances
- **Progress Tracking**: Shows progress every 10 wallets processed
- **Summary Statistics**:
  - Total wallets count
  - Total SOL balance
  - Total token balance
  - Wallets with tokens
  - Average SOL per wallet

### Sell Mode
- **Configuration**:
  - Sell percentage (0-100%)
  - Time interval between sales (minutes)
- **Operation**:
  - Rotates through all wallets in `wallet.json`
  - Sells specified percentage from each wallet
  - Waits for specified time interval
  - Continues indefinitely
- **Example**: Sell 1% every 1 minute = Wallet 1 sells 1%, wait 1 min, Wallet 2 sells 1%, wait 1 min, etc.

### Collect SOL
- **Functionality**: Uses the existing `gather.ts` functionality
- **Process**: Collects all SOL from wallets back to main wallet
- **Safety**: Requires confirmation before execution

## 🛠️ Technical Implementation

### Dependencies Added
- `inquirer`: Interactive command-line prompts
- `@types/inquirer`: TypeScript definitions

### File Structure
```
cli-bot.ts          # Main CLI interface
wallet.json         # Generated wallet data
mixer.json          # Mixer wallet data
gather.ts           # SOL collection functionality
```

### Key Classes and Methods
- `PumpfunCLIBot`: Main CLI class
- `walletManager()`: Wallet management interface
- `marketMakerMode()`: Market maker bot interface
- `sellMode()`: Sell mode interface
- `generateWalletsMixer()`: Wallet generation with mixer
- `viewWallets()`: Balance checking and display
- `startSellProcess()`: Rotating sell process
- `collectSOL()`: SOL collection

## 🔒 Safety Features

- **Confirmation Prompts**: All destructive operations require confirmation
- **Input Validation**: All numeric inputs are validated
- **Error Handling**: Comprehensive error handling throughout
- **Progress Tracking**: Real-time progress updates for long operations

## 📊 Example Workflows

### Basic Wallet Management
1. Start CLI: `npm run start`
2. Select "💼 Wallet Manager"
3. Select "🔄 Generate Wallets + Mixer"
4. Enter: 100 wallets, 1.0 SOL
5. Select "👀 View Wallets" to check balances

### Sell Mode Operation
1. Start CLI: `npm run start`
2. Select "💰 Sell Mode"
3. Enter: 1% sell, 1 minute interval
4. Confirm to start
5. Bot rotates through wallets selling 1% every minute

### Market Maker Bot
1. Start CLI: `npm run start`
2. Select "🤖 Market Maker Mode"
3. Select "🚀 Start Bot"
4. Enter runtime: 60 minutes
5. Bot runs for specified time

## 🚨 Important Notes

- **Wallet Files**: Always ensure `wallet.json` exists before using sell/collect functions
- **SOL Balance**: Check main wallet balance before generating wallets
- **Network Connection**: Requires stable Solana RPC connection
- **Token Configuration**: Update token mint addresses in configuration as needed

## 🔄 Migration from Legacy

The original bot functionality is preserved in "⚙️ Legacy Bot Mode" for backward compatibility. All new features are available through the modern menu interface while maintaining access to the original implementation.

## 📈 Performance

- **Parallel Processing**: Wallet balance checking processes multiple wallets simultaneously
- **Efficient Queries**: Optimized Solana network queries
- **Memory Management**: Proper cleanup and resource management
- **Error Recovery**: Graceful handling of network issues and timeouts
