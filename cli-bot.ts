#!/usr/bin/env node

import * as readline from 'readline';
import { PublicKey, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { 
  getAssociatedTokenAddress, 
  createTransferCheckedInstruction, 
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID, 
  getAccount
} from '@solana/spl-token';
import { distributeSol, runVolumeBot, runMarketMakerBot, runBigTradeBot, sell, sellPumpswap } from './index';
import { readJson, saveDataToFile, Data, getBondingCurveAccount } from './utils';
import { solanaConnection, mainKp } from './index';
import { MIN_SOL, Target_MINT } from './constants';
import inquirer from 'inquirer';
import base58 from 'bs58';
import { BN } from 'bn.js';
import { gather } from './gather';
import path from 'path';
import fs from "fs";
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes';

interface BotConfig {
  distributionNum: number;
  baseMintAddress: string;
  totalTimeMinutes: number;
  minSol: number;
}

interface WalletSplit {
  volumeBotWallets: any[];
  marketMakerWallets: any[];
  bigTradeWallets: any[];
}

interface WalletInfo {
  privateKey: string;
  pubkey: string;
  solBalance?: number;
  tokenBalance?: number;
}

class PumpfunCLIBot {
  private config: BotConfig | null = null;
  private rl: readline.Interface;
  private baseMint: PublicKey;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.baseMint = new PublicKey(Target_MINT);
  }

  // ✅ Ask text question
  private async askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => resolve(answer.trim()));
    });
  }

  // ✅ Ask number with validation
  private async askNumberQuestion(question: string, min?: number, max?: number): Promise<number> {
    while (true) {
      const answer = await this.askQuestion(question);
      const num = parseFloat(answer);
      if (isNaN(num)) {
        console.log("❌ Please enter a valid number.");
        continue;
      }
      if (min !== undefined && num < min) {
        console.log(`❌ Please enter a number greater than or equal to ${min}.`);
        continue;
      }
      if (max !== undefined && num > max) {
        console.log(`❌ Please enter a number less than or equal to ${max}.`);
        continue;
      }
      return num;
    }
  }

  // ✅ Validate Solana address
  private validateSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  // ✅ Initialize configuration (load or create)
  private async initializeConfig(): Promise<BotConfig> {
    const settingsPath = path.join(process.cwd(), "settings.json");

    // 🔹 Step 1: Check if settings.json exists
    if (fs.existsSync(settingsPath)) {
      const savedConfig: BotConfig = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

      console.log("\n🧾 Found existing configuration:");
      console.log(`   📊 Wallets: ${savedConfig.distributionNum}`);
      console.log(`   🪙 Token mint: ${savedConfig.baseMintAddress}`);
      console.log(`   ⏰ Runtime: ${savedConfig.totalTimeMinutes} minutes`);
      console.log(`   💰 Min SOL per wallet: ${savedConfig.minSol} SOL\n`);

      const useOld = await this.askQuestion("Use previous settings? (Y/n): ");
      if (useOld.toLowerCase() === "y" || useOld === "") {
        this.config = savedConfig;
        this.baseMint = new PublicKey(savedConfig.baseMintAddress);
        console.log("✅ Using saved configuration.\n");
        this.rl.close();
        return this.config;
      } else {
        console.log("🧹 Creating new configuration...\n");
      }
    }

    // 🔹 Step 2: Ask new configuration questions
    const distributionNum = await this.askNumberQuestion(
      "📊 How many wallets to distribute SOL to? : ",
      1,
      500
    );

    // 2. Get and validate base mint
    let baseMintAddress: string;
    while (true) {
      baseMintAddress = await this.askQuestion("🪙 Enter the token mint address (baseMint): ");
      if (this.validateSolanaAddress(baseMintAddress)) {
        this.baseMint = new PublicKey(baseMintAddress);
        break;
      } else {
        console.log("❌ Invalid Solana address. Please try again.");
      }
    }

    // 3. Get total runtime
    const totalTimeMinutes = await this.askNumberQuestion(
      "⏰ How many minutes should the bot run? : ",
      1,
      1440
    );

    // 4. Get min SOL per wallet
    const minSol = await this.askNumberQuestion("💰 Minimum SOL per wallet : ", 0.001, 1);

    // 🔹 Step 3: Save config
    this.config = {
      distributionNum: Math.floor(distributionNum),
      baseMintAddress,
      totalTimeMinutes: Math.floor(totalTimeMinutes),
      minSol,
    };

    // 🔹 Step 4: Save config to file
    fs.writeFileSync(settingsPath, JSON.stringify(this.config, null, 2), "utf8");
    console.log("💾 Configuration saved to settings.json");

    // 🔹 Step 5: Display summary
    console.log("\n✅ Configuration Summary:");
    console.log(`   📊 Wallets: ${this.config.distributionNum}`);
    console.log(`   🪙 Token mint: ${this.config.baseMintAddress}`);
    console.log(`   ⏰ Runtime: ${this.config.totalTimeMinutes} minutes`);
    console.log(`   💰 Min SOL per wallet: ${this.config.minSol} SOL\n`);

    this.rl.close();
    return this.config;
  }

  // ✅ Public method to start the bot
  public async start(): Promise<void> {
    if (!this.config) {
      await this.initializeConfig();
    }

    console.log("🚀 Bot started with configuration:", this.config);
    // Continue bot logic here...
  }

  private async confirmExecution(): Promise<boolean> {
    const confirm = await this.askQuestion('🤔 Do you want to proceed with this configuration? (y/n): ');
    return confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes';
  }

  private async distributeSolToWallets(config: BotConfig): Promise<void> {
    console.log('\n🔄 Step 1: Distributing SOL to wallets...');
    console.log('==========================================');

    try {
      // Check main wallet balance first
      const mainBalance = await solanaConnection.getBalance(mainKp.publicKey);
      const mainBalanceSol = mainBalance / 1e9;
      
      console.log(`💰 Main wallet balance: ${mainBalanceSol.toFixed(6)} SOL`);
      
      if (mainBalanceSol < config.minSol * config.distributionNum) {
        throw new Error(`Insufficient balance. Need at least ${config.minSol * config.distributionNum} SOL`);
      }

      // Distribute SOL
      console.log('🔍 Testing distributeSol function...');
      try {
        // Create a simple mock wallet for testing
        const mockWallets = [];
        for (let i = 0; i < config.distributionNum; i++) {
          const kp = Keypair.generate();
          mockWallets.push({
            kp: kp,
            buyAmount: config.minSol
          });
        }
        
        // Save mock wallets to file
        const walletData: Data[] = mockWallets.map(wallet => ({
          pubkey: wallet.kp.publicKey.toBase58(),
          privateKey: base58.encode(wallet.kp.secretKey)
        }));
        
        saveDataToFile(walletData, "wallet.json");
        
        console.log(`✅ Successfully created ${mockWallets.length} mock wallets`);
        console.log(`📁 Wallet data saved to wallet.json\n`);
        console.log('⚠️  Note: These are mock wallets for testing. Use Wallet Manager to distribute real SOL.\n');
        
      } catch (distributeError) {
        console.error('❌ Error creating mock wallets:', distributeError);
        console.log('💡 This might be due to file system issues');
        throw distributeError;
      }

    } catch (error) {
      console.error('❌ Error distributing SOL:', error);
      throw error;
    }
  }

  private splitWalletsIntoGroups(): WalletSplit {
    console.log('\n🔄 Step 2: Splitting wallets into bot groups...');
    console.log('===============================================');

    const allWallets = readJson("wallet.json");
    const totalWallets = allWallets.length;

    console.log(`📊 Total wallets: ${totalWallets}`);

    // Calculate split sizes
    const volumeBotCount = Math.floor(totalWallets * 0.20); // 20%
    const marketMakerCount = Math.floor(totalWallets * 0.30); // 30%
    const bigTradeCount = totalWallets - volumeBotCount - marketMakerCount; // 50%

    console.log(`📈 Volume Bot wallets: ${volumeBotCount} (20%)`);
    console.log(`🤖 Market Maker wallets: ${marketMakerCount} (30%)`);
    console.log(`📊 Big Trade wallets: ${bigTradeCount} (50%)\n`);

    // Split wallets
    const volumeBotWallets = allWallets.slice(0, volumeBotCount);
    const marketMakerWallets = allWallets.slice(volumeBotCount, volumeBotCount + marketMakerCount);
    const bigTradeWallets = allWallets.slice(volumeBotCount + marketMakerCount);

    return {
      volumeBotWallets,
      marketMakerWallets,
      bigTradeWallets
    };
  }

  private async runMainBot(walletSplit: WalletSplit, config: BotConfig): Promise<void> {
    console.log('\n🚀 Step 3: Starting main bot operations...');
    console.log('==========================================');

    const baseMintPubkey = new PublicKey(config.baseMintAddress);

    // Start all bots in parallel
    const botPromises = [
      // Volume Bot (20% of wallets)
      runVolumeBot(walletSplit.volumeBotWallets, baseMintPubkey, config.totalTimeMinutes)
        .then(() => console.log('✅ Volume Bot completed'))
        .catch(err => console.error('❌ Volume Bot error:', err)),

      // Market Maker Bot (30% of wallets)
      runMarketMakerBot(walletSplit.marketMakerWallets, baseMintPubkey, config.totalTimeMinutes)
        .then(() => console.log('✅ Market Maker Bot completed'))
        .catch(err => console.error('❌ Market Maker Bot error:', err)),

      // Big Trade Bot (50% of wallets)
      runBigTradeBot(walletSplit.bigTradeWallets, baseMintPubkey, config.totalTimeMinutes)
        .then(() => console.log('✅ Big Trade Bot completed'))
        .catch(err => console.error('❌ Big Trade Bot error:', err))
    ];

    console.log('🎯 All bots started successfully!');
    console.log('⏰ Running for', config.totalTimeMinutes, 'minutes...\n');

    // Wait for all bots to complete
    await Promise.allSettled(botPromises);

    console.log('\n🎉 All bot operations completed!');
  }

  public async run(): Promise<void> {
    try {
      await this.showMainMenu();
    } catch (error) {
      console.error('❌ Fatal error:', error);
      console.log('🔄 Press Ctrl+C to exit or restart the application.\n');
      // Don't exit immediately, let user see the error
      await new Promise(resolve => setTimeout(resolve, 5000));
    } finally {
      this.rl.close();
    }
  }


  private async showMainMenu(): Promise<void> {
    const title = `
██╗   ██╗ ██████╗ ██╗     ██╗   ██╗███╗   ███╗███████╗    ███╗   ███╗ █████╗ ██████╗ ██╗  ██╗███████╗████████╗
██║   ██║██╔═══██╗██║     ██║   ██║████╗ ████║██╔════╝    ████╗ ████║██╔══██╗██╔══██╗██║ ██╔╝██╔════╝╚══██╔══╝
██║   ██║██║   ██║██║     ██║   ██║██╔████╔██║█████╗      ██╔████╔██║███████║██████╔╝█████╔╝ █████╗     ██║   
╚██╗ ██╔╝██║   ██║██║     ██║   ██║██║╚██╔╝██║██╔══╝      ██║╚██╔╝██║██╔══██║██╔══██╗██╔═██╗ ██╔══╝     ██║   
 ╚████╔╝ ╚██████╔╝███████╗╚██████╔╝██║ ╚═╝ ██║███████╗    ██║ ╚═╝ ██║██║  ██║██║  ██║██║  ██╗███████╗   ██║   
  ╚═══╝   ╚═════╝ ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝    ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝   ╚═╝   
                                                                                                        
  ███╗   ███╗ █████╗ ██╗  ██╗███████╗██████╗ ╗   ██████╗   ██████╗ ████████╗
  ████╗ ████║██╔══██╗██║ ██╔╝██╔════╝██╔══██╗╝    ██╔══██╗██╔═══██╗╚══██╔══╝
  ██╔████╔██║███████║█████╔╝ █████╗  ██████╔╝     ██████╔╝██║   ██║   ██║   
  ██║╚██╔╝██║██╔══██║██╔═██╗ ██╔══╝  ██╔══██╗     ██╔══██╗██║   ██║   ██║   
  ██║ ╚═╝ ██║██║  ██║██║  ██╗███████╗██║  ██║     ██████╔╝╚██████╔╝   ██║   
  ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝     ╚═════╝  ╚═════╝    ╚═╝   
  `;
    
    console.log(title);
    console.log('================================================\n');
    await this.initializeConfig()
    while (true) {
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an action:',
          choices: [
            { name: '💼 Wallet Manager', value: 'wallet-manager' },
            { name: '🤖 Market Maker Mode', value: 'market-maker' },
            { name: '💰 Sell Mode', value: 'sell-mode' },
            { name: '❌ Exit', value: 'exit' }
          ]
        }
      ]);

      switch (action) {
        case 'wallet-manager':
          await this.walletManager();
          break;
        case 'market-maker':
          await this.marketMakerMode();
          break;
        case 'sell-mode':
          await this.sellMode();
          break;
        case 'exit':
          console.log('Bot finished!');
          return;
      }
    }
  }

  // Wallet Manager Methods
  private async walletManager(): Promise<void> {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '💼 Wallet Manager - What would you like to do?',
        choices: [
          { name: '🔄 Generate Wallets + Distribute SOL', value: 'generate-mixer' },
          { name: '👀 View Wallets (Check Balance & Tokens)', value: 'view-wallets' },
          { name: '💰 Sell Tokens', value: 'sell-tokens' },
          { name: '💸 Collect SOL', value: 'collect-sol' },
          { name: '🔄 Transfer All Tokens to 1 Wallet & Sell', value: 'transfer-sell-collect' },
          { name: '🔙 Back to Main Menu', value: 'back' }
        ]
      }
    ]);

    switch (action) {
      case 'generate-mixer':
        await this.generateWalletsMixer();
        break;
      case 'view-wallets':
        await this.viewWallets();
        break;
      case 'sell-tokens':
        await this.sellTokens();
        break;
      case 'collect-sol':
        await this.collectSOL();
        break;
      case 'transfer-sell-collect':
        await this.transferSellCollect();
        break;
      case 'back':
        return;
    }
  }

  private async generateWalletsMixer(): Promise<void> {
    console.log('\n🔄 Generate Wallets + Distribute SOL');
    console.log('=====================================\n');

    // const { distributionNum } = await inquirer.prompt([
    //   {
    //     type: 'number',
    //     name: 'distributionNum',
    //     message: 'How many wallets to generate and distribute SOL to?',
    //     default: 100,
    //     validate: (input: number) => input > 0 ? true : 'Must be greater than 0'
    //   }
    // ]);

    // const { minSol } = await inquirer.prompt([
    //   {
    //     type: 'number',
    //     name: 'minSol',
    //     message: 'Minimum SOL per wallet?',
    //     default: 0.01,
    //     validate: (input: number) => input > 0 ? true : 'Must be greater than 0'
    //   }
    // ]);

    let distributionNum = this.config?.distributionNum || 10
    let minSol = this.config?.minSol || 0.1

    console.log(`\n🚀 Generating ${distributionNum} wallets and distributing SOL...`);
    console.log(`💰 Minimum SOL per wallet: ${minSol} SOL`);

    try {
      // Check main wallet balance first
      const mainBalance = await solanaConnection.getBalance(mainKp.publicKey);
      const mainBalanceSol = mainBalance / 1e9;
      
      console.log(`💰 Main wallet balance: ${mainBalanceSol.toFixed(6)} SOL`);
      
      if (mainBalanceSol < minSol * distributionNum) {
        console.log(`❌ Insufficient balance. Need at least ${minSol * distributionNum} SOL`);
        return;
      }

      // Call distributeSol function
      const wallets = await distributeSol(solanaConnection, mainKp, distributionNum, this.config?.minSol || MIN_SOL);
      
      if (!wallets || wallets.length === 0) {
        console.log('❌ Failed to distribute SOL to wallets');
        return;
      }

      console.log(`✅ Successfully distributed SOL to ${wallets.length} wallets`);
      console.log(`📁 Wallet data saved to wallet.json`);
      console.log('\n💡 Wallets are ready for bot operations!');

    } catch (error) {
      console.error('❌ Error generating wallets and distributing SOL:', error);
    }
  }

  private async viewWallets(): Promise<void> {
    console.log("\n📂 View Wallets");
    console.log("================\n");
  
    try {
      const wallets = readJson("wallet.json");
  
      if (!wallets || wallets.length === 0) {
        console.log("❌ No wallets found in wallet.json");
        return;
      }
  
      console.log(`📊 Found ${wallets.length} wallets\n`);
      console.log("Loading wallet balances...\n");
  
      let totalSolBalance = 0;
      let totalTokenBalance = 0;
      let walletsWithTokens = 0;
  
      for (let i = 0; i < wallets.length; i++) {
        const { privateKey, pubkey } = wallets[i];
  
        try {
          // Reconstruct wallet from private key
          const walletKp = Keypair.fromSecretKey(bs58.decode(privateKey));
  
          // --- Get SOL balance ---
          const solBalanceLamports = await solanaConnection.getBalance(walletKp.publicKey);
          const solBalance = solBalanceLamports / 1e9;
          totalSolBalance += solBalance;
  
          // --- Get token balance (if TOKEN_MINT provided) ---
          let tokenBalance = 0;
          if (this.baseMint) {
            try {
              const ata = await getAssociatedTokenAddress(new PublicKey(this.baseMint), walletKp.publicKey);
              const accountInfo = await getAccount(solanaConnection, ata);
              tokenBalance = Number(accountInfo.amount);
              if (tokenBalance > 0) walletsWithTokens++;
              totalTokenBalance += tokenBalance;
            } catch {
              // No token account found — skip
            }
          }
  
          // --- Print wallet info ---
          console.log(`Wallet #${i + 1}`);
          console.log(`🪪 Pubkey: ${pubkey}`);
          console.log(`💰 SOL Balance: ${solBalance.toFixed(6)} SOL`);
          console.log(`🪙 Token Balance: ${tokenBalance}`);
          console.log("-------------------------------");
  
          // Progress every 10 wallets
          if ((i + 1) % 10 === 0 || i === wallets.length - 1) {
            console.log(`📊 Processed ${i + 1}/${wallets.length} wallets...\n`);
          }
  
        } catch (err) {
          console.log(`⚠️  Error checking wallet ${wallets[i].pubkey}: ${err}`);
        }
      }
  
      // --- Summary ---
      console.log("\n📊 Wallet Summary");
      console.log("==================");
      console.log(`Total Wallets: ${wallets.length}`);
      console.log(`Total SOL Balance: ${totalSolBalance.toFixed(6)} SOL`);
      console.log(`Total Token Balance: ${totalTokenBalance.toFixed(2)} tokens`);
      console.log(`Wallets with Tokens: ${walletsWithTokens}`);
      console.log(`Average SOL per Wallet: ${(totalSolBalance / wallets.length).toFixed(6)} SOL\n`);
  
    } catch (error) {
      console.error("❌ Error viewing wallets:", error);
    }
  }

  private async sellTokens(): Promise<void> {
    console.log('\n💰 Sell Tokens');
    console.log('===============\n');

    try {
      const wallets = readJson("wallet.json");
      if (!wallets || wallets.length === 0) {
        console.log('❌ No wallets found in wallet.json');
        return;
      }

      const { sellPercent } = await inquirer.prompt([
        {
          type: 'number',
          name: 'sellPercent',
          message: 'What percentage to sell? (0-100)',
          default: 10,
          validate: (input: number) => input >= 0 && input <= 100 ? true : 'Must be between 0 and 100'
        }
      ]);

      const { timeInterval } = await inquirer.prompt([
        {
          type: 'number',
          name: 'timeInterval',
          message: 'Time interval between sales (minutes)',
          default: 1,
          validate: (input: number) => input > 0 ? true : 'Must be greater than 0'
        }
      ]);

      console.log(`\n🚀 Starting sell process:`);
      console.log(`📊 Sell ${sellPercent}% of tokens`);
      console.log(`⏰ Every ${timeInterval} minute(s)`);
      console.log(`🔄 Rotating through ${wallets.length} wallets\n`);

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Proceed with selling?',
          default: true
        }
      ]);

      if (!confirm) {
        console.log('❌ Sell operation cancelled');
        return;
      }

      let bondingCurve = await this.getBondingCurve();
      if (!bondingCurve) {
        console.log("start pumpfun sell process")
        await this.startPumpfunSellProcess(wallets, sellPercent, timeInterval);
      } else {
        console.log("start pumpswap sell process")
        await this.startPumpswapSellProcess(wallets, sellPercent, timeInterval);
      }
      // Start selling process

    } catch (error) {
      console.error('❌ Error in sell tokens:', error);
    }
  }

  private async startPumpfunSellProcess(
    wallets: WalletInfo[],
    sellPercent: number,
    timeIntervalMinutes: number
  ): Promise<void> {
    console.log('🔄 Starting rotating sell process...\n');
    console.log(`📊 Sell ${sellPercent}% every ${timeIntervalMinutes} minute(s)`);
    console.log(`🔄 Checking ${wallets.length} wallets for token balance\n`);
  
    // Filter wallets that have tokens and create sell available list
    const sellAvailableWallets: WalletInfo[] = [];
    for (const wallet of wallets) {
      try {
        const walletKp = Keypair.fromSecretKey(base58.decode(wallet.privateKey));
        const tokenAta = await getAssociatedTokenAddress(this.baseMint, walletKp.publicKey);
        const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta);
  
        if (tokenBalInfo && parseInt(tokenBalInfo.value.amount) > 0) {
          sellAvailableWallets.push(wallet);
        }
      } catch (err) {
        console.error(`⚠️ Error checking wallet ${wallet.pubkey}:`, err);
      }
    }
  
    console.log(`✅ Sell available wallets: ${sellAvailableWallets.length}\n`);
  
    let startIndex = 0;
    let cycleCount = 0;
  
    while (true) {
      cycleCount++;
      console.log(`\n🔄 Cycle ${cycleCount} starting...`);
  
      // Number of wallets to sell in this cycle (1, 2, 3, ...)
      const walletsToSellCount = Math.min(cycleCount, sellAvailableWallets.length - startIndex);
      if (walletsToSellCount <= 0) {
        console.log('🔄 Reached end of sell list, restarting from beginning...');
        startIndex = 0;
        cycleCount = 1;
        continue;
      }
  
      // Slice the wallets for this cycle
      const cycleWallets = sellAvailableWallets.slice(startIndex, startIndex + walletsToSellCount);
  
      for (let i = 0; i < cycleWallets.length; i++) {
        const wallet = cycleWallets[i];
        const walletIndex = sellAvailableWallets.findIndex(w => w.pubkey === wallet.pubkey) + 1;
  
        try {
          console.log(`💰 Wallet ${walletIndex}/${sellAvailableWallets.length}: ${wallet.pubkey}`);
  
          const walletKp = Keypair.fromSecretKey(base58.decode(wallet.privateKey));
          const tokenAta = await getAssociatedTokenAddress(this.baseMint, walletKp.publicKey);
          const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta);
  
          if (!tokenBalInfo || parseInt(tokenBalInfo.value.amount) === 0) {
            console.log(`⚠️ Wallet ${walletIndex} has no tokens, skipping`);
            continue;
          }
  
          const totalTokens = parseInt(tokenBalInfo.value.amount);
          const sellAmount = Math.floor(totalTokens * (sellPercent / 100));
  
          if (sellAmount <= 0) {
            console.log(`⚠️ Wallet ${walletIndex} sell amount too small (${sellAmount})`);
            continue;
          }
  
          console.log(`📊 Selling ${sellAmount} tokens (${sellPercent}%) from wallet ${walletIndex}`);
  
          // Execute sell
          const result = await sell(this.baseMint, walletKp, sellAmount);
  
          if (result) {
            console.log(`✅ Successfully sold from wallet ${walletIndex}`);
            console.log(`🔗 Transaction: ${result}`);
          } else {
            console.log(`❌ Failed to sell from wallet ${walletIndex}`);
          }
        } catch (err) {
          console.error(`❌ Error selling from wallet ${wallet.pubkey}:`, err);
        }
  
        // Sleep 600–900ms between wallet transactions
        const transactionDelay = 600 + Math.floor(Math.random() * 300);
        await this.sleep(transactionDelay);
      }
  
      // Move startIndex forward
      startIndex += walletsToSellCount;
  
      // Sleep full interval between cycles (minutes)
      console.log(`⏰ Waiting ${timeIntervalMinutes} minute(s) before next cycle...\n`);
      await this.sleep(timeIntervalMinutes * 60 * 1000);
    }
  }

  private async startPumpswapSellProcess(wallets: WalletInfo[], sellPercent: number, timeIntervalMinutes: number): Promise<void> {
    console.log('🔄 Starting cycling sell process...\n');
    console.log(`📊 Sell ${sellPercent}% every ${timeIntervalMinutes} minute(s)`);
    console.log(`🔄 Cycling through ${wallets.length} wallets\n`);

    let cycleCount = 0;
    let totalSales = 0;

    while (true) {
      cycleCount++;
      
      // Calculate how many wallets to sell in this cycle (1, 2, 3, etc.)
      const walletsToSellThisCycle = Math.min(cycleCount, wallets.length);
      
      console.log(`\n🔄 Cycle ${cycleCount}: Selling from ${walletsToSellThisCycle} random wallet(s)`);
      console.log('='.repeat(50));

      // Randomly select wallets for this cycle
      const selectedWallets = this.selectRandomWallets(wallets, walletsToSellThisCycle);

      // Sell from each selected wallet
      for (let i = 0; i < selectedWallets.length; i++) {
        const wallet = selectedWallets[i];
        const walletIndex = wallets.findIndex(w => w.pubkey === wallet.pubkey) + 1;
        
        try {
          console.log(`💰 Wallet ${walletIndex}/${wallets.length}: ${wallet.pubkey}`);
          console.log(`📊 Selling ${sellPercent}% of tokens...`);

          // Convert wallet info to Keypair
          const walletKp = Keypair.fromSecretKey(base58.decode(wallet.privateKey));
          
          // Get token balance and calculate sell amount
          const tokenAta = await getAssociatedTokenAddress(this.baseMint, walletKp.publicKey);
          const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta);
          
          if (!tokenBalInfo || tokenBalInfo.value.amount === '0') {
            console.log(`⚠️  Wallet ${walletIndex} has no tokens to sell`);
            continue;
          }
          
          const totalTokens = parseInt(tokenBalInfo.value.amount);
          const sellAmount = Math.floor(totalTokens * (sellPercent / 100));
          
          if (sellAmount <= 0) {
            console.log(`⚠️  Wallet ${walletIndex} sell amount too small (${sellAmount} tokens)`);
            continue;
          }
          
          console.log(`📊 Total tokens: ${totalTokens}, Selling: ${sellAmount} tokens (${sellPercent}%)`);
          
          // Call the actual sell function
          const result = await sellPumpswap(this.baseMint, walletKp, sellPercent);
          
          if (result) {
            console.log(`✅ Successfully sold ${sellPercent}% from wallet ${walletIndex}`);
            console.log(`🔗 Transaction: ${result}`);
            totalSales++;
          } else {
            console.log(`❌ Failed to sell from wallet ${walletIndex}`);
          }

        } catch (error) {
          console.error(`❌ Error selling from wallet ${wallet.pubkey}:`, error);
        }

        // Small delay between wallets in the same cycle
        if (i < selectedWallets.length - 1) {
          await this.sleep(2000); // 2 seconds between wallets
        }
      }

      console.log(`\n📊 Cycle ${cycleCount} complete. Total sales: ${totalSales}`);
      console.log(`⏰ Waiting ${timeIntervalMinutes} minute(s) before next cycle...\n`);
      
      // Wait for the specified time interval before next cycle
      await this.sleep(timeIntervalMinutes * 60 * 1000);
    }
  }

  private async collectSOL(): Promise<void> {
    console.log('\n💸 Collect SOL');
    console.log('===============\n');

    try {
      const wallets = readJson("wallet.json");
      if (!wallets || wallets.length === 0) {
        console.log('❌ No wallets found in wallet.json');
        return;
      }

      console.log(`📊 Found ${wallets.length} wallets to collect from\n`);

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Collect all SOL from wallets?',
          default: true
        }
      ]);

      if (!confirm) {
        console.log('❌ Collection cancelled');
        return;
      }

      console.log('🔄 Starting SOL collection...\n');

      // Use the gather function from gather.ts
      console.log('🔄 Running gather process...');
      // Note: The gather.ts file needs to be modified to accept a parameter
      // For now, we'll use the existing gather functionality
      try {
        await gather()
        console.log('✅ Gather process completed');
      } catch (err) {

        console.log('❌ Gather process failed');
      }
      
    } catch (error) {
      console.error('❌ Error collecting SOL:', error);
    }
  }

  private async transferSellCollect(): Promise<void> {
    console.log('\n🔄 Transfer All Tokens to 1 Wallet & Sell');
    console.log('==========================================\n');

    try {
      const wallets = readJson("wallet.json");
      if (!wallets || wallets.length === 0) {
        console.log('❌ No wallets found in wallet.json');
        return;
      }

      console.log(`📊 Found ${wallets.length} wallets\n`);

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Transfer all tokens to main wallet, sell them, and collect SOL?',
          default: true
        }
      ]);

      if (!confirm) {
        console.log('❌ Operation cancelled');
        return;
      }

      console.log('🔄 Starting transfer and sell process...\n');

      // Step 1: Transfer all tokens to main wallet
      console.log('📤 Step 1: Transferring all tokens to main wallet...');
      await this.transferAllTokensToMainWallet(wallets);

      // Step 2: Sell all tokens from main wallet
      console.log('💰 Step 2: Selling all tokens from main wallet...');
      await this.sellAllTokensFromMainWallet();

      // Step 3: Collect SOL
      console.log('💸 Step 3: Collecting SOL...');
      await this.collectSOL();

      console.log('✅ Transfer, sell, and collect process completed!\n');

    } catch (error) {
      console.error('❌ Error in transfer-sell-collect:', error);
    }
  }

  private async transferAllTokensToMainWallet(wallets: WalletInfo[]): Promise<void> {
    console.log('🔄 Starting token transfer process...\n');

    let totalTransferred = 0;
    let successfulTransfers = 0;

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      const walletKp = Keypair.fromSecretKey(base58.decode(wallet.privateKey));
      
      try {
        console.log(`📤 Processing wallet ${i + 1}/${wallets.length}: ${wallet.pubkey}`);

        // Get all token accounts for this wallet
        const tokenAccounts = await solanaConnection.getTokenAccountsByOwner(
          walletKp.publicKey,
          { programId: TOKEN_PROGRAM_ID },
          'confirmed'
        );

        if (tokenAccounts.value.length === 0) {
          console.log(`⚠️  Wallet ${i + 1} has no token accounts`);
          continue;
        }

        const instructions = [];
        let hasTokensToTransfer = false;

        // Process each token account
        for (const { pubkey: tokenAccount, account } of tokenAccounts.value) {
          try {
            // Decode token account data
            const tokenAccountData = account.data;
            const mint = new PublicKey(tokenAccountData.slice(0, 32));
            const amount = new BN(tokenAccountData.slice(64, 72), 'le');
            
            // Skip if no tokens
            if (amount.isZero()) {
              continue;
            }

            // Check if this is our target token
            if (!mint.equals(this.baseMint)) {
              continue;
            }

            console.log(`📊 Found ${amount.toString()} tokens of ${mint.toBase58()}`);

            // Get source and destination token accounts
            const sourceTokenAccount = tokenAccount;
            const destinationTokenAccount = await getAssociatedTokenAddress(this.baseMint, mainKp.publicKey);

            // Create destination token account if it doesn't exist
            instructions.push(
              createAssociatedTokenAccountIdempotentInstruction(
                mainKp.publicKey,
                destinationTokenAccount,
                mainKp.publicKey,
                this.baseMint
              )
            );

            // Create transfer instruction
            instructions.push(
              createTransferCheckedInstruction(
                sourceTokenAccount,
                this.baseMint,
                destinationTokenAccount,
                walletKp.publicKey,
                BigInt(amount.toString()),
                6 // Assuming 6 decimals for most tokens
              )
            );

            hasTokensToTransfer = true;
            totalTransferred += amount.toNumber();

          } catch (tokenError) {
            console.log(`⚠️  Error processing token account: ${tokenError}`);
          }
        }

        // Execute transaction if there are tokens to transfer
        if (hasTokensToTransfer && instructions.length > 0) {
          const transaction = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
            ...instructions
          );

          transaction.feePayer = mainKp.publicKey;
          transaction.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash;

          // Simulate transaction first
          const simResult = await solanaConnection.simulateTransaction(transaction);
          if (simResult.value.err) {
            console.log(`❌ Transaction simulation failed for wallet ${i + 1}`);
            continue;
          }

          // Execute transaction
          const signature = await sendAndConfirmTransaction(
            solanaConnection, 
            transaction, 
            [mainKp, walletKp], 
            { commitment: 'confirmed' }
          );

          console.log(`✅ Transferred tokens from wallet ${i + 1}: https://solscan.io/tx/${signature}`);
          successfulTransfers++;

        } else {
          console.log(`⚠️  Wallet ${i + 1} has no tokens to transfer`);
        }

        // Small delay between wallets
        await this.sleep(1000);

      } catch (error) {
        console.error(`❌ Error transferring from wallet ${wallet.pubkey}:`, error);
      }
    }

    console.log(`\n📊 Transfer Summary:`);
    console.log(`✅ Successful transfers: ${successfulTransfers}/${wallets.length}`);
    console.log(`💰 Total tokens transferred: ${totalTransferred.toLocaleString()}\n`);
  }

  private async sellAllTokensFromMainWallet(): Promise<void> {
    console.log('💰 Selling all tokens from main wallet...\n');

    try {
      // Get token balance from main wallet
      const tokenAta = await getAssociatedTokenAddress(this.baseMint, mainKp.publicKey);
      const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta);

      if (!tokenBalInfo || tokenBalInfo.value.amount === '0') {
        console.log('⚠️  Main wallet has no tokens to sell');
        return;
      }

      const totalTokens = parseInt(tokenBalInfo.value.amount);
      console.log(`📊 Main wallet token balance: ${totalTokens.toLocaleString()} tokens`);

      // Sell all tokens (100%)
      const result = await sell(this.baseMint, mainKp);

      if (result) {
        console.log(`✅ Successfully sold all tokens from main wallet`);
        console.log(`🔗 Transaction: ${result}`);
      } else {
        console.log(`❌ Failed to sell tokens from main wallet`);
      }

    } catch (error) {
      console.error('❌ Error selling tokens from main wallet:', error);
    }
  }

  // Market Maker Mode
  private async marketMakerMode(): Promise<void> {
    console.log('\n🤖 Market Maker Mode');
    console.log('====================\n');

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: '🚀 Start Bot', value: 'start-bot' },
          // { name: '⚙️  Configure Bot', value: 'configure' },
          // { name: '📊 View Bot Status', value: 'status' },
          { name: '🔙 Back to Main Menu', value: 'back' }
        ]
      }
    ]);

      switch (action) {
        case 'start-bot':
          await this.startMarketMakerBot();
          break;
        // case 'configure':
        //   await this.configureMarketMakerBot();
        //   break;
        case 'back':
          return;
      }
  }

  private async startMarketMakerBot(): Promise<void> {
    console.log('\n🚀 Starting Market Maker Bot...\n');

    try {
      // Check if config is initialized
      console.log("🚀 ~ PumpfunCLIBot ~ startMarketMakerBot ~ this.config:", this.config)
      if (!this.config) {
        console.log('❌ Bot configuration not initialized. Please configure bot first.');
        return;
      }

      // Split wallets into groups
      const walletSplit = this.splitWalletsIntoGroups();

      // Run main bot with the configuration
      await this.runMainBot(walletSplit, this.config);

      console.log('✅ Market Maker Bot completed!\n');

    } catch (error) {
      console.error('❌ Error starting Market Maker Bot:', error);
    }
  }

  private async configureMarketMakerBot(): Promise<void> {
    console.log('\n⚙️  Configure Market Maker Bot');
    console.log('===============================\n');

    try {
      if (this.config) {
        console.log('✅ Bot is already configured!');
        console.log(`📊 Distribution wallets: ${this.config.distributionNum}`);
        console.log(`🪙 Token mint: ${this.config.baseMintAddress}`);
        console.log(`⏰ Runtime: ${this.config.totalTimeMinutes} minutes`);
        console.log(`💰 Min SOL per wallet: ${this.config.minSol} SOL\n`);
        
        const { reconfigure } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'reconfigure',
            message: 'Do you want to reconfigure the bot?',
            default: false
          }
        ]);

        if (!reconfigure) {
          console.log('✅ Using existing configuration.\n');
          return;
        }
      }

      console.log('🔄 Starting configuration process...\n');

      try {
        // Initialize configuration
        console.log('📝 Step 1: Getting configuration parameters...');
        this.config = await this.initializeConfig();
        console.log('✅ Configuration parameters received');
        
        console.log('📝 Step 2: Confirming configuration...');
        if (!(await this.confirmExecution())) {
          console.log('❌ Configuration cancelled by user.');
          return;
        }
        console.log('✅ Configuration confirmed');

        console.log('📝 Step 3: Distributing SOL to wallets...');
        
        try {
          await this.distributeSolToWallets(this.config);
          console.log('✅ SOL distribution completed');
        } catch (distributeError) {
          console.error('❌ Error in SOL distribution:', distributeError);
          console.log('⚠️  Configuration saved but SOL distribution failed');
          console.log('💡 You can try distributing SOL later from Wallet Manager\n');
          // Don't throw error, just continue with configuration
        }

        console.log('✅ Market Maker Bot configuration completed!\n');
        console.log('💡 You can now start the bot from the Market Maker Mode menu.\n');

      } catch (configError) {
        console.error('❌ Error during configuration process:', configError);
        console.log('🔄 Returning to main menu...\n');
        throw configError; // Re-throw to be caught by outer try-catch
      }

    } catch (error) {
      console.error('❌ Error configuring Market Maker Bot:', error);
      console.log('🔄 Returning to main menu...\n');
    }
  }

  private async getBondingCurve(): Promise<any> {
    try {
      console.log("get bonding curve")
      const bonding  = await getBondingCurveAccount(this.baseMint);
      const isBondingCurve = bonding?.complete
      return isBondingCurve;
    } catch (err) {
      console.log("get bonding")
    }
  }


  // Sell Mode
  private async sellMode(): Promise<void> {
    console.log('\n💰 Sell Mode');
    console.log('=============\n');

    try {
      const wallets = readJson("wallet.json");
      if (!wallets || wallets.length === 0) {
        console.log('❌ No wallets found in wallet.json');
        return;
      }

      const { sellPercent } = await inquirer.prompt([
        {
          type: 'number',
          name: 'sellPercent',
          message: 'What percentage to sell? (0-100)',
          default: 1,
          validate: (input: number) => input >= 0 && input <= 100 ? true : 'Must be between 0 and 100'
        }
      ]);

      const { timeInterval } = await inquirer.prompt([
        {
          type: 'number',
          name: 'timeInterval',
          message: 'Time interval between sales (minutes)',
          default: 1,
          validate: (input: number) => input > 0 ? true : 'Must be greater than 0'
        }
      ]);

      console.log(`\n🚀 Starting sell process:`);
      console.log(`📊 Sell ${sellPercent}% of tokens`);
      console.log(`⏰ Every ${timeInterval} minute(s)`);
      console.log(`🔄 Rotating through ${wallets.length} wallets\n`);

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Proceed with selling?',
          default: true
        }
      ]);

      if (!confirm) {
        console.log('❌ Sell operation cancelled');
        return;
      }

      let bondingCurve = await this.getBondingCurve();
      if (!bondingCurve) {
        console.log("start pumpfun sell process")
        await this.startPumpfunSellProcess(wallets, sellPercent, timeInterval);
      } else {
        console.log("start pumpswap sell process")
        await this.startPumpswapSellProcess(wallets, sellPercent, timeInterval);
      }

      // Start selling process

    } catch (error) {
      console.error('❌ Error in sell mode:', error);
    }
  }


  // Utility Methods
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private selectRandomWallets(wallets: WalletInfo[], count: number): WalletInfo[] {
    const selectedWallets: WalletInfo[] = [];
    const availableWallets = [...wallets]; // Clone the wallets array to avoid mutating the original

    for (let i = 0; i < count; i++) {
      const randomIndex = Math.floor(Math.random() * availableWallets.length);
      selectedWallets.push(availableWallets[randomIndex]);
      availableWallets.splice(randomIndex, 1); // Remove selected wallet from the available list
    }

    return selectedWallets;
  }
}

// Main execution
async function main() {
  const cliBot = new PumpfunCLIBot();
  await cliBot.run();
}

// Handle CLI arguments if provided
if (process.argv.length > 2) {
  console.log('📝 CLI Arguments detected. Use interactive mode for better experience.');
  console.log('💡 Run without arguments for interactive configuration.\n');
}

// Start the CLI bot
if (require.main === module) {
  main().catch(console.error);
}

export { PumpfunCLIBot, main };