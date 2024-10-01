import * as dotenv from 'dotenv'
import { TokenSafetyStatus } from './PoolValidator/ValidationResult'
dotenv.config()

const SAFE_VALOTILITY_RATE = 1.0

interface Config {
  rpcHttpURL: string,
  rpcWsURL: string,
  simulateOnly: boolean,
  safePriceValotilityRate: number,
  safeBuysCountInFirstMinute: number,
  allowedTradingSafety: Set<TokenSafetyStatus>,
  walletPublic: string,
  walletPrivate: string,
  dumpTradingHistoryToFile: boolean,
  validatorsLimit: number,
  appPort: number,
  buySOLAmount: number | null,
  backupRpcUrl: string | null,
  backupWsRpcUrl: string | null
}

export let config: Config = {
  rpcHttpURL: process.env.RPC_URL!,
  rpcWsURL: process.env.WS_URL!,
  simulateOnly: process.env.SIMULATION_ONLY === 'true',
  safePriceValotilityRate: process.env.SAFE_PRICE_VALOTILITY_RATE ? Number(process.env.SAFE_PRICE_VALOTILITY_RATE) : SAFE_VALOTILITY_RATE,
  safeBuysCountInFirstMinute: process.env.SAFE_BUYS_COUNT_IN_FIRST_MINUTE ? Number(process.env.SAFE_BUYS_COUNT_IN_FIRST_MINUTE) : 40,
  allowedTradingSafety: new Set(['GREEN', 'YELLOW']),
  walletPublic: process.env.WALLET_PUBLIC_KEY!,
  walletPrivate: process.env.WALLET_PRIVATE_KEY!,
  dumpTradingHistoryToFile: process.env.DUMP_HISTORY_TRADING_RECORDS_TO_FILE === 'true',
  validatorsLimit: Number(process.env.VALIDATORS_LIMIT!),
  appPort: process.env.APP_PORT ? Number(process.env.APP_PORT) : 3000,
  buySOLAmount: process.env.BUY_SOL_AMOUNT ? Number(process.env.BUY_SOL_AMOUNT) : null,
  backupRpcUrl: process.env.BACKUP_RPC_URL ?? null,
  backupWsRpcUrl: process.env.BACKUP_WS_URL ?? null
}