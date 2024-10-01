import * as dotenv from 'dotenv'
dotenv.config()
import fs from 'fs'
import path from 'path'
import csv from 'csv-parser'
import { TradeRecord, TradeType, fetchLatestTrades } from './TradesFetcher'
import { ChartTrend, analyzeTrend, findDumpingRecord } from './TradesAnalyzer'
import { PoolKeys, fetchPoolKeysForLPInitTransactionHash } from '../PoolValidator/RaydiumPoolParser'
import { config } from '../Config'
import { Connection, PublicKey } from '@solana/web3.js'
import { AccountLayout } from '@solana/spl-token'
import { convertStringKeysToDataKeys } from '../Utils'

const connection = new Connection(config.rpcHttpURL, {
  wsEndpoint: config.rpcWsURL
})

const raydiumPoolAuthority = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"

const poolsToGetPriceChanges = [
  // 'ASUUfLjhtacBbjx7KswSraRYvZMUdbWsjMNjDYngzaex',
  // 'DoNtsgPxYZfpq5cpBFH1PqAwhJDU9G7RCG1EPgCUiwRx',
  // 'A3isw2Xco9TtpvKgm9j7UcjUoGpCP4FfhrnXPGnxgKrQ',
  // 'Es6nqcHuFvj8VNJ1obfwkoD6zAgwvdY2WCa4EGsPrfZU',
  // 'AqaXfDnGCzTK14U69QjWWThDCEBD5iiwvpM5dMCxeWBj',
  // '3ZMzLJMozbPKex7jyhsQUwDYxecJNWutdKEhoDsBmRjk',
  // '2QhsDSRz9fYCmg48qNyFfSLaTp4K8XcNKuCBeTaH8ns5',
  // '5CrZMaLVzDaZiinmPYM9ntAAqsmAvH4JKAKDczYRbXdd',
  // 'CzMUQP2fYvz5AF1wWmU19YhbCwhYhhCe9JiLiZjk3a8r',
  // 'HjQwYyivK56MYnKkgjSMe5bvvHWtTQziZnbdnALNbjXN',
  // '6Mms42RMhkc1xkEaNGiqFasiXKD1mmYj9LwgHJecU6D4',
  '9tP6LFHbJnikaRRCxxYAtKNeRsVVtvNjDxNVNmg1FY4g'
]

const poolFirstTxs = [
  'qqHR5VkyFbcJg8D9aSGPQ5Z5DEHDRPJ1pAPPWS2yF8MVvzeJaLgVkZWn4qYd1VrpNubsTDUJH2iUpgHRAdaCC9h',
  '2bZ89AbTRvNBK6aaroExTPrCS9E2DPj2EB5oMWe6PP9ApAYe11BGqJn9vFi1JWGBBhC1rRDoR7wFQYZDztdYZf9i',
  '4fWfkn3dv4fRdaJvdMJxkP42er7bFoHgCrtD3jyEWcgJsJR6dn149UbqaHoYoBzCNCDxreqEe5t3QKon3keErAeH',
  '28bum3cR7aHuUBEN8fbnJ5Vfp6L1m6jyFkLFUCvZTyUMrx44kfLyT51eZgCEsFHxskBeh8JdCDBUi4Cni7kQVF2m',
  'mgQMbynw1s3QnckDS7JAyr382fd7nfmeBR64TAFSdNEppR7VrLjEu62tmeitmCfStKirLvHeZuuyWWhmxTUfYgx',
  'WHxPpJg82SUtMNh4YAnAeKqDCpuQcLRJ8qhU1vUWQZr5bVzMJxPiBJ4r3hrqzegvuJDAJ4TbH4ifjVJvq2reX98',
  '5zHKMquUARQPWETqe9tnA1hyhMNE2mtmZ8gFN5xhBhQyRgJkZ1ZEf1k2J5mfq2oeniUt2hWoUPxANALMxnrKRGCq',
  'Cd4kA68ofmeRYqYA2XcCg1xhyZZyz9FHCRTpCUXzBZhrsEBFqsQTQpJT75CiXNG8oXn65CUG1T6En496Ptp2ub8',
  '2VX5P1mRNF7w5mMtMtNBNg7icZ5CVokPkeFzUQthtJmkemcMvMXUGevNkcB9aKC5W5KQKQgSqBLD8Rrpu5D6Ms5j',
  '4NP2XjcdtaGTvQTsf88isCh4yQPw4pHgfmEycaJ7EkVnLSrveSTJi6EjcHH2ZpQgqSmfZAh17fKtnsogHSBwDukw',
  '4k4GFMnhM3PXBeykRRLPTnqp74VHnPKKR7UBsqEcEz84vyg9ryvHk5EHbiVH5BxqAboCdUUiHNRvpoXCPe5q6qHg',
  '4NYWxJsyXzRWo4pu3u1V6AEoNbB4n8wqaQzSB95QCfyiTKCvzH69hL4thZbuNQKSJXPHjLECiq4SnotYK9e9nWUh'
]

async function testLPTOkenAccInfo() {
  const tokenAccAddress = new PublicKey('GwNzvvq8LwRXBuoZqAKqCAwpS6Y4RgKxsMDAas6z722U')
  const accInfo = await connection.getAccountInfo(tokenAccAddress)
  if (accInfo) {
    const parsed = AccountLayout.decode(accInfo.data)
    console.log(`${parsed}`)
  }
}

async function test() {
  let i = 11
  const parsed: { poolId: string, trades: TradeRecord[] }[] = []
  while (i < poolFirstTxs.length) {
    const { poolKeys } = await fetchPoolKeysForLPInitTransactionHash(connection, poolFirstTxs[i])
    const fetched = await getTradeRecords(poolKeys)
    parsed.push(fetched)
    i++
  }

  for (let { poolId, trades } of parsed) {
    saveToCSV(poolId, trades.sort((a, b) => a.epochTime - b.epochTime))
  }
}

async function loadSaved() {
  for (let poolId of poolsToGetPriceChanges) {
    const records = await parseCSV(poolId)
    const dumpRes = findDumpingRecord(records)
    const trend = analyzeTrend(records)
    console.log(`${poolId} - ${trendToColor(trend.type, trend.buysCount, trend.volatility)}, rate=${trend.averageGrowthRate}, volatility=${trend.volatility}`)
  }
}

function trendToColor(trend: ChartTrend, buysCount: number, volatility: number): string {
  if ((volatility > config.safePriceValotilityRate) || buysCount < config.safeBuysCountInFirstMinute) { return '🔴 Bad' }
  switch (trend) {
    case 'EQUILIBRIUM': return '🟢 Good' //'🟡 So So'
    case 'PUMPING': return '🟢 Good'
    case 'DUMPING': return '🔴 Bad'
    default: return '⚪ Unknown'
  }
}

// loadSaved()
// test()
testLPTOkenAccInfo()

async function parseCSV(poolId: string): Promise<TradeRecord[]> {
  return new Promise((resolve, _) => {
    const filePath = path.join(__dirname, `/trading_data/${poolId}.csv`)
    const records: TradeRecord[] = []

    const mapValues = (args: { header: string, index: number, value: any }) => {
      if (args.index <= 1) {
        return args.value
      }
      if (args.index === 3) {
        return args.value as TradeType
      }
      return Number(args.value)
    }

    const csvOptions = {
      headers: ['signature', 'time', 'epochTime', 'type', 'tokenAmount', 'solAmount', 'usdAmount', 'priceInSOL', 'priceInUSD'],
      mapValues: mapValues,
      skipLines: 1
    }
    fs.createReadStream(filePath)
      .pipe(csv(csvOptions))
      .on("data", function (row: TradeRecord) {
        records.push(row)
      })
      .on('end', () => {
        records.sort((a, b) => a.epochTime - b.epochTime)
        resolve(records)
      })
  })
}

async function getTradeRecords(poolKeys: PoolKeys): Promise<{ poolId: string, trades: TradeRecord[] }> {
  const tradeRecords = await fetchLatestTrades(connection, convertStringKeysToDataKeys(poolKeys))
  return { poolId: poolKeys.id, trades: tradeRecords }
}

function saveToCSV(fileName: string, data: TradeRecord[]) {
  const titleKeys = Object.keys(data[0])
  const refinedData = []
  refinedData.push(titleKeys)
  data.forEach(item => {
    refinedData.push(Object.values(item))
  })

  let csvContent = ''

  const filePath = path.join(__dirname, `/trading_data/${fileName}.csv`)

  refinedData.forEach(row => {
    csvContent += row.join(',') + '\n'
  })
  fs.writeFileSync(filePath, csvContent, {})
}
