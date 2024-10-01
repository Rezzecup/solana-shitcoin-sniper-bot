import { LiquidityPoolInfo } from "@raydium-io/raydium-sdk"
import { PoolKeys } from "./RaydiumPoolParser"
import { TrendAnalisis } from "../Trader/TradesAnalyzer"

export type PoolFeatures = {
  swap: boolean,
  addLiquidity: boolean,
  removeLiquidity: boolean,
}

// export type PoolValidationResults = {
//   pool: PoolKeys,
//   poolInfo: LiquidityPoolInfo,
//   poolFeatures: PoolFeatures,
//   safetyStatus: TokenSafetyStatus,
//   startTimeInEpoch: number | null,
//   trend: TrendAnalisis | null,
//   reason: string
// }

export type TokenSafetyStatus =
  'RED' // 100% scam will be rugged very fast
  | 'YELLOW' // 99% scam, but we probably have bewteen 1-5 minutes to get some profit
  | 'GREEN' // 100% SAFE, if we are early should be easy to get 100%-10000%
  | 'TURBO' // Attempt to quick buy and sell no matter if it's scam