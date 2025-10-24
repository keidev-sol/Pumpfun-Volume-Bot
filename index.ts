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
  distributionNum: number
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

    // 1. Get main wallet balance
    const mainSolBal = await connection.getBalance(mainKp.publicKey);
    const mainSolBalSol = mainSolBal / SOL_DECIMALS;
    console.log("[VOLUME BOT] Main wallet", mainKp.publicKey.toBase58(), "balance:", mainSolBalSol, "SOL");

    if (mainSolBalSol <= 0) {
      console.log("[VOLUME BOT] Main wallet balance is not enough");
      return [];
    }

    // 2. Keep a tiny fee buffer for transaction fees
    const FEE_BUFFER = 0.01; // 0.1 millisol
    const totalToDistribute = mainSolBalSol - FEE_BUFFER;
    if (totalToDistribute <= MIN_SOL * distributionNum) {
      console.log("[VOLUME BOT] Not enough balance to satisfy minimum per wallet");
      return [];
    }

    console.log(`[VOLUME BOT] Total to distribute (after fee buffer): ${totalToDistribute.toFixed(6)} SOL`);

    // 3. Random distribution with minimum constraint
    const solAmounts: number[] = Array(distributionNum).fill(MIN_SOL);
    let remaining = totalToDistribute - MIN_SOL * distributionNum;

    // Generate random extras and scale to remaining
    const extras = [];
    for (let i = 0; i < distributionNum; i++) extras.push(Math.random());
    const sumExtras = extras.reduce((a, b) => a + b, 0);
    const scaledExtras = extras.map((x) => (x / sumExtras) * remaining);

    // Add extras to minimums
    for (let i = 0; i < distributionNum; i++) {
      solAmounts[i] = Number((solAmounts[i] + scaledExtras[i]).toFixed(6));
    }

    // Fix rounding errors to match exact total
    const diff = Number((totalToDistribute - solAmounts.reduce((a, b) => a + b, 0)).toFixed(6));
    solAmounts[0] = Number((solAmounts[0] + diff).toFixed(6));

    console.log("[VOLUME BOT] Final SOL distribution:", solAmounts);
    console.log("[VOLUME BOT] Total distributed:", solAmounts.reduce((a, b) => a + b, 0).toFixed(6));

    // 4. Create wallets & transfer instructions
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

    // 5. Save wallet data
    wallets.forEach((wallet) => {
      data.push({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
      });
    });

    saveDataToFile(data);

    // 6. Build & send transaction
    const latestBlockhash = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: sendSolTx,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([mainKp]);

    // Simulate first
    const simulateResult = await connection.simulateTransaction(transaction, { sigVerify: true });
    if (simulateResult.value.err) {
      console.log("[VOLUME BOT] Simulation failed", simulateResult);
      return null;
    }

    // Send
    let txSig;
    if (JITO_MODE) {
      txSig = await executeJitoTx([transaction], mainKp, jitoCommitment);
    } else {
      txSig = await execute(transaction, latestBlockhash, 1);
    }

    if (txSig) {
      console.log(`[VOLUME BOT] SOL distributed: https://solscan.io/tx/${txSig}`);
    }

    console.log("[VOLUME BOT] ✅ Success in distribution");

    await sleep(3000)

    await transferAllSolFromWallets()

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

export async function runVolumeBot(data: WalletRecord[], baseMint: PublicKey) {
  console.log("🚀 ~ runVolumeBot ~ data:", data)
  console.log(`[VOLUME] Starting with ${data.length} wallets`);
  while (true) {
    // for (const walletRec of wallets) {
    // const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey));
    try {
      console.log("---- New round of distribution ---- \n")

      // let data: {
      //   kp: Keypair;
      //   buyAmount: number;
      // }[] | null = null


      if (data == null || data.length == 0) {
        console.log("Distribution failed")
        await sleep(30000)
        continue
      }
      const interval = Math.floor((DISTRIBUTE_INTERVAL_MIN + Math.random() * (DISTRIBUTE_INTERVAL_MAX - DISTRIBUTE_INTERVAL_MIN)) * 1000)

      data.map(async ({ privateKey }, n) => {
        let kp = Keypair.fromSecretKey(base58.decode(privateKey))
        // test case
        totalProcesses.add(kp.publicKey.toBase58())

        await sleep(Math.round(n * BUY_INTERVAL_MAX / DISTRIBUTE_WALLET_NUM * 1000))
        let srcKp = kp
        // buy part with random percent
        const BUY_WAIT_INTERVAL = Math.round(Math.random() * (BUY_INTERVAL_MAX - BUY_INTERVAL_MIN) + BUY_INTERVAL_MIN)
        const SELL_WAIT_INTERVAL = Math.round(Math.random() * (SELL_INTERVAL_MAX - SELL_INTERVAL_MIN) + SELL_INTERVAL_MIN)
        const solBalance = await solanaConnection.getBalance(srcKp.publicKey)
        
        let buyAmountInPercent = Number((Math.random() * (BUY_UPPER_PERCENT - BUY_LOWER_PERCENT) + BUY_LOWER_PERCENT).toFixed(3))
        
        if (solBalance < 5 * 10 ** 6) {
          console.log("🚀 ~ runVolumeBot ~ solBalance:", solBalance)
          console.log("Sol balance is not enough in one of wallets")
          return
        }

        let buyAmountFirst = Math.floor((solBalance - 5 * 10 ** 6) / 100 * buyAmountInPercent)
        let buyAmountSecond = Math.floor(solBalance - buyAmountFirst - 5 * 10 ** 6)

        console.log(`balance: ${solBalance / 10 ** 9} first: ${buyAmountFirst / 10 ** 9} second: ${buyAmountSecond / 10 ** 9}`)
        // try buying until success
        let i = 0
        while (true) {
          try {
            if (i > 50) {
              console.log("Error in buy transaction")
              break
            }
            const result = await buy(srcKp, baseMint, buyAmountFirst)
            if (result) {
              break
            } else {
              i++
              await sleep(2000)
            }
          } catch (error) {
            i++
          }
        }

        await sleep(BUY_WAIT_INTERVAL * 1000)
        oneTimeBoughtProcesses.add(kp.publicKey.toBase58())

        let l = 0
        while (true) {
          try {
            if (l > 50) {
              console.log("Error in buy transaction")
              break
            }
            const result = await buy(srcKp, baseMint, buyAmountSecond)
            if (result) {
              break
            } else {
              l++
              await sleep(2000)
            }
          } catch (error) {
            l++
          }
        }

        twoTimeBoughtProcesses.add(kp.publicKey.toBase58())

        await sleep(SELL_WAIT_INTERVAL * 1000)

        // try selling until success
        let j = 0
        while (true) {
          if (j > 50) {
            console.log("Error in sell transaction")
            return
          }
          const result = await sell(baseMint, srcKp)
          if (result) {
            break
          } else {
            j++
            await sleep(2000)
          }
        }

        soldProcesses.add(kp.publicKey.toBase58())

        // SOL transfer part
        const balance = await solanaConnection.getBalance(srcKp.publicKey)

        let k = 0
        while (true) {
          try {
            if (k > 5) {
              console.log("Failed to transfer SOL to main wallet in one of sub wallet")
              return
            }
            const baseAta = getAssociatedTokenAddressSync(baseMint, srcKp.publicKey)
            const tx = new Transaction().add(
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * FEE_LEVEL }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: 5_000 }),
              SystemProgram.transfer({
                fromPubkey: srcKp.publicKey,
                toPubkey: mainKp.publicKey,
                lamports: balance
              })
            )
            const baseInfo = await solanaConnection.getAccountInfo(baseAta)
            if ((makerNum % 4 === 0 || makerNum % 11 === 0) && baseInfo) {
              tx.add(
                createCloseAccountInstruction(
                  baseAta,
                  airdropAddress,
                  srcKp.publicKey
                )
              )
              console.log(" --- Airdropped --- ")
            } else {
              tx.add(
                createCloseAccountInstruction(
                  baseAta,
                  mainKp.publicKey,
                  srcKp.publicKey
                )
              )
            }

            tx.feePayer = mainKp.publicKey
            tx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash

            // console.log(await solanaConnection.simulateTransaction(tx))

            const sig = await sendAndConfirmTransaction(solanaConnection, tx, [srcKp, mainKp], { skipPreflight: true, commitment: "confirmed" })
            // console.log(await solanaConnection.getBalance(destinationKp.publicKey) / 10 ** 9, "SOL")
            console.log(`Gathered SOL back to main wallet, https://solscan.io/tx/${sig}`)

            // filter the keypair that is completed (after this procedure, only keypairs with sol or ata will be saved in data.json)
            const walletsData = readJson()
            const wallets = walletsData.filter(({ privateKey }) => base58.encode(srcKp.secretKey) != privateKey)
            saveNewFile(wallets)
            break
          } catch (error) {
            console.log("Error in gather transaction ", error)
            k++
          }
        }

        successfulProcesses.add(kp.publicKey.toBase58())
        // one wallet procedure ended 
        makerNum++
        console.log("Maker number in total : ", makerNum)
      })

      await sleep(interval)
      checkMissing()
    } catch (err) {
      console.error("[VOLUME] Wallet error", err);
    }
    await sleep(1000); // stagger between wallets
    // }
    await sleep(5000); // wait before next round
  }
}

// 2) Market maker process - uses 30 wallets
export async function runMarketMakerBot(wallets: WalletRecord[], totalTimeMinutes: number) {
  console.log(`[MARKET MAKER] Starting with ${wallets.length} wallets`);

  // Calculate the total number of cycles based on totalTimeMinutes (one cycle per second for simplicity)
  const totalCycles = totalTimeMinutes * 60;

  let cycleCount = 0;
  while (cycleCount < totalCycles) {
    cycleCount++;

    // Dynamically select the number of wallets for this cycle (between 1 and the total number of available wallets)
    const activeWalletsCount = Math.floor(Math.random() * wallets.length) + 1; // Between 1 and wallets.length
    const selectedWallets = wallets.slice(0, activeWalletsCount); // Select the first N wallets for this cycle

    // Check if it's the last cycle (we want to buy all remaining tokens in the last cycle)
    const isLastCycle = cycleCount === totalCycles;

    let percentages;
    if (isLastCycle) {
      // In the last cycle, buy all remaining tokens from each wallet
      percentages = new Array(selectedWallets.length).fill(100); // 100% for each wallet
    } else {
      // Randomly distribute percentages for each selected wallet (make sure the total is 100%)
      percentages = generateRandomPercentages(selectedWallets.length);
    }

    // Calculate the amount to be bought per wallet based on percentages
    const totalBuyAmountForThisCycle = await calculateCycleBuyAmount(selectedWallets, percentages);

    // Loop through each selected wallet and perform buy operation
    for (let i = 0; i < activeWalletsCount; i++) {
      const walletRec = selectedWallets[i];
      const buyAmount = totalBuyAmountForThisCycle[i];
      const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey))

      try {
        console.log(`[MARKET MAKER] Wallet ${i + 1} buying ${buyAmount} units`);

        let result = await buy(kp, baseMint, buyAmount)
        if (result) {
          console.log(`[MARKET MAKER] Wallet ${i + 1} bought ${buyAmount} units`);
        } else {
          console.log(`[MARKET MAKER] Wallet ${i + 1} failed to buy ${buyAmount} units`);
        }
      } catch (err) {
        console.error("[MARKET MAKER] Wallet error", err);
      }

      // Random delay for each wallet to simulate randomness
      const randomDelay = Math.floor(Math.random() * 10) + 1; // Random delay in seconds (1–10)
      await sleep(randomDelay * 1000);
    }

    // Overall sleep between cycles (to simulate time passed)
    const randomCycleDuration = Math.floor(Math.random() * 60) + 30; // Random cycle duration in seconds (30 to 90 sec)
    console.log(`[MARKET MAKER] Waiting for ${randomCycleDuration} seconds before next cycle...`);
    await sleep(randomCycleDuration * 1000);

    console.log(`[MARKET MAKER] Cycle ${cycleCount}/${totalCycles} complete`);
  }

  console.log("[MARKET MAKER] Market maker operation complete.");
}

// Helper function to generate random percentages for each wallet in a cycle (ensuring they add up to 100%)
function generateRandomPercentages(walletsCount: number): number[] {
  const percentages = [];
  let total = 0;

  // Generate random percentages, and make sure they sum to 100%
  for (let i = 0; i < walletsCount - 1; i++) {
    const randomPercentage = Math.random() * (100 - total); // Ensure we don't exceed 100% in total
    percentages.push(randomPercentage);
    total += randomPercentage;
  }

  // Last percentage is whatever remains to reach 100%
  percentages.push(100 - total);

  // Shuffle the percentages to randomize them
  return percentages.sort(() => Math.random() - 0.5);
}

// Helper function to calculate how much to buy for each wallet in this cycle
async function calculateCycleBuyAmount(wallets: WalletRecord[], percentages: number[]): Promise<number[]> {
  const amounts: number[] = [];
  let totalAmount = 0;

  // Get all balances first (in parallel)
  const balances = await Promise.all(
    wallets.map(wallet => solanaConnection.getBalance(new PublicKey(wallet.pubkey)))
  );

  // Calculate total balance
  totalAmount = balances.reduce((sum, balance) => sum + (balance ?? 0), 0);

  // Calculate buy amount for each wallet based on percentages
  for (let i = 0; i < wallets.length; i++) {
    const balance = balances[i] ?? 0;
    const buyAmount = balance * (percentages[i] / 100);
    amounts.push(buyAmount);
  }

  return amounts;
}


// Big Trade Bot - with dynamic buy/sell wallet selection and random differences
export async function runBigTradeBot(wallets: WalletRecord[], totalTimeMinutes: number) {
  console.log(`[BIG TRADE] Starting with ${wallets.length} wallets`);

  // Calculate total number of cycles for the given time period
  const totalCycles = Math.max(1, Math.floor(totalTimeMinutes * 2)); // Reduced cycles for better control
  let cycleCount = 0;

  // Start with all wallets in buyAvailableWalletList (no wallets have been sold yet)
  let buyAvailableWalletList = [...wallets];
  let sellAvailableWalletList: WalletRecord[] = []; // Initially no wallets are available to sell

  console.log(`[BIG TRADE] Total cycles planned: ${totalCycles}`);

  while (cycleCount < totalCycles) {
    cycleCount++;

    console.log(`[BIG TRADE] Cycle ${cycleCount}/${totalCycles} - Buy available: ${buyAvailableWalletList.length}, Sell available: ${sellAvailableWalletList.length}`);

    // If there are no wallets left to buy, break the loop
    if (buyAvailableWalletList.length === 0) {
      console.log("[BIG TRADE] No wallets left to buy. Finalizing.");
      break;
    }

    // Determine wallets to buy (always buy at least 1, up to available wallets)
    const maxBuyWallets = Math.min(buyAvailableWalletList.length, Math.floor(wallets.length * 0.3) + 1); // Max 30% of total wallets per cycle
    const walletsToBuyCount = Math.floor(Math.random() * maxBuyWallets) + 1;
    
    // Determine wallets to sell (only if we have wallets available to sell)
    let walletsToSellCount = 0;
    if (sellAvailableWalletList.length > 0) {
      const maxSellWallets = Math.min(sellAvailableWalletList.length, Math.floor(wallets.length * 0.2) + 1); // Max 20% of total wallets per cycle
      walletsToSellCount = Math.floor(Math.random() * maxSellWallets) + 1;
    }

    console.log(`🚀 ~ runBigTradeBot ~ walletsToBuyCount: ${walletsToBuyCount}`);
    console.log(`🚀 ~ runBigTradeBot ~ walletsToSellCount: ${walletsToSellCount}`);

    // Ensure we have enough wallets to buy
    if (walletsToBuyCount > buyAvailableWalletList.length) {
      console.log("[BIG TRADE] Not enough wallets to buy, skipping cycle");
      continue;
    }

    // Randomly select wallets for buy and sell operations
    const buyWallets = selectRandomWallets(buyAvailableWalletList, walletsToBuyCount);
    const sellWallets = sellAvailableWalletList.length > 0 ? selectRandomWallets(sellAvailableWalletList, walletsToSellCount) : [];

    console.log(`🚀 ~ runBigTradeBot ~ buyWallets: ${buyWallets.length} wallets`);
    console.log(`🚀 ~ runBigTradeBot ~ sellWallets: ${sellWallets.length} wallets`);

    // Perform the big buy operations
    for (const walletRec of buyWallets) {
      try {
        const balance = await solanaConnection.getBalance(new PublicKey(walletRec.pubkey));
        const buyAmount = balance || 0;
        await performBigBuy(walletRec); // 100% buy amount
        console.log(`[BIG BUY] Wallet ${walletRec.pubkey} bought tokens with ${buyAmount} SOL.`);

        // Once a wallet has been bought, it becomes available to sell in future cycles
        sellAvailableWalletList.push(walletRec);
      } catch (err) {
        console.error(`[BIG TRADE] Wallet ${walletRec.pubkey} error during buy:`, err);
      }
      await sleep(2000); // Pause between buy actions
    }

    // Perform the big sell operations
    for (const walletRec of sellWallets) {
      try {
        await performBigSell(walletRec); // 100% sell amount
        console.log(`[BIG SELL] Wallet ${walletRec.pubkey} sold tokens.`);
        
        // Remove sold wallet from sell list (it can be bought again in future cycles)
        sellAvailableWalletList = sellAvailableWalletList.filter(wallet => wallet.pubkey !== walletRec.pubkey);
        buyAvailableWalletList.push(walletRec); // Make it available for buying again
      } catch (err) {
        console.error(`[BIG TRADE] Wallet ${walletRec.pubkey} error during sell:`, err);
      }
      await sleep(2000); // Pause between sell actions
    }

    // Remove the wallets that were bought from the buy list
    buyAvailableWalletList = buyAvailableWalletList.filter(wallet => !buyWallets.includes(wallet));

    // If all wallets have been used and no more operations possible, break
    if (buyAvailableWalletList.length === 0 && sellAvailableWalletList.length === 0) {
      console.log("[BIG TRADE] All wallets have been used.");
      break;
    }

    // Random cycle delay between actions
    const cycleDelay = Math.floor(Math.random() * 15000) + 5000; // Random delay between 5-20 seconds
    console.log(`[BIG TRADE] Waiting for ${cycleDelay / 1000} seconds before next cycle...`);
    await sleep(cycleDelay);
    console.log(`[BIG TRADE] Cycle ${cycleCount}/${totalCycles} complete.`);
  }

  // Final buy step: if there are remaining wallets to buy, buy from them
  if (buyAvailableWalletList.length > 0) {
    console.log("[BIG TRADE] Finalizing: Buying from all remaining wallets.");
    for (const walletRec of buyAvailableWalletList) {
      try {
        const buyAmount = await solanaConnection.getBalance(new PublicKey(walletRec.pubkey)) || 0;
        await performBigBuy(walletRec); // 100% buy amount
        console.log(`[BIG BUY] Wallet ${walletRec.pubkey} bought tokens with ${buyAmount} SOL.`);
      } catch (err) {
        console.error(`[BIG TRADE] Wallet ${walletRec.pubkey} error during final buy:`, err);
      }
      await sleep(2000); // Pause between buy actions
    }
  }

  console.log("[BIG TRADE] Big trade operation complete.");
}


// Simulate a "big buy" operation (buyAmount is in the WalletRecord)
async function performBigBuy(walletRec: WalletRecord) {
  console.log(`[BIG BUY] Wallet ${walletRec.pubkey} is buying tokens`);

  let balanceLamports = await solanaConnection.getBalance(new PublicKey(walletRec.pubkey))

  const balanceSol = balanceLamports / 1e9;

  const tokenPrice = await getTokenPrice(baseMint.toBase58())

  const buyAmount = (balanceSol - 0.005) / tokenPrice

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
async function performBigSell(walletRec: WalletRecord) {
  console.log(`[BIG SELL] Wallet ${walletRec.pubkey} is selling tokens`);

  const kp = Keypair.fromSecretKey(base58.decode(walletRec.privateKey))
  let result = await sell(baseMint, kp)
  
  if (result) {
    console.log(`[BIG SELL] Wallet ${walletRec.pubkey} sold tokens.`);
  } else {
    console.log(`[BIG SELL] Wallet ${walletRec.pubkey} failed to sell tokens.`);
  }
  // Perform the actual sell operation (place your logic here)
  await sleep(2000); // Simulate the time taken for the sell operation
}

// Helper function to randomly select wallets from a given list
function selectRandomWallets(wallets: WalletRecord[], count: number): WalletRecord[] {
  const selectedWallets: WalletRecord[] = [];
  const availableWallets = [...wallets]; // Clone the wallets array to avoid mutating the original

  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * availableWallets.length);
    selectedWallets.push(availableWallets[randomIndex]);
    availableWallets.splice(randomIndex, 1); // Remove selected wallet from the available list
  }

  return selectedWallets;
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