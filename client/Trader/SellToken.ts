import { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { ExitStrategy } from "./ExitStrategy";
import { LiquidityPoolKeysV4, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import { PAYER, WSOL_TOKEN } from "./Addresses";
import { swapTokens, waitForProfitOrTimeout } from "../Swap";
import { confirmTransaction, delay, formatDate, getTransactionConfirmation, retryAsyncFunction } from "../Utils";
import { config } from "../Config";

type SellSuccess = {
  kind: 'SUCCESS',
  txId: string,
  buyTime: string,
  sellTime: string,
  boughtForSol: number,
  soldForSOL: number,
  estimatedProfit: number,
  profit: number
}

type SellFailure = {
  kind: 'FAILED',
  buyTime: string | null,
  boughtForSol: number | null,
  txId: string | null,
  reason: string
}
export type SellResults = SellSuccess | SellFailure

export async function sellToken(
  connection: Connection,
  spentAmount: number,
  amountToSell: TokenAmount,
  pool: LiquidityPoolKeysV4,
  mainTokenAccountAddress: PublicKey,
  shitcoinAccountAddress: PublicKey,
  exitStrategy: ExitStrategy): Promise<SellResults> {
  const estimatedProfit = await waitForProfitOrTimeout(
    spentAmount,
    exitStrategy.targetProfit,
    connection,
    amountToSell,
    WSOL_TOKEN,
    pool,
    exitStrategy.profitCalcIterationDelayMillis,
    exitStrategy.exitTimeoutInMillis)

  let soldForSOLAmount: number = estimatedProfit.amountOut
  let finalProfit: number = estimatedProfit.profit
  if (config.simulateOnly) {
    const sellDate = new Date()
    return { kind: 'SUCCESS', txId: 'Simulation', soldForSOL: soldForSOLAmount, estimatedProfit: estimatedProfit.profit, profit: finalProfit, boughtForSol: spentAmount, sellTime: formatDate(sellDate), buyTime: '' }
  } else {
    let { confirmedTxId, error } = await sellAndConfirm(connection, pool, mainTokenAccountAddress, shitcoinAccountAddress, amountToSell)

    if (confirmedTxId === null) {
      const retryResults = await sellAndConfirm(connection, pool, mainTokenAccountAddress, shitcoinAccountAddress, amountToSell)
      confirmedTxId = retryResults.confirmedTxId
      error = retryResults.error
    }

    if (confirmedTxId === null) {
      return { kind: 'FAILED', txId: confirmedTxId, reason: error ?? 'Unknown', buyTime: '', boughtForSol: spentAmount }
    }

    const sellDate = new Date()

    soldForSOLAmount = await getSOLAmount(connection, confirmedTxId)
    finalProfit = (soldForSOLAmount - spentAmount) / spentAmount
    return { kind: 'SUCCESS', txId: confirmedTxId, soldForSOL: soldForSOLAmount, estimatedProfit: estimatedProfit.profit, profit: finalProfit, boughtForSol: spentAmount, sellTime: formatDate(sellDate), buyTime: '' }
  }
}


async function sellAndConfirm(
  connection: Connection,
  pool: LiquidityPoolKeysV4,
  mainTokenAccountAddress: PublicKey,
  shitcoinAccountAddress: PublicKey,
  amountToSell: TokenAmount): Promise<{ confirmedTxId: string | null, error: string | null }> {

  let signature = ''
  let txLanded = false
  let sellError = ''
  let attempt = 1
  while (!txLanded && attempt <= 20) {
    console.log(`Sell attempt ${attempt}`)
    try {
      signature = await swapTokens(connection,
        pool,
        shitcoinAccountAddress,
        mainTokenAccountAddress,
        PAYER,
        amountToSell)
      txLanded = await confirmTransaction(connection, signature)
    } catch (e) {
      console.error(`Failed to sell shitcoin with error ${e}. Retrying.`);
      sellError = JSON.stringify(e)
    }
    attempt += 1
  }

  // let transactionConfirmed = false
  // let confirmationError = ''
  // try {
  //   const transactionConfirmation = await retryAsyncFunction(getTransactionConfirmation, [connection, signature], 5, 300)
  //   if (transactionConfirmation.err) {
  //     confirmationError = `${transactionConfirmation.err}`
  //   } else {
  //     transactionConfirmed = true
  //   }
  // } catch (e) {
  //   confirmationError = `${e}`
  // }

  return { confirmedTxId: txLanded ? signature : null, error: txLanded ? null : sellError }
}

interface SPLTransferInfo {
  amount: string
  authority: string
  destination: string
  source: string
}

async function getSOLAmount(connection: Connection, sellTxId: string): Promise<number> {
  const parsedTx = await getParsedTxWithMeta(connection, sellTxId)
  if (parsedTx === null) {
    return 0
  }

  const inner = parsedTx.meta?.innerInstructions
  if (!inner) { return 0 }

  const splTransferPairs = inner.map(x => x.instructions.filter((a: any) => a.program === 'spl-token' && a.parsed.type === 'transfer'))
  const splTransferPair = splTransferPairs.find(x => x.length >= 2)

  if (splTransferPair) {
    const outInfo: SPLTransferInfo = (splTransferPair[1] as any).parsed.info
    const solAmount = Number(outInfo.amount) / (10 ** WSOL.decimals)
    return solAmount
  }
  return 0
}

async function getParsedTxWithMeta(connection: Connection, txId: string): Promise<ParsedTransactionWithMeta | null> {
  let result: ParsedTransactionWithMeta | null = null
  const maxAttempts = 5
  let attempt = 1
  while (attempt <= maxAttempts) {
    result = await connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0 })
    if (result !== null) {
      return result
    }
    await delay(500)
    attempt += 1
  }
  return result
}