import { PoolFeatures, TokenSafetyStatus } from './ValidationResult'
import { PoolKeys, fetchPoolKeysForLPInitTransactionHash } from './RaydiumPoolParser'
import { Liquidity, LiquidityPoolInfo, LiquidityPoolKeysV4, LiquidityPoolStatus } from '@raydium-io/raydium-sdk'
import { PoolSafetyData, SafetyCheckResult } from './RaydiumSafetyCheck'
import { convertStringKeysToDataKeys, delay } from '../Utils'
import { Connection, PublicKey, TokenBalance } from '@solana/web3.js'
import { TradeRecord, fetchLatestTrades } from '../Trader/TradesFetcher'
import { TrendAnalisis, analyzeTrend, findDumpingRecord } from '../Trader/TradesAnalyzer'

export type ValidatePoolData = {
  mintTxId: string,
  date: Date,
}

// module.exports = async (data: ValidatePoolData) => {
//   console.log(`Receive message in validation worker. TxId: ${data.mintTxId}.`)
//   const validationResults = await validateNewPool(data.mintTxId)
//   console.log(`Finished validation in validation worker. TxId: ${data.mintTxId}.`)
//   return validationResults
// }

export type PoolPostponed = {
  kind: 'Postponed',
  parsed: ParsedPoolCreationTx,
  startTime: number // in epoch millis
}

export type PoolDisabled = {
  kind: 'Disabled',
  poolKeys: PoolKeys
}

export type PoolSafetyAssesed = {
  kind: 'Validated',
  poolKeys: PoolKeys,
  results: SafetyCheckResult
}

export type PoolValidationResults = PoolPostponed | PoolDisabled | PoolSafetyAssesed

export type ParsedPoolCreationTx = {
  binaryKeys: LiquidityPoolKeysV4,
  info: LiquidityPoolInfo,
  poolKeys: PoolKeys,
  creator: PublicKey,
  lpTokenMint: PublicKey
}

export type TradingInfo = {
  trades: TradeRecord[],
  dump: [TradeRecord, TradeRecord] | null,
  analysis: TrendAnalisis | null
}

export async function parsePoolCreationTx(connection: Connection, mintTxId: string)
  : Promise<ParsedPoolCreationTx> {
  const { poolKeys, mintTransaction } = await fetchPoolKeysForLPInitTransactionHash(connection, mintTxId) // With poolKeys you can do a swap  
  const binaryPoolKeys = convertStringKeysToDataKeys(poolKeys)
  const info = await tryParseLiquidityPoolInfo(connection, binaryPoolKeys)
  if (info === null) {
    throw Error(`Couldn't get LP info, perhaps RPC issues`)
  }

  if (!mintTransaction.meta || !mintTransaction.meta.innerInstructions || !mintTransaction.meta.preTokenBalances || !mintTransaction.meta.postTokenBalances) {
    throw Error(`Couldn't get creator address from initial pool tx ${mintTxId}`)
  }

  const firstInnerInstructionsSet = mintTransaction.meta.innerInstructions[0].instructions as any[]
  const creatorAddress = new PublicKey(firstInnerInstructionsSet[0].parsed.info.source)

  /// Find LP-token minted by providing liquidity to the pool
  /// Serves as a permission to remove liquidity
  const preBalanceTokens = reduceBalancesToTokensSet(mintTransaction.meta.preTokenBalances)
  const postBalanceTokens = reduceBalancesToTokensSet(mintTransaction.meta.postTokenBalances)
  let lpTokenMint: string | null = null
  for (let x of postBalanceTokens) {
    if (!preBalanceTokens.has(x)) {
      lpTokenMint = x
      break
    }
  }

  if (lpTokenMint === null) {
    /// NO LP tokens
    throw Error(`No LP tokens`)
  }

  return { binaryKeys: binaryPoolKeys, info, poolKeys, creator: creatorAddress, lpTokenMint: new PublicKey(lpTokenMint) }
}

export function checkIfPoolPostponed(parsed: ParsedPoolCreationTx): { parsed: ParsedPoolCreationTx, startTime: number | null } {
  const status = parsed.info.status.toNumber()
  if (status === LiquidityPoolStatus.WaitingForStart) {
    //if (Date.now() / 1000 < startTime.toNumber())
    const startTime = parsed.info.startTime.toNumber()
    return { parsed, startTime }
  }
  return { parsed, startTime: null }
}

export function checkIfSwapEnabled(parsed: ParsedPoolCreationTx): { parsed: ParsedPoolCreationTx, isEnabled: boolean } {
  const features: PoolFeatures = Liquidity.getEnabledFeatures(parsed.info)
  return { parsed, isEnabled: features.swap }
}

export function evaluateSafetyState(data: PoolSafetyData, isLiquidityLocked: boolean): { status: TokenSafetyStatus, data: PoolSafetyData, reason: string } {
  const MIN_PERCENT_NEW_TOKEN_INPOOL = 0.1
  const LOW_IN_USD = 500;
  const HIGH_IN_USD = 100000000;

  /// Check is liquidiity amount is too low r otoo high (both are suspicous)
  if (data.totalLiquidity.amountInUSD < LOW_IN_USD || data.totalLiquidity.amountInUSD > HIGH_IN_USD) {
    return {
      data,
      status: 'RED',
      reason: `Liquidity is too low or too high. ${data.totalLiquidity.amount} ${data.totalLiquidity.symbol}`
    }
  }

  if (!isLiquidityLocked) {
    /// If locked percent of liquidity is less then SAFE_LOCKED_LIQUIDITY_PERCENT
    /// most likely it will be rugged at any time, better to stay away
    return {
      data,
      status: 'RED',
      reason: `Liquidity is not locked`,
    }
  }

  if (data.newTokenPoolBalancePercent >= 0.99) {
    /// When almost all tokens in pool 
    if (data.ownershipInfo.isMintable) {
      /// When token is still mintable
      /// We can try to get some money out of it          
      return {
        data,
        status: 'YELLOW',
        reason: `Most of the tokens are in pool, but token is still mintable`
      }
    } else {
      /// When token is not mintable          
      return {
        data,
        status: 'GREEN',
        reason: `Liquidity is locked. Token is not mintable. Green light`,
      }
    }
  } else if (data.newTokenPoolBalancePercent >= MIN_PERCENT_NEW_TOKEN_INPOOL) {
    /// When at least MIN_PERCENT_NEW_TOKEN_INPOOL tokens in pool 
    if (!data.ownershipInfo.isMintable) {
      /// If token is not mintable          
      return {
        data,
        status: 'YELLOW',
        reason: `At least 80% of the tokens are in pool, and token is not mintable`,
      }
    } if (data.newTokenPoolBalancePercent >= 0.95) {
      /// If token is mintable, but should not be dumped fast (from my experience)          
      return {
        data,
        status: 'YELLOW',
        reason: `>95% of tokens are in pool, but token is still mintable`,
      }
    } else {
      /// Many tokens are not in pool and token is mintable. Could be dumped very fast.          
      return {
        data,
        status: 'RED',
        reason: `Many tokens are not in pool and token is mintable`,
      }
    }
  } else {
    /// Too much new tokens is not in pool. Could be dumped very fast.        
    return {
      data,
      status: 'RED',
      reason: `Less then ${MIN_PERCENT_NEW_TOKEN_INPOOL * 100}% of tokens are in pool.`,
    }
  }
}

export async function checkLatestTrades(connection: Connection, poolKeys: LiquidityPoolKeysV4): Promise<TradingInfo> {
  try {
    const latestTrades = await fetchLatestTrades(connection, poolKeys)
    const dumpRes = findDumpingRecord(latestTrades)
    if (dumpRes) {
      return { trades: latestTrades, dump: dumpRes, analysis: null }
    }
    const analysis = analyzeTrend(latestTrades)
    return { trades: latestTrades, dump: null, analysis: analysis }
  } catch (e) {
    console.error(`Pool ${poolKeys.id.toString()} error get trades:\n${e}`)
    return { trades: [], dump: null, analysis: null }
  }
}

export async function makeSwapPoolKeysAndGetInfo(connection: Connection, poolKeys: PoolKeys):
  Promise<{ poolKeys: LiquidityPoolKeysV4, poolInfo: LiquidityPoolInfo }> {
  const binaryPoolKeys = convertStringKeysToDataKeys(poolKeys)
  const info = await tryParseLiquidityPoolInfo(connection, binaryPoolKeys)
  return { poolKeys: binaryPoolKeys, poolInfo: info! }
}

async function tryParseLiquidityPoolInfo(connection: Connection, poolKeys: LiquidityPoolKeysV4, attempt: number = 1, maxAttempts: number = 5): Promise<LiquidityPoolInfo | null> {
  try {
    console.log(`Getting LP info attempt ${attempt}.`)
    const info = await Liquidity.fetchInfo({ connection: connection, poolKeys: poolKeys })
    if (info !== null) {
      console.log(`Successfully fetched LP info from attempt ${attempt}`)
      return info; // Return the transaction if it's not null
    } else if (attempt < maxAttempts) {
      console.log(`Fetching LP info attempt ${attempt} failed, retrying...`)
      await delay(200) // Wait for the specified delay
      return tryParseLiquidityPoolInfo(connection, poolKeys, attempt + 1, maxAttempts)
    } else {
      console.log('Max attempts of fetching LP info reached, returning null')
      return null; // Return null if max attempts are reached
    }
  } catch (error) {
    console.error(`Fetching LP info attempt ${attempt} failed with error: ${error}, retrying...`)
    if (attempt < maxAttempts) {
      await delay(200) // Wait for the specified delay // Wait for the specified delay before retrying
      return tryParseLiquidityPoolInfo(connection, poolKeys, attempt + 1, maxAttempts)
    } else {
      console.log('Max attempts of fetching LP info reached, returning null')
      return null; // Return null if max attempts are reached
    }
  }
}

function reduceBalancesToTokensSet(balances: TokenBalance[]): Set<string> {
  const result = new Set<string>()
  return balances.reduce((set, b) => {
    set.add(b.mint)
    return set
  }, result)
}