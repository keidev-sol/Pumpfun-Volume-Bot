import {
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
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
  TOKEN_MINT,
  JITO_MODE,
  SOL_AMOUNT_TO_DISTRIBUTE,
  DISTRIBUTE_INTERVAL_MIN,
  DISTRIBUTE_INTERVAL_MAX,
  AIRDROP_ADDRESS,
  FEE_LEVEL,
  POOL_ID,
  SOL_DECIMALS,
  FEE_BUFFER,
  MIN_SOL,
  MAX_SOL,
} from './constants'
import { Data, getTokenPrice, readJson, saveDataToFile, saveNewFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTxWithJupiter, getSellTxWithJupiter } from './utils/swapOnlyAmm'
import { execute } from './executor/legacy'
import { executeJitoTx } from './executor/jito'
import { getBuyTx, getSellTx } from './utils/swapRaySdk'
import { makeBuyPumpfunTokenTx, makeSellPumpfunTokenTx } from './utils/pumpfun'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment: "confirmed"
})

export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const baseMint = new PublicKey(TOKEN_MINT)
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 20 ? 20 : DISTRIBUTE_WALLET_NUM
const jitoCommitment: Commitment = "confirmed"

const airdropAddress = new PublicKey(AIRDROP_ADDRESS)
let makerNum = 0

const totalProcesses: Set<string> = new Set()
const oneTimeBoughtProcesses: Set<string> = new Set()
const twoTimeBoughtProcesses: Set<string> = new Set()
const soldProcesses: Set<string> = new Set()
const successfulProcesses: Set<string> = new Set()

const main = async () => {
  const solBalance = await solanaConnection.getBalance(mainKp.publicKey)
  console.log(`Volume bot is running`)
  console.log(`Wallet address: ${mainKp.publicKey.toBase58()}`)
  console.log(`Pool token mint: ${baseMint.toBase58()}`)
  console.log(`Wallet SOL balance: ${(solBalance / LAMPORTS_PER_SOL).toFixed(3)}SOL`)
  console.log(`Buying wait time max: ${BUY_INTERVAL_MAX}s`)
  console.log(`Buying wait time min: ${BUY_INTERVAL_MIN}s`)
  console.log(`Selling wait time max: ${SELL_INTERVAL_MAX}s`)
  console.log(`Selling wait time min: ${SELL_INTERVAL_MIN}s`)
  console.log(`Buy upper limit percent: ${BUY_UPPER_PERCENT}%`)
  console.log(`Buy lower limit percent: ${BUY_LOWER_PERCENT}%`)
  console.log(`Distribute SOL to ${distritbutionNum} wallets`)

  if (solBalance < (BUY_LOWER_PERCENT + 0.002) * distritbutionNum) {
    console.log("Sol balance is not enough for distribution")
  }

  // main part
  for (; ;) {
    try {
      console.log("---- New round of distribution ---- \n")

      let data: {
        kp: Keypair;
        buyAmount: number;
      }[] | null = null

      data = await distributeSol(solanaConnection, mainKp, distritbutionNum)
      if (data == null || data.length == 0) {
        console.log("Distribution failed")
        await sleep(30000)
        continue
      }
      const interval = Math.floor((DISTRIBUTE_INTERVAL_MIN + Math.random() * (DISTRIBUTE_INTERVAL_MAX - DISTRIBUTE_INTERVAL_MIN)) * 1000)

      data.map(async ({ kp }, n) => {
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
    } catch (error) {
      console.log("Error in one of the steps")
    }
  }
}

// const distributeSol = async (connection: Connection, mainKp: Keypair, distritbutionNum: number) => {
//   const data: Data[] = []
//   const wallets = []
//   try {
//     const sendSolTx: TransactionInstruction[] = []
//     sendSolTx.push(
//       ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * FEE_LEVEL }),
//       ComputeBudgetProgram.setComputeUnitLimit({ units: 12_000 })
//     )
//     const mainSolBal = await connection.getBalance(mainKp.publicKey)
//     if (mainSolBal <= 5 * 10 ** 7) {
//       console.log("Main wallet balance is not enough")
//       return []
//     }

//     let solAmount = Math.floor(SOL_AMOUNT_TO_DISTRIBUTE * 10 ** 9 / distritbutionNum)

//     for (let i = 0; i < distritbutionNum; i++) {
//       const wallet = Keypair.generate()
//       let lamports = Math.floor(solAmount * (1 - (Math.random() * 0.2)))

//       wallets.push({ kp: wallet, buyAmount: solAmount })
//       sendSolTx.push(
//         SystemProgram.transfer({
//           fromPubkey: mainKp.publicKey,
//           toPubkey: wallet.publicKey,
//           lamports
//         })
//       )
//     }

//     wallets.map((wallet) => {
//       data.push({
//         privateKey: base58.encode(wallet.kp.secretKey),
//         pubkey: wallet.kp.publicKey.toBase58(),
//       })
//     })

//     try {
//       saveDataToFile(data)
//     } catch (error) {
//       console.log("DistributeSol tx error")
//     }
//     try {
//       const siTx = new Transaction().add(...sendSolTx)
//       const latestBlockhash = await solanaConnection.getLatestBlockhash()
//       siTx.feePayer = mainKp.publicKey
//       siTx.recentBlockhash = latestBlockhash.blockhash
//       const messageV0 = new TransactionMessage({
//         payerKey: mainKp.publicKey,
//         recentBlockhash: latestBlockhash.blockhash,
//         instructions: sendSolTx,
//       }).compileToV0Message()
//       const transaction = new VersionedTransaction(messageV0)
//       transaction.sign([mainKp])
//       // console.log(await connection.simulateTransaction(transaction))
//       let txSig
//       if (JITO_MODE) {
//         txSig = await executeJitoTx([transaction], mainKp, jitoCommitment)
//       } else {
//         txSig = await execute(transaction, latestBlockhash, 1)
//       }
//       if (txSig) {
//         const distibuteTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
//         console.log("SOL distributed ", distibuteTx)
//       }
//     } catch (error) {
//       console.log("Distribution error")
//       console.log(error)
//       return null
//     }

//     console.log("Success in distribution")
//     return wallets
//   } catch (error) {
//     console.log(`Failed to transfer SOL`)
//     return null
//   }
// }

const distributeSol = async (
  connection: Connection,
  mainKp: Keypair,
  distritbutionNum: number
) => {
  const data: Data[] = [];
  const wallets: { kp: Keypair; buyAmount: number }[] = [];

  try {
    const sendSolTx: TransactionInstruction[] = [];
    sendSolTx.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 * FEE_LEVEL }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 12_000 })
    );

    // --- 1. Get main wallet balance ---
    const mainSolBal = await connection.getBalance(mainKp.publicKey);
    const mainSolBalSol = mainSolBal / SOL_DECIMALS;
    console.log(
      "[VOLUME BOT] Main wallet",
      mainKp.publicKey.toBase58(),
      "balance:",
      mainSolBalSol,
      "SOL"
    );

    if (mainSolBalSol <= FEE_BUFFER) {
      console.log("[VOLUME BOT] Main wallet balance is not enough");
      return [];
    }

    // --- 2. Determine total SOL to distribute ---
    const totalToDistribute = mainSolBalSol - FEE_BUFFER; // keep buffer for fees
    console.log(`[VOLUME BOT] Total to distribute: ${totalToDistribute.toFixed(6)} SOL`);

    // --- 3. Generate random weights for each wallet ---
    const weights: number[] = [];
    for (let i = 0; i < distritbutionNum; i++) {
      weights.push(Math.random());
    }
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = weights.map((w) => w / weightSum);

    // --- 4. Compute random SOL amounts ---
    let solAmounts = normalizedWeights.map((w) =>
      Number((w * totalToDistribute).toFixed(6))
    );

    // Enforce min/max range (0.5–2 SOL)
    let adjusted = false;
    for (let i = 0; i < solAmounts.length; i++) {
      if (solAmounts[i] < MIN_SOL || solAmounts[i] > MAX_SOL) {
        adjusted = true;
      }
    }

    if (adjusted) {
      solAmounts = solAmounts.map((a) =>
        Math.min(MAX_SOL, Math.max(MIN_SOL, a))
      );
      const cappedSum = solAmounts.reduce((a, b) => a + b, 0);
      const scale = totalToDistribute / cappedSum;
      solAmounts = solAmounts.map((a) => Number((a * scale).toFixed(6)));
    }

    const finalSum = solAmounts.reduce((a, b) => a + b, 0);
    console.log(
      `[VOLUME BOT] Final total to distribute: ${finalSum.toFixed(6)} SOL`
    );

    // --- 5. Create wallets & transfer instructions ---
    for (let i = 0; i < distritbutionNum; i++) {
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

      console.log(
        `[VOLUME BOT] Wallet ${wallet.publicKey.toBase58()} gets ${solAmounts[
          i
        ].toFixed(6)} SOL`
      );
    }

    // --- 6. Save wallet data ---
    wallets.forEach((wallet) => {
      data.push({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
      });
    });

    try {
      saveDataToFile(data);
    } catch (error) {
      console.log("[VOLUME BOT] DistributeSol tx error", error);
    }

    // --- 7. Build & send transaction ---
    try {
      const latestBlockhash = await connection.getLatestBlockhash();
      const messageV0 = new TransactionMessage({
        payerKey: mainKp.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: sendSolTx,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([mainKp]);

      // Simulate before send
      const simulateResult = await connection.simulateTransaction(transaction, { sigVerify: true });
      if (simulateResult.value.err) {
        console.log("[VOLUME BOT] Simulation failed");
        console.log("Error:", simulateResult.value.err);
        return null;
      }

      let txSig;
      if (JITO_MODE) {
        txSig = await executeJitoTx([transaction], mainKp, jitoCommitment);
      } else {
        txSig = await execute(transaction, latestBlockhash, 1);
      }

      if (txSig) {
        console.log(`[VOLUME BOT] SOL distributed: https://solscan.io/tx/${txSig}`);
      }
    } catch (error) {
      console.log("[VOLUME BOT] Distribution error", error);
      return null;
    }

    console.log("[VOLUME BOT] ✅ Success in distribution");
    return wallets;
  } catch (error) {
    console.log("[VOLUME BOT] ❌ Failed to transfer SOL", error);
    return null;
  }
};

const transferAllSolFromWallets = async (
  connection: Connection,
  walletsFromStep1: { privateKey: string; pubkey: string }[]
) => {
  console.log(`[STEP 2] Starting second-round transfers for ${walletsFromStep1.length} wallets...`);

  const destinationWallets: { kp: Keypair; pubkey: string }[] = [];
  const results: { from: string; to: string; txSig?: string }[] = [];

  // 1. Generate new 100 destination wallets
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
      const balanceLamports = await connection.getBalance(srcPubkey);
      const balanceSol = balanceLamports / SOL_DECIMALS;

      if (balanceSol <= FEE_BUFFER) {
        console.log(`[SKIP] Wallet ${srcPubkey.toBase58()} has no SOL to send.`);
        continue;
      }

      // Calculate amount to send (leave a tiny buffer)
      const sendAmount = Math.max(balanceSol - FEE_BUFFER, 0);
      const lamportsToSend = Math.floor(sendAmount * SOL_DECIMALS);

      // Build transaction
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: srcPubkey,
          toPubkey: destPubkey,
          lamports: lamportsToSend,
        }),
      );

      tx.feePayer = srcPubkey;
      const latestBlockhash = await connection.getLatestBlockhash();
      tx.recentBlockhash = latestBlockhash.blockhash;

      // Sign and send
      const txSig = await sendAndConfirmTransaction(connection, tx, [srcKp], {
        commitment: "confirmed",
      });

      console.log(
        `[STEP 2] ✅ Sent ${sendAmount.toFixed(6)} SOL from ${srcPubkey.toBase58()} → ${destPubkey.toBase58()}`
      );

      results.push({ from: srcPubkey.toBase58(), to: destPubkey.toBase58(), txSig });
    } catch (err) {
      console.log(`[STEP 2] ❌ Error sending from ${srcInfo.pubkey}`);
      console.error(err);
    }
  }

  console.log(`[STEP 2] ✅ Finished transferring from all wallets.`);
  return { destinationWallets, results };
};

const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number) => {
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
    console.log("Buy transaction error")
    await sleep(1000)
    return null
  }
}

const sell = async (baseMint: PublicKey, wallet: Keypair) => {
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
      let sellTx = await makeSellPumpfunTokenTx(wallet, baseMint)

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
  kp: Keypair;
  buyAmount?: number;
};

 async function runVolumeBot(data: WalletRecord[], baseMint: PublicKey) {
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

      data.map(async ({ kp }, n) => {
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
    const totalBuyAmountForThisCycle = calculateCycleBuyAmount(selectedWallets, percentages);

    // Loop through each selected wallet and perform buy operation
    for (let i = 0; i < activeWalletsCount; i++) {
      const walletRec = selectedWallets[i];
      const buyAmount = totalBuyAmountForThisCycle[i];

      try {
        console.log(`[MARKET MAKER] Wallet ${i + 1} buying ${buyAmount} units`);

        await buy(walletRec.kp, baseMint, buyAmount )

        // Perform the actual buy operation here (e.g., calling the buy method)
        // Example:
        // await buyOperation(walletRec.kp, buyAmount);

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
function calculateCycleBuyAmount(wallets: WalletRecord[], percentages: number[]): number[] {
  const amounts: any = [];
  let totalAmount = 0;

  // Calculate the total available amount to be bought from all selected wallets
  wallets.forEach(wallet => {
    totalAmount += wallet.buyAmount ?? 0; // Assuming wallet.balance gives the available token amount
  });

  // Now calculate the buy amount for each wallet based on the randomly generated percentages
  wallets.forEach((wallet, index) => {
    const buyAmount = (wallet.buyAmount ?? 0 * (percentages[index] / 100)); // Calculate percentage of wallet balance
    amounts.push(buyAmount);
  });

  return amounts;
}

// Big Trade Bot - with dynamic buy/sell wallet selection and random differences
export async function runBigTradeBot(wallets: WalletRecord[], totalTimeMinutes: number) {
  console.log(`[BIG TRADE] Starting with ${wallets.length} wallets`);

  // Calculate total number of cycles for the given time period
  const totalCycles = totalTimeMinutes * 60; // Number of cycles per minute
  let cycleCount = 0;

  // Start with all wallets in buyAvailableWalletList (no wallets have been sold yet)
  let buyAvailableWalletList = [...wallets];
  let sellAvailableWalletList: WalletRecord[] = []; // Initially no wallets are available to sell

  while (cycleCount < totalCycles) {
    cycleCount++;

    // If there are no wallets left to buy, use the remaining wallets for the final buy
    if (buyAvailableWalletList.length === 0) {
      // All wallets are bought, no need to continue
      console.log("[BIG TRADE] No wallets left to buy. Finalizing.");
      break;
    }

    // Randomize the number of wallets to buy from and sell to, ensuring a big difference
    const walletsToBuyCount = Math.floor(Math.random() * (buyAvailableWalletList.length / 2)) + 1; // Random number between 1 and buyAvailableWalletList.length / 2
    const walletsToSellCount = Math.floor(Math.random() * (sellAvailableWalletList.length / 2)) + 1; // Random number between 1 and sellAvailableWalletList.length / 2

    // Ensure that there are enough wallets to buy and sell
    if (walletsToBuyCount <= walletsToSellCount) {
      continue; // Skip if the buy wallets are less than or equal to sell wallets
    }

    // Randomly select wallets for buy and sell operations
    const buyWallets = selectRandomWallets(buyAvailableWalletList, walletsToBuyCount);
    const sellWallets = selectRandomWallets(sellAvailableWalletList, walletsToSellCount);

    // Perform the big buy and sell operations
    for (const walletRec of buyWallets) {
      try {
        // Get the available buy amount (if not defined, assume full balance)
        const buyAmount = walletRec.buyAmount || 0; // If buyAmount is undefined, assume the full balance
        await performBigBuy(walletRec); // 100% buy amount
        console.log(`[BIG BUY] Wallet ${walletRec.kp.publicKey} bought ${buyAmount} tokens.`);

        // Once a wallet has been bought, it becomes available to sell in future cycles
        sellAvailableWalletList.push(walletRec);
      } catch (err) {
        console.error("[BIG TRADE] Wallet error during buy", err);
      }
      await sleep(2000); // Random pause between buy actions
    }

    for (const walletRec of sellWallets) {
      try {
        // Get the available sell amount (assuming full balance for selling)
        await performBigSell(walletRec); // 100% sell amount
        console.log(`[BIG SELL] Wallet ${walletRec.kp.publicKey} sold tokens.`);
      } catch (err) {
        console.error("[BIG TRADE] Wallet error during sell", err);
      }
      await sleep(2000); // Random pause between sell actions
    }

    // Remove the wallets that were bought from the buy list (they are now in the sell list)
    buyAvailableWalletList = buyAvailableWalletList.filter(wallet => !buyWallets.includes(wallet));

    // If all wallets have been used (bought and sold), stop the process
    if (buyAvailableWalletList.length === 0 && sellAvailableWalletList.length === 0) {
      console.log("[BIG TRADE] All wallets have been used.");
      break;
    }

    // Random cycle delay between actions
    const cycleDelay = Math.floor(Math.random() * 15000) + 5000; // Random delay between 5-20 seconds
    console.log(`[BIG TRADE] Waiting for ${cycleDelay / 1000} seconds before next cycle...`);
    await sleep(cycleDelay); // Sleep before next big trade cycle
    console.log(`[BIG TRADE] Cycle ${cycleCount}/${totalCycles} complete.`);
  }

  // Final buy step: if there are remaining wallets to buy, buy from them
  if (buyAvailableWalletList.length > 0) {
    console.log("[BIG TRADE] Finalizing: Buying from all remaining wallets.");
    for (const walletRec of buyAvailableWalletList) {
      try {
        const buyAmount = walletRec.buyAmount || 0;
        await performBigBuy(walletRec); // 100% buy amount
        console.log(`[BIG BUY] Wallet ${walletRec.kp.publicKey} bought ${buyAmount} tokens.`);

        // Once a wallet has been bought, it becomes available to sell in future cycles
        sellAvailableWalletList.push(walletRec);
      } catch (err) {
        console.error("[BIG TRADE] Wallet error during final buy", err);
      }
      await sleep(2000); // Random pause between buy actions
    }
  }

  console.log("[BIG TRADE] Big trade operation complete.");
}


// Simulate a "big buy" operation (buyAmount is in the WalletRecord)
async function performBigBuy(walletRec: WalletRecord) {
  console.log(`[BIG BUY] Wallet ${walletRec.kp.publicKey} is buying tokens`);

  let balanceLamports = await solanaConnection.getBalance(walletRec.kp.publicKey)

  const balanceSol = balanceLamports / 1e9;

  const tokenPrice = await getTokenPrice(baseMint.toBase58())

  const buyAmount = (balanceSol - 0.05) / tokenPrice

  let result  = await buy(walletRec.kp, baseMint, buyAmount)

  // Perform the actual buy operation (place your logic here)
  await sleep(500); // Simulate the time taken for the buy operation
}

// Simulate a "big sell" operation (buyAmount is in the WalletRecord)
async function performBigSell(walletRec: WalletRecord) {
  console.log(`[BIG SELL] Wallet ${walletRec.kp.publicKey} is selling tokens`);

  let result  = await sell(baseMint, walletRec.kp)
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


main()