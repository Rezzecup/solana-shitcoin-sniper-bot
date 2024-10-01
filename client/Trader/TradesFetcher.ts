import { PublicKey, ParsedTransactionWithMeta, Connection, ParsedAccountData } from '@solana/web3.js'
import { LiquidityPoolKeysV4, WSOL } from '@raydium-io/raydium-sdk'
import { PoolKeys } from '../PoolValidator/RaydiumPoolParser'
import path from 'path'
import fs from 'fs'
import { config } from '../Config'


export type TradeType = 'BUY' | 'SELL'

export interface TradeRecord {
  signature: string
  time: string
  epochTime: number
  type: TradeType
  tokenAmount: number
  solAmount: number
  usdAmount: number
  priceInSOL: number
  priceInUSD: number
}

interface SPLTransferInfo {
  amount: string
  authority: string
  destination: string
  source: string
}

export async function fetchLatestTrades(
  connection: Connection,
  poolKeys: LiquidityPoolKeysV4,
  tradesLimit: number | null = null
): Promise<TradeRecord[]> {
  const isTokenBase = poolKeys.quoteMint.toString() === WSOL.mint
  const tokenMintAddress = isTokenBase ? poolKeys.baseMint : poolKeys.quoteMint
  const tokenDecimals = isTokenBase ? poolKeys.baseDecimals : poolKeys.quoteDecimals
  const txs = await fetchAllTransactions(connection, new PublicKey(poolKeys.id), tradesLimit)
  const tradeRecords = await parseTradingData(poolKeys, txs, new PublicKey(tokenMintAddress), tokenDecimals)
  tradeRecords.sort((a, b) => a.epochTime - b.epochTime)
  if (config.dumpTradingHistoryToFile) {
    const startDumpingToFile = new Date()
    saveToCSV(poolKeys.id.toString(), tradeRecords)
    const endDumpingToFile = new Date()
    console.log(`Poole ${poolKeys.id}. Dumping to file took ${endDumpingToFile.getUTCSeconds() - startDumpingToFile.getUTCSeconds()}`)
  }
  return tradeRecords
}

async function fetchAllTransactions(connection: Connection, address: PublicKey, maxCount: number | null): Promise<ParsedTransactionWithMeta[]> {
  let results: ParsedTransactionWithMeta[] = []
  let hasMore = true
  const limit = 1000
  let beforeTx: string | undefined = undefined
  while (hasMore || (maxCount ? results.length < maxCount : true)) {
    const fetchedIds = await connection.getConfirmedSignaturesForAddress2(address, { limit: limit, before: beforeTx })
    if (fetchedIds.length === 0) { break }
    const filtered = fetchedIds.filter(x => !x.err)
    const tradesOrNull = await connection.getParsedTransactions(filtered.map(x => x.signature), { maxSupportedTransactionVersion: 0 })
    const trades: ParsedTransactionWithMeta[] = tradesOrNull.filter((transaction): transaction is ParsedTransactionWithMeta => transaction !== null);
    results.push(...trades)
    hasMore = fetchedIds.length === limit
    beforeTx = fetchedIds[fetchedIds.length - 1].signature
  }
  return results
}

async function parseTradingData(
  poolKeys: LiquidityPoolKeysV4,
  transactions: (ParsedTransactionWithMeta | null)[],
  tokenMint: PublicKey,
  tokenDecimals: number): Promise<TradeRecord[]> {
  let results: TradeRecord[] = []

  for (let txOrNull of transactions) {
    if (!txOrNull) { continue }

    const inner = txOrNull.meta?.innerInstructions
    if (!inner) { continue }

    const splTransferPairs = inner.map(x => x.instructions.filter((a: any) => a.program === 'spl-token'))
    const splTransferPair = splTransferPairs.find(x => x.length === 2)
    if (splTransferPair) {
      const inInfo: SPLTransferInfo = (splTransferPair[0] as any).parsed.info
      const outInfo: SPLTransferInfo = (splTransferPair[1] as any).parsed.info

      const quoteIsToken = poolKeys.quoteMint.toString() === tokenMint.toString()

      const isSelling = quoteIsToken ? inInfo.destination === poolKeys.quoteVault.toString() : inInfo.destination === poolKeys.baseVault.toString()  //userOtherTokenPostBalance < userOtherTokenPreBalance
      const txDate = new Date(0)
      txDate.setUTCSeconds(txOrNull.blockTime ?? 0)

      const shitAmount = Number(isSelling ? inInfo.amount : outInfo.amount) / (10 ** tokenDecimals) //Math.abs(userOtherTokenPostBalance - userOtherTokenPreBalance)
      const solAmount = Number(isSelling ? outInfo.amount : inInfo.amount) / (10 ** WSOL.decimals) //Math.abs(userSolPostBalance - userSolPreBalance)
      const priceInSOL = solAmount / shitAmount
      results.push({
        signature: txOrNull.transaction.signatures[0],
        time: formatTime(txDate),
        epochTime: txOrNull.blockTime ?? 0,
        type: isSelling ? 'SELL' : 'BUY',
        tokenAmount: shitAmount,
        solAmount,
        usdAmount: solAmount * 110,
        priceInSOL: priceInSOL,
        priceInUSD: priceInSOL * 110
      })
    }
  }

  return results
}

function formatTime(date: Date): string {
  // Get hours, minutes, and seconds from the date
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  // Format time as 'HH:MM:SS'
  return `${hours}:${minutes}:${seconds}`;
}

function saveToCSV(fileName: string, data: TradeRecord[]) {
  const titleKeys = Object.keys(data[0])
  const refinedData = []
  refinedData.push(titleKeys)
  data.forEach(item => {
    refinedData.push(Object.values(item))
  })

  let csvContent = ''

  let filePath = path.join(__dirname, `/trading_data/${fileName}.csv`)

  refinedData.forEach(row => {
    csvContent += row.join(',') + '\n'
  })

  if (fs.existsSync(filePath)) {
    fileName = path.join(__dirname, `/trading_data/${fileName}_1.csv`)
  }
  fs.writeFileSync(filePath, csvContent, {})
}