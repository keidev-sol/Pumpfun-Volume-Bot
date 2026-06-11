/**
 * Dry-run verifier for the Pump.fun buy/sell instructions.
 *
 * Builds a real BUY (and SELL, if your main wallet holds the token) transaction
 * with the same code the bot uses, then runs `simulateTransaction` against your
 * RPC. Nothing is broadcast and no funds are spent — it only confirms the
 * instructions are accepted by the live Pump.fun program.
 *
 *   npm run simulate                       # uses TOKEN_MINT from .env
 *   npm run simulate -- <MINT> <SOL>       # override mint / SOL amount
 */
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { solanaConnection, mainKp } from "./index";
import { TOKEN_MINT } from "./constants";
import { makeBuyPumpfunTokenTx, makeSellPumpfunTokenTx } from "./utils/pumpfun";

const argMint = process.argv[2] || TOKEN_MINT;
const solToSpend = Number(process.argv[3] || "0.001");

async function simulate(label: string, tx: Awaited<ReturnType<typeof makeBuyPumpfunTokenTx>>) {
  if (!tx) {
    console.log(`❌ ${label}: builder returned null (could not build the transaction)`);
    return;
  }
  const res = await solanaConnection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (res.value.err) {
    console.log(`❌ ${label}: program rejected ->`, JSON.stringify(res.value.err));
    (res.value.logs || []).slice(-8).forEach((l) => console.log("   " + l));
  } else {
    console.log(`✅ ${label}: simulation succeeded (units: ${res.value.unitsConsumed}). Safe to run live.`);
  }
}

(async () => {
  if (!argMint) {
    console.log("No token mint provided. Set TOKEN_MINT in .env or pass it as an argument.");
    return;
  }
  const mint = new PublicKey(argMint);
  console.log(`🔍 Simulating against mint ${mint.toBase58()}`);
  console.log(`   wallet: ${mainKp.publicKey.toBase58()}\n`);

  // BUY
  const buyLamports = Math.floor(solToSpend * 1e9);
  await simulate(`BUY (${solToSpend} SOL)`, await makeBuyPumpfunTokenTx(mainKp, mint, buyLamports));

  // SELL — only if the wallet currently holds the token
  const mintInfo = await solanaConnection.getAccountInfo(mint);
  const tokenProgram = mintInfo?.owner ?? TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(mint, mainKp.publicKey, true, tokenProgram);
  const bal = await solanaConnection.getTokenAccountBalance(ata).catch(() => null);
  if (bal && Number(bal.value.amount) > 0) {
    await simulate(`SELL (all ${bal.value.uiAmountString})`, await makeSellPumpfunTokenTx(mainKp, mint));
  } else {
    console.log("ℹ️  SELL skipped: wallet holds none of this token (buy some first to test selling).");
  }
})().catch((e) => console.log("Simulation error:", e.message));
