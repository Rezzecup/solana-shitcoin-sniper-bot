import { TokenSafetyStatus } from '../PoolValidator/ValidationResult'
import { GeneralTokenCondition } from '../Swap'
import { LiquidityPoolKeysV4, Token, TokenAmount, WSOL } from '@raydium-io/raydium-sdk'
import { SOL_SPL_TOKEN_ADDRESS, PAYER, OWNER_ADDRESS } from "./Addresses"
import { DANGEROUS_EXIT_STRATEGY, ExitStrategy, SAFE_EXIT_STRATEGY, TURBO_EXIT_STRATEGY } from './ExitStrategy'
import { formatDate } from '../Utils'
import { buyToken } from './BuyToken'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { SellResults, sellToken } from './SellToken'
import { Connection } from '@solana/web3.js'
import { onBuyResults } from '../StateAggregator/ConsoleOutput'
import { config } from '../Config'
import chalk from 'chalk'

export type TraderResults = {
  boughtAmountInSOL: number | null,
  buyingTokenCondition: GeneralTokenCondition | null,
  soldForAmountInSOL: number | null,
  pnl: number | null,
  error: string | null
}

// module.exports = async (data: PoolValidationResults) => {
//   const sellResults = await tryPerformTrading(data)
//   return sellResults
// }

export async function tryPerformTrading(connection: Connection, pool: LiquidityPoolKeysV4, safetyStatus: TokenSafetyStatus): Promise<SellResults> {
  if (safetyStatus === 'RED') {
    console.error('RED token comes to trader. Skipping')
    return { kind: 'FAILED', reason: 'RED coin', txId: null, boughtForSol: null, buyTime: null }
  }

  let tokenAMint = pool.baseMint.toString() === WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBMint = pool.baseMint.toString() !== WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBDecimals = pool.baseMint.toString() === tokenBMint.toString() ? pool.baseDecimals : pool.quoteDecimals;
  const tokenBToken = new Token(TOKEN_PROGRAM_ID, tokenBMint, tokenBDecimals)
  const tokenBAccountAddress = getAssociatedTokenAddressSync(tokenBMint, OWNER_ADDRESS, false);


  if (pool.quoteMint.toString() !== WSOL.mint && pool.baseMint.toString() !== WSOL.mint) {
    return { kind: 'FAILED', reason: 'No SOL in pair', txId: null, boughtForSol: null, buyTime: null }
  }

  const buyAmount = getBuyAmountInSOL(safetyStatus)!
  const exitStrategy = getExitStrategy(safetyStatus)!

  const buyResult = await buyToken(connection, PAYER, buyAmount, tokenBToken, tokenBAccountAddress, pool, SOL_SPL_TOKEN_ADDRESS)

  if (safetyStatus !== 'TURBO') {
    onBuyResults(pool.id.toString(), buyResult)
  }

  const buyDate = new Date()

  if (buyResult.kind !== 'SUCCESS') {
    //TODO: Handle errors
    return { kind: 'FAILED', reason: `Buy transaction failed`, txId: null, buyTime: formatDate(buyDate), boughtForSol: null }
  }

  const amountToSell = new TokenAmount(tokenBToken, buyResult.newTokenAmount, false)
  let sellResults = await sellToken(
    connection,
    buyAmount,
    amountToSell,
    pool,
    SOL_SPL_TOKEN_ADDRESS,
    tokenBAccountAddress,
    exitStrategy)
  sellResults.buyTime = formatDate(buyDate)
  return sellResults
}

export async function instaBuyAndSell(connection: Connection, pool: LiquidityPoolKeysV4, solAmount: number): Promise<SellResults> {
  let tokenAMint = pool.baseMint.toString() === WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBMint = pool.baseMint.toString() !== WSOL.mint ? pool.baseMint : pool.quoteMint;
  let tokenBDecimals = pool.baseMint.toString() === tokenBMint.toString() ? pool.baseDecimals : pool.quoteDecimals;
  const tokenBToken = new Token(TOKEN_PROGRAM_ID, tokenBMint, tokenBDecimals)
  const tokenBAccountAddress = getAssociatedTokenAddressSync(tokenBMint, OWNER_ADDRESS, false);


  if (pool.quoteMint.toString() !== WSOL.mint && pool.baseMint.toString() !== WSOL.mint) {
    return { kind: 'FAILED', reason: 'No SOL in pair', txId: null, boughtForSol: null, buyTime: null }
  }

  const buyAmount = solAmount
  const buyResult = await buyToken(connection, PAYER, buyAmount, tokenBToken, tokenBAccountAddress, pool, SOL_SPL_TOKEN_ADDRESS)
  const buyDate = new Date()

  if (buyResult.kind !== 'SUCCESS') {
    //TODO: Handle errors
    return { kind: 'FAILED', reason: `Buy transaction failed`, txId: null, buyTime: formatDate(buyDate), boughtForSol: null }
  }

  const amountToSell = new TokenAmount(tokenBToken, buyResult.newTokenAmount, false)
  const exitStrategy: ExitStrategy = {
    exitTimeoutInMillis: 500,
    targetProfit: 1,
    profitCalcIterationDelayMillis: 100,
  }
  let sellResults = await sellToken(
    connection,
    buyAmount,
    amountToSell,
    pool,
    SOL_SPL_TOKEN_ADDRESS,
    tokenBAccountAddress,
    exitStrategy)
  sellResults.buyTime = formatDate(buyDate)
  return sellResults
}


function getBuyAmountInSOL(tokenStatus: TokenSafetyStatus): number | null {
  if (config.buySOLAmount) {
    return config.buySOLAmount
  }
  switch (tokenStatus) {
    case 'RED': return null
    case 'YELLOW': return 0.2
    case 'GREEN': return 0.3
    case 'TURBO': return 0.1
  }
}

function getExitStrategy(tokenStatus: TokenSafetyStatus): ExitStrategy | null {
  switch (tokenStatus) {
    case 'RED': return null
    case 'YELLOW': return DANGEROUS_EXIT_STRATEGY
    case 'GREEN': return SAFE_EXIT_STRATEGY
    case 'TURBO': return TURBO_EXIT_STRATEGY
  }
}

