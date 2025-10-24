import { Keypair, PublicKey } from "@solana/web3.js";
import { distributeSol, runBigTradeBot, runMarketMakerBot, runVolumeBot, solanaConnection, transferAllSolFromWallets } from "."
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { PRIVATE_KEY } from "./constants";
import { readJson } from "./utils";

(async () => {
    try {
        const mainKp = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
        // distributeSol(solanaConnection, mainKp, 2)
        let data = readJson("wallet.json")
        // const baseMint = new PublicKey("BsZCwqFbudCH9rhyEzAsh3GUxkH9sM8Gt3exGU9xpump")
        // await runVolumeBot(data, baseMint)
        // await runMarketMakerBot(data, 10)
        await runBigTradeBot(data, 10)
    } catch (err) {
        console.log("error ==>", err)
    }
})()