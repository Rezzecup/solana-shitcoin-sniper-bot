import Table from 'cli-table3'
import { StateRecord, createStateRecord } from './StateTypes'
import { WSOL } from '@raydium-io/raydium-sdk'
import { formatDate } from '../Utils';
import { ParsedPoolCreationTx } from '../PoolValidator/RaydiumPoolValidator';
import { PoolSafetyData, SafetyCheckResult } from '../PoolValidator/RaydiumSafetyCheck';
import { TokenSafetyStatus } from '../PoolValidator/ValidationResult';
import { SellResults } from '../Trader/SellToken';
import { BuyResult } from '../Trader/BuyToken';
import { dbIsInited, getStateRecordByPoolId, upsertRecord } from './DbWriter'
import chalk from 'chalk';


///Color(+Reason) ID(First mint TX/PoolId)   StartTime		TokenId		Liquidity		Percent in Pool		Is Mintable	 Buy		Sell 		Profit

//let allRecordsByFirstMintTx = new Map<string, StateRecord>()

async function getOrMakeRecordByTxId(poolId: string): Promise<StateRecord> {
  const dbRecord = await getStateRecordByPoolId(poolId)
  return dbRecord ?? createStateRecord({ poolId, status: 'Just created' })
}


const table = new Table({
  head: ['Status', 'ID', 'Safety', 'Start Time', 'Token', 'Buy', 'Sell', 'Profit', 'Max Profit']
  , //colWidths: [100, 200]
})

// export function renderCurrentState() {
//   table.length = 0

//   for (const record of allRecordsByFirstMintTx.values()) {
//     const converted = recordToConsoleTable(record)
//     table.push(converted)
//   }

//   logUpdate(table.toString())
// }

function recordToConsoleTable(record: StateRecord): string[] {
  // let safetyStatus = '⚪\nUnknown'
  // case 'EQUILIBRIUM': return '🟢 Good' //'🟡 So So'
  //   case 'PUMPING': return '🟢 Good'
  //   case 'DUMPING': return '🔴 Bad'
  //   default: return '⚪ Unknown'

  let idStr = `Pool: https://solscan.io/address/${record.poolId}`

  let tokenStr = ''
  if (record.tokenId) {
    tokenStr = `https://solscan.io/token/${record.tokenId}`
  }

  return [
    record.status,
    idStr,
    record.safetyInfo ?? '⚪',
    record.startTime ?? '',
    tokenStr,
    record.buyInfo ?? '',
    record.safetyInfo ?? '',
    record.profit ?? '',
    `${record.maxProfit?.toFixed(2) ?? ''}`
  ]
}

//**** Pool creation + validation ****//

export async function onPoolDataParsed(parsed: ParsedPoolCreationTx, startTime: number | null, isEnabled: boolean) {
  const dbRecord = await getStateRecordByPoolId(parsed.poolKeys.id)
  if (dbRecord) { return }

  const tokenId = parsed.poolKeys.baseMint !== WSOL.mint ? parsed.poolKeys.baseMint : parsed.poolKeys.quoteMint;

  let status = ''
  let startDate: string | null = null
  if (startTime) {
    startDate = formatDate(new Date(startTime))
    status = `🟠\nPostponed to ${startDate}`
  } else if (!isEnabled) {
    status = `⚫\nSwap is Disabled`
  } else {
    status = `⚪\nParsed data and start valiidating`
  }

  const record = createStateRecord({ poolId: parsed.poolKeys.id, status: status })

  //allRecordsByFirstMintTx.set(parsed.poolKeys.id, { ...record, tokenId, startTime: startDate, status })
  await upsertRecord({ ...record, tokenId, startTime: startDate, status })
  //renderCurrentState()
}


export async function onPoolValidationChanged(results: SafetyCheckResult) {
  let poolId = ''
  let status = ''
  switch (results.kind) {
    case 'CreatorIsScammer': {
      poolId = results.pool.poolKeys.id
      status = `🔴\nSkipped because creator ${results.pool.creator.toString()} is in blacklist.`
      break
    }
    case 'WaitLPBurningTooLong': {
      poolId = results.data.poolKeys.id
      status = `🔴\n Skipped because it's postponed for too long.`
      break
    }
    case 'WaitLPBurning': {
      poolId = results.data.pool.id.toString()
      status = `🟠\n Waiting LP tokens to burn. LP mint ${results.lpTokenMint.toString()}`
      break
    }
    case 'Complete': {
      poolId = results.data.pool.id.toString()
      status = `🟠\n Received validation results, evaluating...`
      break
    }
  }

  const record = await getOrMakeRecordByTxId(poolId)
  const updated = {
    ...record,
    status,
  }
  // /allRecordsByFirstMintTx.set(poolId, updated)
  upsertRecord(updated)
  //renderCurrentState()
}

export async function onPoolValidationEvaluated(data: { status: TokenSafetyStatus, data: PoolSafetyData, reason: string }) {
  const record = await getOrMakeRecordByTxId(data.data.pool.id.toString())
  let tokenSafetyIndicator = ''
  switch (data.status) {
    case 'RED': {
      tokenSafetyIndicator = '🔴\n'
      break
    }
    case 'YELLOW': {
      tokenSafetyIndicator = '🟡\n'
      break
    }
    case 'GREEN': {
      tokenSafetyIndicator = '🟢\n'
      break
    }
  }
  tokenSafetyIndicator += data.reason

  const updated = {
    ...record,
    status: tokenSafetyIndicator,
  }
  //allRecordsByFirstMintTx.set(data.data.pool.id.toString(), updated)
  //renderCurrentState()
  upsertRecord(updated)
}
export async function onStartGettingTrades(data: { status: TokenSafetyStatus, data: PoolSafetyData, reason: string }) {
  const record = await getOrMakeRecordByTxId(data.data.pool.id.toString())
  const updated = {
    ...record,
    status: `${record.status}\nGetting trades txs`,
  }
  // allRecordsByFirstMintTx.set(data.data.pool.id.toString(), updated)
  // renderCurrentState()
  upsertRecord(updated)
}

export async function onTradesEvaluated(data: PoolSafetyData, status: string) {
  const record = await getOrMakeRecordByTxId(data.pool.id.toString())
  const updated = {
    ...record,
    status: `${record.status}\n${status}`,
  }
  // allRecordsByFirstMintTx.set(data.pool.id.toString(), updated)
  // renderCurrentState()
  upsertRecord(updated)
}

export async function onStartTrading(data: PoolSafetyData) {
  const record = await getOrMakeRecordByTxId(data.pool.id.toString())
  const updated = {
    ...record,
    buyInfo: 'started',
  }
  // allRecordsByFirstMintTx.set(data.pool.id.toString(), updated)
  // renderCurrentState()
  upsertRecord(updated)
}

export async function onFinishTrading(data: PoolSafetyData, results: SellResults) {
  const record = await getOrMakeRecordByTxId(data.pool.id.toString())
  let sellInfo = ''
  let buyInfo = ''
  let estimatedProfit = ''
  let finalProfit = ''

  switch (results.kind) {
    case 'FAILED': {
      if (results.boughtForSol) {
        sellInfo = `Lost ${results.boughtForSol}\n${results.reason}`
      } else {
        sellInfo = `Couldn't make trades\n${results.reason}`
      }
      break
    }
    case 'SUCCESS': {
      buyInfo = `at ${results.buyTime}`
      sellInfo = `Sell at ${results.sellTime}\nfor ${results.soldForSOL} SOL`
      estimatedProfit = 'Estimated PNL: ' + (results.estimatedProfit < 0 ? '-' : '+') + `${results.estimatedProfit.toFixed(2)}`
      finalProfit = 'Final PNL: ' + (results.profit < 0 ? '-' : '+') + `${results.profit.toFixed(2)}`
      break
    }
  }

  const updated = {
    ...record,
    buyInfo: `${record.buyInfo}\n${buyInfo}`,
    sellInfo: sellInfo,
    profit: `${estimatedProfit}\n${finalProfit}`
  }
  // allRecordsByFirstMintTx.set(data.pool.id.toString(), updated)
  // renderCurrentState()
  upsertRecord(updated)
}

export async function onBuyResults(poolId: string, buyResults: BuyResult) {
  let buyInfo = ''
  switch (buyResults.kind) {
    case 'NO_BUY': {
      buyInfo = `Failed to buy.\n ${buyResults.reason}`
      break
    }
    case 'NO_CONFIRMATION': {
      buyInfo = `Couldn't confirm buy tx.\n ${buyResults.reason}`
      break
    }
    case 'NO_TOKENS_AMOUNT': {
      buyInfo = `No tokens amount.\n ${buyResults.reason}`
      break
    }
    case 'SUCCESS': {
      buyInfo = `Success.\nBought ${buyResults.newTokenAmount} tokens`
      break
    }
  }

  if (!dbIsInited) {
    const isSuccess = buyResults.kind === 'SUCCESS'
    console.log(isSuccess ? chalk.green(buyInfo) : chalk.red(buyInfo))
    return
  }

  const record = await getOrMakeRecordByTxId(poolId)
  const updated = {
    ...record,
    buyInfo: buyInfo
  }
  // allRecordsByFirstMintTx.set(poolId, updated)
  // renderCurrentState()
  upsertRecord(updated)
}


export async function onTradingPNLChanged(poolId: string, newPNL: number) {
  if (!dbIsInited) {
    const date = new Date()
    const isNegative = newPNL < 0
    const logTxt = `[${formatDate(date)}]: PNL - ${(newPNL * 100).toFixed(2)}%`
    console.log(isNegative ? chalk.red(logTxt) : chalk.green(logTxt))
    return
  }
  const record = await getOrMakeRecordByTxId(poolId)
  const currentMax = record.maxProfit
  let updatedMaxPNL = 0
  if (currentMax) {
    updatedMaxPNL = newPNL > currentMax ? newPNL : currentMax
  } else {
    updatedMaxPNL = newPNL
  }
  const updated = {
    ...record,
    maxProfit: updatedMaxPNL
  }
  // allRecordsByFirstMintTx.set(poolId, updated)
  // renderCurrentState()
  upsertRecord(updated)
}