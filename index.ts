import {
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction,
  Commitment
} from '@solana/web3.js'
import {
  BUY_INTERVAL_MAX,
  BUY_INTERVAL_MIN,
  SELL_INTERVAL_MAX,
  SELL_INTERVAL_MIN,
  BUY_LOWER_PERCENT,
  BUY_UPPER_PERCENT,
  DISTRIBUTE_WALLET_NUM,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  JITO_MODE,
  DISTRIBUTE_INTERVAL_MIN,
  DISTRIBUTE_INTERVAL_MAX,
  AIRDROP_ADDRESS,
  FEE_LEVEL,
  SOL_DECIMALS,
  FEE_BUFFER,
  MIN_SOL,
  MAX_SOL,
  Target_MINT,
} from './constants'
import { Data, getTokenPrice, readJson, saveDataToFile, saveNewFile, sleep } from './utils'
import base58 from 'bs58'
import { execute } from './executor/legacy'
import { executeJitoTx } from './executor/jito'
import { makeBuyPumpfunTokenTx, makeSellPumpfunTokenTx, makeSellPumpswapTokenTxMarketMaker } from './utils/pumpfun'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment: "confirmed"
})

export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const baseMint = new PublicKey(Target_MINT)
const jitoCommitment: Commitment = "confirmed"

const airdropAddress = new PublicKey(AIRDROP_ADDRESS || "")
let makerNum = 0

const totalProcesses: Set<string> = new Set()
const oneTimeBoughtProcesses: Set<string> = new Set()
const twoTimeBoughtProcesses: Set<string> = new Set()
const soldProcesses: Set<string> = new Set()
const successfulProcesses: Set<string> = new Set()

export const distributeSol = async (
  connection: Connection,
  mainKp: Keypair,
  distributionNum: number,
  minSol: number
) => {
  console.log("🚀 ~ distributeSol ~ distributionNum:", distributionNum);
  const data: Data[] = [];
  const wallets: { kp: Keypair; buyAmount: number }[] = [];

  try {
    const sendSolTx: TransactionInstruction[] = [];
    sendSolTx.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * FEE_LEVEL }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 12_000 })
    );

    // === 1. Main wallet balance ===
    const mainSolBal = await connection.getBalance(mainKp.publicKey);
    const mainSolBalSol = mainSolBal / SOL_DECIMALS;
    console.log("[VOLUME BOT] Main wallet", mainKp.publicKey.toBase58(), "balance:", mainSolBalSol, "SOL");

    if (mainSolBalSol <= 0) {
      console.log("[VOLUME BOT] Main wallet balance is not enough");
      return [];
    }

    // === 2. Prepare distribution ===
    const totalToDistribute = mainSolBalSol - FEE_BUFFER;

    if (totalToDistribute <= minSol * distributionNum) {
      console.log("[VOLUME BOT] ❌ Not enough balance to satisfy minimum per wallet");
      console.log(`[VOLUME BOT] Need at least ${(minSol * distributionNum + FEE_BUFFER).toFixed(6)} SOL`);
      return [];
    }

    console.log(`[VOLUME BOT] Total to distribute (after fee buffer): ${totalToDistribute.toFixed(6)} SOL`);

    // === 3. Randomized distribution ensuring min per wallet ===
    const solAmounts: number[] = Array(distributionNum).fill(minSol);
    let remaining = totalToDistribute - minSol * distributionNum;

    // Generate random weights and scale to remaining
    const randomWeights = Array.from({ length: distributionNum }, () => Math.random());
    const sumWeights = randomWeights.reduce((a, b) => a + b, 0);

    // Scale extras
    for (let i = 0; i < distributionNum; i++) {
      const extra = (randomWeights[i] / sumWeights) * remaining;
      solAmounts[i] = Number((solAmounts[i] + extra).toFixed(9));
    }

    // Fix rounding differences
    const totalDistributed = solAmounts.reduce((a, b) => a + b, 0);
    const diff = Number((totalToDistribute - totalDistributed).toFixed(9));
    solAmounts[0] = Number((solAmounts[0] + diff).toFixed(9));

    console.log("[VOLUME BOT] Final SOL distribution:", solAmounts);
    console.log("[VOLUME BOT] Total distributed:", solAmounts.reduce((a, b) => a + b, 0).toFixed(9));

    // === 4. Create wallets & transfer instructions ===
    for (let i = 0; i < distributionNum; i++) {
      const wallet = Keypair.generate();
      const lamports = Math.floor(solAmounts[i] * SOL_DECIMALS);

      wallets.push({ kp: wallet, buyAmount: solAmounts[i] });

      sendSolTx.push(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports,
        })
      );

      console.log(`[VOLUME BOT] Wallet ${wallet.publicKey.toBase58()} gets ${solAmounts[i].toFixed(6)} SOL`);
    }

    // === 5. Save wallet data ===
    wallets.forEach((wallet) => {
      data.push({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
      });
    });
    saveDataToFile(data);

    // === 6. Send transaction ===
    const latestBlockhash = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: sendSolTx,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([mainKp]);

    // Simulate transaction first
    const simulateResult = await connection.simulateTransaction(transaction, { sigVerify: true });
    if (simulateResult.value.err) {
      console.log("[VOLUME BOT] ❌ Simulation failed", simulateResult.value.err);
      return null;
    }

    // Send transaction
    let txSig;
    if (JITO_MODE) {
      txSig = await executeJitoTx([transaction], mainKp, jitoCommitment);
    } else {
      txSig = await execute(transaction, latestBlockhash, 1);
    }

    if (txSig) {
      console.log(`[VOLUME BOT] ✅ SOL distributed: https://solscan.io/tx/${txSig}`);
    }

    console.log("[VOLUME BOT] ✅ Success in distribution");

    await sleep(3000);
    await transferAllSolFromWallets();

    return wallets;
  } catch (error) {
    console.log("[VOLUME BOT] ❌ Failed to distribute SOL", error);
    return null;
  }
};

export const transferAllSolFromWallets = async () => {

  const walletsFromStep1 = await readJson();
  console.log(`[STEP 2] Starting second-round transfers for ${walletsFromStep1.length} wallets...`);

  const destinationWallets: { kp: Keypair; pubkey: string }[] = [];
  const results: { from: string; to: string; txSig?: string }[] = [];

  // 1. Generate destination wallets
  for (let i = 0; i < walletsFromStep1.length; i++) {
    const dest = Keypair.generate();
    destinationWallets.push({ kp: dest, pubkey: dest.publicKey.toBase58() });
  }

  // 2. Loop through each source wallet
  for (let i = 0; i < walletsFromStep1.length; i++) {
    const srcInfo = walletsFromStep1[i];
    const srcKp = Keypair.fromSecretKey(base58.decode(srcInfo.privateKey));
    const srcPubkey = srcKp.publicKey;
    const destKp = destinationWallets[i].kp;
    const destPubkey = destKp.publicKey;

    try {
      // Get wallet balance
      const balanceLamports = await solanaConnection.getBalance(srcPubkey);
      if (balanceLamports <= 0) {
        console.log(`[SKIP] Wallet ${srcPubkey.toBase58()} has no SOL to send.`);
        continue;
      }

      // --- Step 1: Estimate fee ---
      let dummyTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: srcPubkey,
          toPubkey: destPubkey,
          lamports: 1, // dummy
        })
      );
      dummyTx.feePayer = srcPubkey;
      const { blockhash } = await solanaConnection.getLatestBlockhash();
      dummyTx.recentBlockhash = blockhash;

      const feeCalc = await solanaConnection.getFeeForMessage(dummyTx.compileMessage());
      const feeLamports = feeCalc.value ?? 5000;

      // --- Step 2: Calculate max transferable lamports ---
      const lamportsToSend = balanceLamports - feeLamports;
      if (lamportsToSend <= 0) {
        console.log(`[SKIP] Wallet ${srcPubkey.toBase58()} does not have enough SOL to cover fees.`);
        continue;
      }

      // --- Step 3: Build real transaction ---
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: srcPubkey,
          toPubkey: destPubkey,
          lamports: lamportsToSend,
        })
      );
      tx.feePayer = srcPubkey;
      tx.recentBlockhash = blockhash;

      // --- Step 4: Sign and send ---
      const txSig = await sendAndConfirmTransaction(solanaConnection, tx, [srcKp], {
        commitment: "confirmed",
      });

      console.log(
        `[STEP 2] ✅ Transferred ${(lamportsToSend / SOL_DECIMALS).toFixed(6)} SOL from ${srcPubkey.toBase58()} → ${destPubkey.toBase58()}`
      );

      // --- Step 5: Confirm “closure” (wallet empty) ---
      const newBal = await solanaConnection.getBalance(srcPubkey);
      if (newBal === 0) {
        console.log(`[CLOSED] 🗑 Wallet ${srcPubkey.toBase58()} successfully drained (closed).`);
      } else {
        console.log(`[WARN] Wallet ${srcPubkey.toBase58()} still has ${newBal / SOL_DECIMALS} SOL`);
      }

      results.push({ from: srcPubkey.toBase58(), to: destPubkey.toBase58(), txSig });
    } catch (err) {
      console.log(`[STEP 2] ❌ Error sending from ${srcInfo.pubkey}`);
      console.error(err);
    }
  }

  // 3. Save new destination wallets
  const data = destinationWallets.map((wallet) => ({
    privateKey: base58.encode(wallet.kp.secretKey),
    pubkey: wallet.kp.publicKey.toBase58(),
  }));

  try {
    saveDataToFile(data, "wallet.json");
  } catch (error) {
    console.log("[VOLUME BOT] DistributeSol tx error", error);
  }

  console.log(`[STEP 2] ✅ Finished transferring and closing all wallets.`);
  return { destinationWallets, results };
};

export const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number) => {
  let solBalance: number = 0
  try {
    solBalance = await solanaConnection.getBalance(newWallet.publicKey)
  } catch (error) {
    console.log("Error getting balance of wallet")
    return null
  }
  if (solBalance == 0) {
    return null
  }
  try {
    // let buyTx = await getBuyTxWithJupiter(newWallet, baseMint, buyAmount)
    // let buyTx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, POOL_ID)
    let buyTx = await makeBuyPumpfunTokenTx(newWallet, baseMint, buyAmount)
    if (buyTx == null) {
      console.log(`Error getting buy transaction`)
      return null
    }
    // console.log(await solanaConnection.simulateTransaction(buyTx))
    let txSig
    if (JITO_MODE) {
      txSig = await executeJitoTx([buyTx], mainKp, jitoCommitment)
    } else {
      const latestBlockhash = await solanaConnection.getLatestBlockhash()
      txSig = await execute(buyTx, latestBlockhash, 1)
    }
    if (txSig) {
      const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
      console.log("Success in buy transaction: ", tokenBuyTx)
      return tokenBuyTx
    } else {
      return null
    }
  } catch (error) {
    console.log("Buy transaction error", error)
    await sleep(1000)
    return null
  }
}

export const sell = async (baseMint: PublicKey, wallet: Keypair, sellAmount?: number) => {
  try {
    const data: Data[] = readJson()
    if (data.length == 0) {
      await sleep(1000)
      return null
    }

    const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
    const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
    if (!tokenBalInfo) {
      console.log("Balance incorrect")
      return null
    }
    const tokenBalance = tokenBalInfo.value.amount

    let amount = sellAmount ? sellAmount : tokenBalance

    try {
      // let sellTx = await getSellTxWithJupiter(wallet, baseMint, tokenBalance)
      // let sellTx = await getSellTx(solanaConnection, wallet, baseMint, NATIVE_MINT, POOL_ID, undefined)
      let sellTx = await (makeSellPumpfunTokenTx as any)(wallet, baseMint, sellAmount)

      if (sellTx == null) {
        console.log(`Error getting buy transaction`)
        return null
      }

      // console.log(await solanaConnection.simulateTransaction(sellTx))
      let txSig
      if (JITO_MODE) {
        txSig = await executeJitoTx([sellTx], mainKp, jitoCommitment)
      } else {
        const latestBlockhash = await solanaConnection.getLatestBlockhash()
        txSig = await execute(sellTx, latestBlockhash, 1)
      }
      if (txSig) {
        const tokenSellTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
        console.log("Success in sell transaction: ", tokenSellTx)
        return tokenSellTx
      } else {
        return null
      }
    } catch (error) {
      await sleep(1000)
      console.log("Sell transaction error")
      return null
    }
  } catch (error) {
    return null
  }
}

// const airdrop = async () => {
//   const airdropAddress = new PublicKey(AIRDROP_ADDRESS)
//   const airdropAmount = AIRDROP_RANDOM ?
//     Math.floor(10 ** 9 * (AIRDROP_AMOUNT - (AIRDROP_AMOUNT * AIRDROP_RAND_PERCENT / 100 * (Math.random() - 0.5)))) :
//     Math.floor(10 ** 9 * AIRDROP_AMOUNT)
//   for (; ;) {
//     try {
//       await sleep(AIRDROP_INTERVAL * 1000)
//       const tx = new Transaction().add(
//         ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * FEE_LEVEL }),
//         ComputeBudgetProgram.setComputeUnitLimit({ units: 5_000 }),
//         SystemProgram.transfer({
//           fromPubkey: mainKp.publicKey,
//           toPubkey: airdropAddress,
//           lamports: airdropAmount
//         })
//       )
//       tx.feePayer = mainKp.publicKey
//       tx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
//       // console.log(await solanaConnection.simulateTransaction(tx))
//       const sig = await sendAndConfirmTransaction(solanaConnection, tx, [mainKp])
//       console.log(`-------- Airdropped ---------- \n https://solscan.io/tx/${sig}`)
//     } catch (error) {
//       console.log("Error in airdrop transaction")
//     }
//   }
// }

const checkMissing = () => {
  const checkMissingElement =
    (total: Set<string>, someMissing: Set<string>) => [...new Set(total)].filter(element => !someMissing.has(element));

  console.log("\n=========== Checking Missed Wallets ===========")
  const one = checkMissingElement(totalProcesses, oneTimeBoughtProcesses)
  console.log("🚀 ~ checkMissing ~ one step:", one)
  const two = checkMissingElement(oneTimeBoughtProcesses, twoTimeBoughtProcesses)
  console.log("🚀 ~ checkMissing ~ two step:", two)
  const sell = checkMissingElement(twoTimeBoughtProcesses, soldProcesses)
  console.log("🚀 ~ checkMissing ~ sell step:", sell)
  const final = checkMissingElement(soldProcesses, successfulProcesses)
  console.log("🚀 ~ checkMissing ~ final step:", final)
  console.log("\n==============================================\n")
}

type WalletRecord = {
  privateKey: string;
  pubkey: string;
};

export async function runVolumeBot(wallets: WalletRecord[], baseMint: PublicKey, totalTimeMinutes: number) {
  console.log(`[VOLUME] Starting with ${wallets.length} wallets`);

  const DISTRIBUTE_INTERVAL_MIN_MS = 600; // 600ms
  const DISTRIBUTE_INTERVAL_MAX_MS = 900; // 900ms
  const BUY_INTERVAL_MIN = 0.6; // sec
  const BUY_INTERVAL_MAX = 0.9; // sec

  const startTime = Date.now();
  const totalRunTimeMs = totalTimeMinutes * 60 * 1000;

  console.log(`[VOLUME] Running for ${totalTimeMinutes} minutes (${totalRunTimeMs / 1000}s)`);

  let cycleCount = 0;

  while (Date.now() - startTime < totalRunTimeMs) {
    cycleCount++;
    console.log(`\n---- [VOLUME] Cycle ${cycleCount} ----`);

    // Random interval between actions
    const interval =
      Math.floor(
        DISTRIBUTE_INTERVAL_MIN_MS +
        Math.random() * (DISTRIBUTE_INTERVAL_MAX_MS - DISTRIBUTE_INTERVAL_MIN_MS)
      );

    // Select random subset of wallets
    const activeWalletCount = Math.floor(Math.random() * wallets.length) + 1;
    const selectedWallets = getRandomWallets(wallets, activeWalletCount);

    // Run buy/sell per wallet
    for (const walletRec of selectedWallets) {
      const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey));

      try {
        const solBalance = await solanaConnection.getBalance(kp.publicKey);

        if (solBalance < 0.005 * 10 ** 9) {
          console.log(`[VOLUME] Wallet ${kp.publicKey} has too little SOL (${solBalance / 10 ** 9})`);
          continue;
        }

        // Random buy percent (e.g. 10–40%)
        const buyPercent = Math.random() * 30 + 10;
        const buyAmount = Math.floor((solBalance * buyPercent) / 100);

        console.log(
          `[BUY] Wallet ${kp.publicKey.toBase58()} buying ${buyPercent.toFixed(1)}% (${buyAmount / 10 ** 9} SOL)`
        );

        await buy(kp, baseMint, buyAmount);
        await sleep(interval);

        // Random chance to sell after buying
        if (Math.random() < 0.6) {
          console.log(`[SELL] Wallet ${kp.publicKey.toBase58()} selling tokens`);
          await sell(baseMint, kp);
          await sleep(interval);
        }
      } catch (err) {
        console.error(`[VOLUME] Wallet ${walletRec.pubkey} error:`, err);
      }
    }

    // Small break before next cycle
    await sleep(3000);
  }

  // 🔹 FINAL STEP: Use all SOL left in each wallet to buy tokens
  console.log("\n💥 [VOLUME] Total runtime complete. Finalizing buys with all remaining SOL...");

  for (const walletRec of wallets) {
    const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey));

    try {
      const solBalance = await solanaConnection.getBalance(kp.publicKey);
      const reserve = 0.002 * 10 ** 9; // keep small SOL for fees

      if (solBalance <= reserve) {
        console.log(`[SKIP] Wallet ${kp.publicKey.toBase58()} — not enough SOL for final buy`);
        continue;
      }

      const finalBuyAmount = Math.floor(solBalance - reserve);
      console.log(`[FINAL BUY] Wallet ${kp.publicKey.toBase58()} buying ${finalBuyAmount / 10 ** 9} SOL worth`);

      await buy(kp, baseMint, finalBuyAmount);
      await sleep(1000);
    } catch (err) {
      console.error(`[FINAL BUY ERROR] Wallet ${walletRec.pubkey}:`, err);
    }
  }

  console.log("\n✅ [VOLUME] Volume bot completed all operations successfully.");
}

// 2) Market maker process - uses 30 wallets
export async function runMarketMakerBot(
  wallets: WalletRecord[],
  baseMint: PublicKey,
  totalTimeMinutes: number
) {
  console.log(`[MARKET MAKER] Starting with ${wallets.length} wallets`);

  const MIN_MS = 600; // 600 ms
  const MAX_MS = 900; // 900 ms
  const totalTimeMs = totalTimeMinutes * 60 * 1000;
  const startTime = Date.now();

  let cycle = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeMs) break; // Stop when time limit reached
    cycle++;

    // 🔹 Randomly choose how many wallets to use this cycle
    const activeWalletsCount = Math.floor(Math.random() * wallets.length) + 1;
    const selectedWallets = getRandomWallets(wallets, activeWalletsCount);

    // 🔹 Check if this is the final (end) phase
    const remaining = totalTimeMs - elapsed;
    const isEndPhase = remaining < totalTimeMs * 0.05; // last 5% of total time

    if (isEndPhase) {
      console.log(`⚡ Entering FINAL phase — all wallets will buy 100%`);
    }

    // 🔹 Perform buys for each selected wallet
    for (const [i, walletRec] of selectedWallets.entries()) {
      const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey));

      try {
        const solBalance = await solanaConnection.getBalance(kp.publicKey);
        const availableSol = solBalance - 5_000; // Leave a tiny buffer for fees

        if (availableSol <= 0) continue;

        // Random 1–50% normally, but 100% in end phase
        const buyPercent = isEndPhase ? 100 : Math.floor(Math.random() * 30) + 1;
        const buyAmount = Math.floor((availableSol * buyPercent) / 100);

        if (buyAmount > 0) {
          const result = await buy(kp, baseMint, buyAmount);
          if (result) {
            console.log(
              `[MARKET MAKER] Wallet ${i + 1}/${selectedWallets.length} bought ${(
                buyAmount / 1e9
              ).toFixed(6)} SOL (${buyPercent}%)`
            );
          } else {
            console.log(`[MARKET MAKER] Wallet ${i + 1} buy failed`);
          }
        }
      } catch (err) {
        console.error(`[MARKET MAKER] Wallet ${i + 1} error:`, err);
      }

      // 🔹 Random delay between each wallet (600–900 ms)
      const delay = Math.floor(Math.random() * (MAX_MS - MIN_MS + 1)) + MIN_MS;
      await sleep(delay);
    }

    console.log(`[MARKET MAKER] Cycle ${cycle} complete`);
  }

  console.log("🎯 [MARKET MAKER] Operation complete — all cycles finished.");
}

function getRandomWallets(wallets: WalletRecord[], N: number): WalletRecord[] {
  const selected = new Set<number>();

  while (selected.size < N) {
    const idx = Math.floor(Math.random() * wallets.length);
    selected.add(idx);
  }

  return Array.from(selected).map(i => wallets[i]);
}

// Helper function to calculate how much to buy for each wallet in this cycle
async function calculateCycleBuyAmount(wallets: WalletRecord[], percentages: number): Promise<number[]> {
  const amounts: number[] = [];

  // Get all balances first (in parallel)
  const balances = await Promise.all(
    wallets.map(wallet => solanaConnection.getBalance(new PublicKey(wallet.pubkey)))
  );

  // Calculate buy amount for each wallet based on percentages
  for (let i = 0; i < wallets.length; i++) {
    const balance = balances[i] ?? 0;
    const buyAmount = balance * (percentages / 100);
    amounts.push(buyAmount);
  }

  return amounts;
}


// Big Trade Bot - with dynamic buy/sell wallet selection and random differences
export async function runBigTradeBot(wallets: WalletRecord[], baseMint: PublicKey, totalTimeMinutes: number) {
  console.log(`[BIG TRADE] Starting with ${wallets.length} wallets`);
  const totalTimeMs = totalTimeMinutes * 60 * 1000;
  const startTime = Date.now();

  const MIN_MS = 600; // 600 ms
  const MAX_MS = 900; // 900 ms
  const delay = Math.floor(Math.random() * (MAX_MS - MIN_MS + 1)) + MIN_MS;

  let sellAvailableWalletList: WalletRecord[] = [];

  while (Date.now() - startTime < totalTimeMs * 0.95) { // Leave 5% time for final buy
    console.log(`\n=========================`);
    console.log(`[BIG TRADE] New Round Start`);
    console.log(`=========================\n`);

    // 🔹 PHASE 1: Buy with 10–50% of wallets (90% SOL)
    let buyPercent = Math.floor(Math.random() * 41) + 10;
    let phase1Wallets = selectRandomWallets(wallets, buyPercent);

    console.log(`[BIG TRADE] Phase 1: Buying 90% SOL with ${phase1Wallets.length} wallets (${buyPercent}%)`);
    for (const walletRec of phase1Wallets) {
      const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey));
      const balance = await solanaConnection.getBalance(kp.publicKey);
      const buyAmount = Math.floor(balance * 0.9);
      if (buyAmount <= 0) continue;
      try {
        await performBigBuy(walletRec, baseMint, buyAmount); // Replace with your actual buy logic
        console.log(`[BUY] Wallet ${walletRec.pubkey} bought ${buyAmount / 1e9} SOL worth.`);
        sellAvailableWalletList.push(walletRec);
      } catch (err) {
        console.error(`[BIG TRADE] Error buying with ${walletRec.pubkey}:`, err);
      }
      await sleep(delay); // small delay between wallets
    }
    await sleep((totalTimeMinutes / (Math.floor(Math.random() * 11) + 10)) * 60 * 1000);

    // 🔹 PHASE 2: Buy from remaining wallets (10–50% again)
    const remainingWallets = wallets.filter(w => !sellAvailableWalletList.includes(w));
    if (remainingWallets.length > 0) {
      buyPercent = Math.floor(Math.random() * 41) + 10;
      let phase2Wallets = selectRandomWallets(remainingWallets, buyPercent);
      console.log(`[BIG TRADE] Phase 2: Buying 90% SOL with ${phase2Wallets.length} wallets (${buyPercent}%)`);

      for (const walletRec of phase2Wallets) {
        const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey));
        const balance = await solanaConnection.getBalance(kp.publicKey);
        const buyAmount = Math.floor(balance * 0.9);
        if (buyAmount <= 0) continue;
        try {
          await performBigBuy(walletRec, baseMint, buyAmount);
          console.log(`[BUY] Wallet ${walletRec.pubkey} bought ${buyAmount / 1e9} SOL worth.`);
          sellAvailableWalletList.push(walletRec);
        } catch (err) {
          console.error(`[BIG TRADE] Error buying with ${walletRec.pubkey}:`, err);
        }
        await sleep(delay);
      }
      await sleep((totalTimeMinutes / (Math.floor(Math.random() * 11) + 10)) * 60 * 1000);
    }

    // 🔹 PHASE 3: Sell 80% from all sell-available wallets
    console.log(`[BIG TRADE] Phase 3: Selling 80% tokens from ${sellAvailableWalletList.length} wallets`);
    for (const walletRec of sellAvailableWalletList) {
      try {
        await performBigSell(walletRec, baseMint); // Replace with your actual sell logic
        console.log(`[SELL] Wallet ${walletRec.pubkey} sold 80% of tokens.`);
      } catch (err) {
        console.error(`[BIG TRADE] Error selling from ${walletRec.pubkey}:`, err);
      }
      await sleep(delay);
    }

    // After selling, clear the list
    sellAvailableWalletList = [];

    await sleep((totalTimeMinutes / (Math.floor(Math.random() * 11) + 10)) * 60 * 1000);
    console.log(`[BIG TRADE] Round completed.\n`);
  }

  // 🔹 FINAL PHASE: End of total time, buy all remaining SOL in all wallets
  console.log("\n===============================");
  console.log("[BIG TRADE] Final phase: Buying all remaining SOL from all wallets.");
  console.log("===============================\n");

  for (const walletRec of wallets) {
    const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey));
    const balance = await solanaConnection.getBalance(kp.publicKey);
    const buyAmount = Math.floor(balance * 0.99);
    if (buyAmount <= 0) continue;

    try {
      await performBigBuy(walletRec, baseMint, buyAmount);
      console.log(`[FINAL BUY] Wallet ${walletRec.pubkey} bought ${buyAmount / 1e9} SOL worth.`);
    } catch (err) {
      console.error(`[FINAL BUY ERROR] ${walletRec.pubkey}:`, err);
    }
    await sleep(800);
  }

  console.log("[BIG TRADE] ✅ All wallets fully bought. Operation complete.");
}


// Simulate a "big buy" operation (buyAmount is in the WalletRecord)
async function performBigBuy(walletRec: WalletRecord, baseMint: PublicKey, buyAmount: number) {
  console.log(`[BIG BUY] Wallet ${walletRec.pubkey} is buying tokens`);

  const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey))

  let result = await buy(kp, baseMint, buyAmount)

  if (result) {
    console.log(`[BIG BUY] Wallet ${walletRec.pubkey} bought ${buyAmount} tokens.`);
  } else {
    console.log(`[BIG BUY] Wallet ${walletRec.pubkey} failed to buy ${buyAmount} tokens.`);
  }

  // Perform the actual buy operation (place your logic here)
  await sleep(500); // Simulate the time taken for the buy operation
}

// Simulate a "big sell" operation (buyAmount is in the WalletRecord)
async function performBigSell(walletRec: WalletRecord, baseMint: PublicKey) {
  console.log(`[BIG SELL] Wallet ${walletRec.pubkey} is selling tokens`);

  const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey))

  const tokenAta = await getAssociatedTokenAddress(baseMint, kp.publicKey)
  const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
  if (!tokenBalInfo) {
    console.log("Balance incorrect")
    return null
  }
  const tokenBalance = Number(tokenBalInfo.value.amount)
  const sellAmount = tokenBalance * 80 / 100
  let result = await sell(baseMint, kp, sellAmount)

  if (result) {
    console.log(`[BIG SELL] Wallet ${walletRec.pubkey} sold tokens.`);
  } else {
    console.log(`[BIG SELL] Wallet ${walletRec.pubkey} failed to sell tokens.`);
  }
  // Perform the actual sell operation (place your logic here)
  await sleep(2000); // Simulate the time taken for the sell operation
}

// Helper function to randomly select wallets from a given list
function selectRandomWallets(wallets: WalletRecord[], percent: number): WalletRecord[] {
  const count = Math.max(1, Math.floor(wallets.length * percent / 100));
  const selected = new Set<number>();
  while (selected.size < count) {
    selected.add(Math.floor(Math.random() * wallets.length));
  }
  return Array.from(selected).map(i => wallets[i]);
}



// Main function that orchestrates all bot operations
export async function main() {
  console.log('🚀 Starting Pumpfun Volume Market Maker Bot...');

  try {
    // This function will be called from CLI bot
    // The actual execution logic is in cli-bot.ts
    console.log('📝 Please run: npm run start or node cli-bot.js');
    console.log('💡 Use the CLI interface for interactive configuration.');
  } catch (error) {
    console.error('❌ Main function error:', error);
    throw error;
  }
}

// Export the main function for CLI usage
if (require.main === module) {
  main().catch(console.error);
}

export const sellPumpswap = async (baseMint: PublicKey, wallet: Keypair, sellPercent: number) => {
  try {
    const data: Data[] = readJson("market_maker_data.json");
    if (data.length == 0) {
      await sleep(1000)
      return null
    }

    const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
    const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
    if (!tokenBalInfo) {
      console.log("Balance incorrect")
      return null
    }

    try {
      let sellTx = await makeSellPumpswapTokenTxMarketMaker(wallet, baseMint, sellPercent);

      if (sellTx == null) {
        console.log(`Error getting buy transaction`)
        return null
      }

      // console.log("simulateTransaction ==> ", await solanaConnection.simulateTransaction(sellTx))
      let txSig
      if (JITO_MODE) {
        txSig = await executeJitoTx([sellTx], mainKp, jitoCommitment)
      } else {
        const latestBlockhash = await solanaConnection.getLatestBlockhash()
        txSig = await execute(sellTx, latestBlockhash, false)
      }
      if (txSig) {
        const tokenSellTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
        console.log("Success in sell transaction: ", tokenSellTx)
        return tokenSellTx
      } else {
        return null
      }
    } catch (error) {
      await sleep(1000)
      console.log("Sell transaction error", error);
      return null
    }
  } catch (error) {
    return null
  }
}