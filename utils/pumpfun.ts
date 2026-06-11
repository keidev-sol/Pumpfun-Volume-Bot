import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress, getAssociatedTokenAddressSync, getMint, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js"
import PumpfunIDL from '../contract/pumpfun-idl.json'
import { Pump } from '../contract/pumpfun-types'
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { BN } from "bn.js";
import { FEE_RECIPIENT, Target_MINT, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, GLOBAL_CONFIG, PumpswapProgram, SLIPPAGE, FEE_LEVEL } from "../constants";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { BondingCurveAccount } from "./bondingCurveAccount";
import { getPumpswapPoolId } from "./utils";
import { OnlinePumpSdk, PumpSdk, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment: "confirmed"
})
const provider = new AnchorProvider(solanaConnection, new NodeWallet(Keypair.generate()))
export const PumpfunProgram = new Program<Pump>(PumpfunIDL as Pump, provider);

// Official Pump.fun SDK — keeps buy/sell in sync with the live program
// (Token-2022 mints, buyback fee recipients, mayhem mode, etc.).
const onlinePumpSdk = new OnlinePumpSdk(solanaConnection);
const pumpSdk = new PumpSdk();

// Pump.fun now issues both legacy SPL and Token-2022 mints. The correct token
// program is whatever owns the mint account; using the wrong one makes every
// associated-token-account / trade instruction fail with IncorrectProgramId.
const getMintTokenProgram = async (mint: PublicKey): Promise<PublicKey> => {
  const info = await solanaConnection.getAccountInfo(mint);
  return info?.owner ?? TOKEN_PROGRAM_ID;
};

// Slippage is configured as a percent (env SLIPPAGE). Fall back to a tolerant
// default so volume trades reliably land.
const slippagePercent = Number.isFinite(SLIPPAGE) && SLIPPAGE > 0 ? SLIPPAGE : 50;

const buildSignedTx = async (
  signer: Keypair,
  instructions: TransactionInstruction[]
): Promise<VersionedTransaction> => {
  const priorityIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.max(1, Math.floor((Number.isFinite(FEE_LEVEL) ? FEE_LEVEL : 10) * 20_000)),
    }),
  ];
  const blockhash = (await solanaConnection.getLatestBlockhash()).blockhash;
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...priorityIxs, ...instructions],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);
  return tx;
};

// Build a signed Pump.fun bonding-curve BUY transaction.
// `amount` is the amount of SOL to spend, in lamports.
export const makeBuyPumpfunTokenTx = async (mainKp: Keypair, mint: PublicKey, amount: number) => {
  try {
    const tokenProgram = await getMintTokenProgram(mint);
    const solAmount = new BN(Math.floor(amount));

    const [global, feeConfig, buyState, mintAccount] = await Promise.all([
      onlinePumpSdk.fetchGlobal(),
      onlinePumpSdk.fetchFeeConfig(),
      onlinePumpSdk.fetchBuyState(mint, mainKp.publicKey, tokenProgram),
      getMint(solanaConnection, mint, "confirmed", tokenProgram),
    ]);

    // Expected token amount out for the given SOL input (used as the order size;
    // `slippage` protects the actual cost).
    const tokenAmount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: new BN(mintAccount.supply.toString()),
      bondingCurve: buyState.bondingCurve,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    });
    if (tokenAmount.lten(0)) {
      console.log("Buy amount too small, skipping");
      return null;
    }

    const instructions = await pumpSdk.buyInstructions({
      global,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: buyState.bondingCurve,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint,
      user: mainKp.publicKey,
      amount: tokenAmount,
      solAmount,
      slippage: slippagePercent,
      tokenProgram,
    });

    return await buildSignedTx(mainKp, instructions);
  } catch (error) {
    console.log("Error while making buy transaction in pumpfun", error)
    return null
  }
}

// Build a signed Pump.fun bonding-curve SELL transaction.
// `sellAmount` is the raw token amount to sell; when omitted the whole balance is sold.
export const makeSellPumpfunTokenTx = async (mainKp: Keypair, mint: PublicKey, sellAmount?: number) => {
  try {
    const tokenProgram = await getMintTokenProgram(mint);
    const associatedUser = getAssociatedTokenAddressSync(mint, mainKp.publicKey, true, tokenProgram);
    const balance = await solanaConnection.getTokenAccountBalance(associatedUser);

    const amount = new BN(sellAmount ? Math.floor(sellAmount) : balance.value.amount);
    if (amount.lten(0)) {
      console.log("Nothing to sell (zero token balance)");
      return null;
    }

    const [global, feeConfig, sellState, mintAccount] = await Promise.all([
      onlinePumpSdk.fetchGlobal(),
      onlinePumpSdk.fetchFeeConfig(),
      onlinePumpSdk.fetchSellState(mint, mainKp.publicKey, tokenProgram),
      getMint(solanaConnection, mint, "confirmed", tokenProgram),
    ]);

    // Expected SOL out for the token amount; `slippage` enforces the minimum.
    const solAmount = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: new BN(mintAccount.supply.toString()),
      bondingCurve: sellState.bondingCurve,
      amount,
    });

    const instructions = await pumpSdk.sellInstructions({
      global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
      mint,
      user: mainKp.publicKey,
      amount,
      solAmount,
      slippage: slippagePercent,
      tokenProgram,
      mayhemMode: Boolean((sellState.bondingCurve as any).isMayhemMode),
    });

    return await buildSignedTx(mainKp, instructions);
  } catch (error) {
    console.log("Error while making sell transaction in pumpfun", error)
    return null
  }
}

export const makeMigrateTx = async (mainKp: Keypair, mint: PublicKey) => {
  try {
    const migrateIx = await PumpfunProgram.methods
      .migrate()
      .accounts({
        mint,
        program: TOKEN_PROGRAM_ID,
        user: mainKp.publicKey
      })
      .instruction()

    const blockhash = (await solanaConnection.getLatestBlockhash()).blockhash

    const msg = new TransactionMessage({
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        migrateIx
      ],
      payerKey: mainKp.publicKey,
      recentBlockhash: blockhash
    }).compileToV0Message()

    const migrateTx = new VersionedTransaction(msg)
    migrateTx.sign([mainKp])

    // console.log(await solanaConnection.simulateTransaction(migrateTx, { sigVerify: true }))
    return migrateTx
  } catch (error) {
    console.log("Error while making migration transaction in pumpfun")
    return null
  }
}


const getBondingCurveAccount = async (
    connection: Connection,
    mint: PublicKey
  ) => {
    const pool = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      PumpfunProgram.programId
    )[0]
    const tokenAccount = await connection.getAccountInfo(
      pool,
      "confirmed"
    );
    if (!tokenAccount) {
      return null;
    }
    return BondingCurveAccount.fromBuffer(tokenAccount!.data);
  }

  export const makeSellPumpswapTokenTxMarketMaker = async (mainKp: Keypair, mint: PublicKey, sellPercent: number) => {
    try {
      
      const associatedUser = getAssociatedTokenAddressSync(mint, mainKp.publicKey);
      const associatedUserSol = getAssociatedTokenAddressSync(NATIVE_MINT, mainKp.publicKey);
      const balance = await solanaConnection.getTokenAccountBalance(associatedUser);
  
      const keypair = mainKp;
      const userQuoteTokenAccount = await getAssociatedTokenAddress(NATIVE_MINT, keypair.publicKey);
      const userBaseTokenAccount = await getAssociatedTokenAddress(mint, keypair.publicKey);
  
      const PROTOCOL_FEE_RECIPIENT = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV")
  
      const pool = getPumpswapPoolId(mint)
      const sellIx = await PumpswapProgram.methods
        .sell(new BN(Math.round(Number(balance.value.amount) * (sellPercent / 100))), new BN(0))
        .accounts({
          user: mainKp.publicKey,
          userBaseTokenAccount,
          userQuoteTokenAccount,
          baseTokenProgram: TOKEN_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          globalConfig: GLOBAL_CONFIG,
          pool: new PublicKey(pool),
          protocolFeeRecipient: PROTOCOL_FEE_RECIPIENT
          })
          .instruction()
  
      const blockhash = (await solanaConnection.getLatestBlockhash()).blockhash
  
      const msg = new TransactionMessage({
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1000_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000_000 }),
          createAssociatedTokenAccountIdempotentInstruction(mainKp.publicKey, associatedUserSol, mainKp.publicKey, NATIVE_MINT),
          sellIx
        ],
        payerKey: mainKp.publicKey,
        recentBlockhash: blockhash
      }).compileToV0Message()
  
      const buyVTx = new VersionedTransaction(msg)
      buyVTx.sign([mainKp])
  
      return buyVTx
    } catch (error) {
      console.log("Error while making buy transaction in pumpfun")
      return null
    }
  }