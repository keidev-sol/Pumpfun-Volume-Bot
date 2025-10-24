import { Keypair, PublicKey } from "@solana/web3.js"
import { retrieveEnvVariable } from "../utils"
import dotenv from 'dotenv';
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PumpFun } from "../contract/pumpfun-new";
import PumpfunIDL from '../contract/pumpfun-new.json';
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { solanaConnection } from "..";
import { PumpAmm } from "../contract/pumpswap";
import PumpswapIDL from '../contract/pumpswap.json';


dotenv.config();


export const PRIVATE_KEY = process.env.PRIVATE_KEY || ""
export const RPC_ENDPOINT = process.env.RPC_ENDPOINT || ""
export const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT

export const DISTRIBUTE_INTERVAL_MAX = Number(process.env.DISTRIBUTE_INTERVAL_MAX)
export const DISTRIBUTE_INTERVAL_MIN = Number(process.env.DISTRIBUTE_INTERVAL_MIN)

export const BUY_UPPER_PERCENT = Number(process.env.BUY_UPPER_PERCENT)
export const BUY_LOWER_PERCENT = Number(process.env.BUY_LOWER_PERCENT)

export const BUY_INTERVAL_MIN = Number(process.env.BUY_INTERVAL_MIN)
export const BUY_INTERVAL_MAX = Number(process.env.BUY_INTERVAL_MAX)

export const SELL_INTERVAL_MIN = Number(process.env.SELL_INTERVAL_MIN)
export const SELL_INTERVAL_MAX = Number(process.env.SELL_INTERVAL_MAX)

export const DISTRIBUTE_WALLET_NUM = Number(process.env.DISTRIBUTE_WALLET_NUM)
// export const SOL_AMOUNT_TO_DISTRIBUTE = Number(process.env.SOL_AMOUNT_TO_DISTRIBUTE)

export const JITO_MODE = process.env.JITO_MODE === 'true'
export const JITO_FEE = Number(process.env.JITO_FEE)

export const SLIPPAGE = Number(process.env.SLIPPAGE)

export const FEE_LEVEL = Number(process.env.FEE_LEVEL)

export const TOKEN_MINT = process.env.TOKEN_MINT


export const AIRDROP_ADDRESS = process.env.AIRDROP_ADDRESS


// gather part
export const GATHER_ADDRESS = process.env.GATHER_ADDRESS || ""
export const GATHER_TO_OTHER_ADDRESS = process.env.GATHER_TO_OTHER_ADDRESS


export const FEE_RECIPIENT = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV")
export const GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw")
export const Target_MINT = process.env.TOKEN_MINT || ""

export const SOL_DECIMALS = 10 ** 9;
export const MIN_SOL = 0.005;
export const MAX_SOL = 0.1;
export const FEE_BUFFER = 0.005; // keep 0.5 SOL in main wallet for safety

export const BIRDEYE_KEY = process.env.BIRDEYE_KEY

export const BONDING_CURVE_SEED = "bonding-curve";

export const provider = new AnchorProvider(solanaConnection, new NodeWallet(Keypair.generate()));
export const PumpfunProgram = new Program<PumpFun>(PumpfunIDL as PumpFun, provider);
export const PumpswapProgram = new Program<PumpAmm>(PumpswapIDL as PumpAmm, provider);