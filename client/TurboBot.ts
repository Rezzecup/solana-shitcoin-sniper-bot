import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { parsePoolCreationTx, ParsedPoolCreationTx, checkIfPoolPostponed, checkIfSwapEnabled } from './PoolValidator/RaydiumPoolValidator';
import { config } from './Config';
import { SellResults } from './Trader/SellToken';
import { OWNER_ADDRESS, SOL_SPL_TOKEN_ADDRESS } from './Trader/Addresses';
import { instaBuyAndSell, tryPerformTrading } from './Trader/Trader';
import { checkToken } from './PoolValidator/RaydiumSafetyCheck';
import { TradingWallet } from './StateAggregator/StateTypes';
import WebSocket from 'ws';
import { getPoolInfo } from './ManualTrader';
import { convertStringKeysToDataKeys } from './Utils';


const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

const LOW_LP_IN_USD = 500;
const HIGH_LP_IN_USD = 100000000;

export class TurboBot {
  private seenTxs = new Set<string>()
  private onLogsSubscriptionId: number | null = null
  private connection: Connection
  private backupConnection: Connection | null
  private tradingWallet: TradingWallet = {
    id: 0,
    startValue: 1,
    current: 1,
    totalProfit: 0
  }

  constructor(connection: Connection, backupConnection: Connection | null = null) {
    this.connection = connection
    this.backupConnection = backupConnection
  }

  isStarted() {
    return this.onLogsSubscriptionId !== null
  }

  private updateWSOLBalance(tradeResults: SellResults) {
    if (tradeResults.boughtForSol) {
      const soldForSol = tradeResults.kind === 'SUCCESS' ? tradeResults.soldForSOL : 0
      const profitAbsolute = soldForSol - tradeResults.boughtForSol
      const newWalletBalance = this.tradingWallet.current + profitAbsolute
      const totalProfit = (newWalletBalance - this.tradingWallet.startValue) / this.tradingWallet.startValue
      this.tradingWallet = { ...this.tradingWallet, current: newWalletBalance, totalProfit }

      console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)
      //updateTradingWalletRecord(this.tradingWallet)
    }
  }

  private async updateRealWsolBalance() {
    const newWalletBalance = (await this.connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS)).value.uiAmount ?? 0
    const totalProfit = (newWalletBalance - this.tradingWallet.startValue) / this.tradingWallet.startValue
    this.tradingWallet = { ...this.tradingWallet, current: newWalletBalance, totalProfit }
    console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)
  }

  private async fetchInitialWalletSOLBalance() {
    if (config.simulateOnly) { return }
    console.log(`Fetching wallet balance`)
    const balance = (await this.connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS)).value.uiAmount ?? 0
    console.log(`Balance is ${balance}`)
    this.tradingWallet.current = balance
    this.tradingWallet.startValue = balance
  }

  async buySellQuickTest(poolCreationTx: string) {
    console.log(`Start Solana bot. Simulation=${config.simulateOnly}`)
    await this.fetchInitialWalletSOLBalance()
    console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)


    const poolInfo = await getPoolInfo(this.connection, new PublicKey(poolCreationTx))

    console.log(`Pool parsed, buying and selling`)
    const tradeResults = await instaBuyAndSell(this.connection, convertStringKeysToDataKeys(poolInfo), 0.01)
    console.log(chalk.yellow('Got trading results'))
    console.log(`BUY at ${tradeResults.buyTime ?? 'null'}`)
    if (tradeResults.kind === 'SUCCESS') {
      console.log(`SELL at ${tradeResults.sellTime}`)
    } else {
      console.log(`Couldn't sell`)
    }
    this.updateWSOLBalance(tradeResults)
  }

  async start(singleTrade: boolean = false) {
    return new Promise<void>(async (resolve, reject) => {
      console.log(`Start Solana bot. Simulation=${config.simulateOnly}`)
      await this.fetchInitialWalletSOLBalance()
      console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)

      const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);

      let isCheckingPool = false
      this.onLogsSubscriptionId = this.connection.onLogs(raydium, async (txLogs) => {
        //console.log(`Log received. ${txLogs.signature}`)
        if (isCheckingPool || this.seenTxs.has(txLogs.signature)) { return }
        isCheckingPool = true
        this.seenTxs.add(txLogs.signature)
        const parsedInfo = await this.parseTx(txLogs)
        if (!parsedInfo) {
          isCheckingPool = false
          return
        }
        const check = await checkToken(this.connection, parsedInfo, true)
        if (check.kind === 'CreatorIsScammer') {
          console.log(`Pool ${parsedInfo.poolKeys.id} - creator is known scammer`)
          isCheckingPool = false
          return
        }

        if (check.kind !== 'Complete') {
          console.log(`Pool ${parsedInfo.poolKeys.id} discarded`)
          isCheckingPool = false
          return
        }

        if (check.data.totalLiquidity.amountInUSD < LOW_LP_IN_USD || check.data.totalLiquidity.amountInUSD > HIGH_LP_IN_USD) {
          console.log(`Pool ${parsedInfo.poolKeys.id} - Liquidity is too low or too high. ${check.data.totalLiquidity.amount} ${check.data.totalLiquidity.symbol}`)
          isCheckingPool = false
          return
        }

        if (check.data.ownershipInfo.isMintable) {
          console.log(`Pool ${parsedInfo.poolKeys.id} - token is mintable`)
          isCheckingPool = false
          return
        }

        console.log(`Pool looks good, buying.`)
        const tradeResults = await tryPerformTrading(this.connection, check.data.pool, 'TURBO')
        console.log(chalk.yellow('Got trading results'))
        console.log(`BUY at ${tradeResults.buyTime ?? 'null'}`)
        if (tradeResults.kind === 'SUCCESS') {
          console.log(`SELL at ${tradeResults.sellTime}`)
        } else {
          console.log(`Couldn't sell`)
        }
        if (config.simulateOnly) {
          this.updateWSOLBalance(tradeResults)
        } else {
          await this.updateRealWsolBalance()
        }

        if (singleTrade) {
          this.connection.removeOnLogsListener(this.onLogsSubscriptionId ?? 0)
          this.onLogsSubscriptionId = null
          resolve()
        }
        isCheckingPool = false
      })

      // const ws = new WebSocket(config.rpcWsURL)
      // ws.onopen = () => {
      //   ws.send(
      //     JSON.stringify({
      //       "jsonrpc": "2.0",
      //       "id": 1,
      //       "method": "logsSubscribe",
      //       "params": ["all"]
      //     }
      //     )
      //   )

      //   ws.onmessage = (evt) => {
      //     try {
      //       console.log(`New logs from WS: ${evt.data.toString()}`)
      //     } catch (e) {
      //       console.log(e)
      //     }
      //   }
      // }
      // ws.onerror = (e) => {
      //   console.log(`WS error1: ${e.error.errors[0]}`)
      //   console.log(`WS error2: ${e.error.errors[1]}`)
      // }
    })


  }

  private async parseTx(txLogs: Logs): Promise<ParsedPoolCreationTx | null> {
    const logEntry = findLogEntry('init_pc_amount', txLogs.logs)
    if (!logEntry) { return null }
    return this.getPoolCreationTx(txLogs.signature)
  }

  private async getPoolCreationTx(txSignature: string): Promise<ParsedPoolCreationTx | null> {
    try {
      const info = await parsePoolCreationTx(this.connection, txSignature)
      const postponeInfo = checkIfPoolPostponed(info)
      if (postponeInfo.startTime) {
        console.log(`Pool ${info.poolKeys.id} is postponed`)
        return null
      }
      const isEnabled = checkIfSwapEnabled(info).isEnabled
      if (!isEnabled) {
        console.log(`Pool ${info.poolKeys.id} is disabled`)
        return null
      }
      return info
    } catch (e) {
      console.error(`Failed to parse tx. ${e}`)
      return null
    }
  }

}