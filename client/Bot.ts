import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { findLogEntry } from './PoolValidator/RaydiumPoolParser';
import chalk from 'chalk';
import { parsePoolCreationTx, PoolPostponed, ParsedPoolCreationTx, checkIfPoolPostponed, checkIfSwapEnabled, evaluateSafetyState, checkLatestTrades, TradingInfo } from './PoolValidator/RaydiumPoolValidator';
import { delay, formatDate } from './Utils';
import { config } from './Config';
import { SellResults } from './Trader/SellToken';
import { SOL_SPL_TOKEN_ADDRESS } from './Trader/Addresses';
import { tryPerformTrading } from './Trader/Trader';
import { EMPTY, Observable, ObservableInput, ObservedValueOf, OperatorFunction, Subject, catchError, concatWith, distinct, filter, from, map, mergeAll, mergeMap, switchMap, windowCount } from 'rxjs';
import { checkLPTokenBurnedOrTimeout, checkToken, getTokenOwnershipInfo, PoolSafetyData, SafetyCheckComplete, WaitLPBurning, WaitLPBurningComplete, WaitLPBurningTooLong } from './PoolValidator/RaydiumSafetyCheck';
import { TokenSafetyStatus } from './PoolValidator/ValidationResult';
import { onFinishTrading, onPoolDataParsed, onPoolValidationChanged, onPoolValidationEvaluated, onStartGettingTrades, onStartTrading, onTradesEvaluated } from './StateAggregator/ConsoleOutput';
import { createNewTradingWallet, initializeDb, updateTradingWalletRecord } from './StateAggregator/DbWriter'
import { TradingWallet } from './StateAggregator/StateTypes';


const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

type WaitingLPMintTooLong = {
  kind: 'TO_LONG',
  data: ParsedPoolCreationTx
}

type WaitingLPMintOk = {
  kind: 'OK',
  data: ParsedPoolCreationTx
}

type WaitingLPMint = WaitingLPMintTooLong | WaitingLPMintOk

export class TradingBot {
  private onLogsSubscriptionId: number | null = null
  private connection: Connection
  private tradingWallet: TradingWallet = {
    id: 0,
    startValue: 1,
    current: 1,
    totalProfit: 0
  }

  getWalletTradingInfo(): TradingWallet {
    return this.tradingWallet
  }

  validationSub: any;
  parseResSub: any;
  pushToTradingTrendSub: any;
  tradingSub: any;


  // private validatorPool = new Piscina({
  //   filename: path.resolve(__dirname, './PoolValidator/RaydiumPoolValidator.js'),
  //   maxQueue: 'auto',
  //   maxThreads: 10,
  // });

  // private traderPool = new Piscina({
  //   filename: path.resolve(__dirname, './Trader/Trader.js'),
  //   maxQueue: 'auto',
  // })

  constructor(connection: Connection) {
    this.connection = connection
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
      updateTradingWalletRecord(this.tradingWallet)
    }
  }

  private async fetchInitialWalletSOLBalance() {
    if (config.simulateOnly) { return }
    const balance = ((await this.connection.getTokenAccountBalance(SOL_SPL_TOKEN_ADDRESS)).value.uiAmount ?? 0)
    this.tradingWallet.current = balance
    this.tradingWallet.startValue = balance
  }

  private raydiumLogsSubject = new Subject<Logs>()
  private postponedPoolsSubject = new Subject<PoolPostponed>()
  private readyToSafetyCheckSubject = new Subject<ParsedPoolCreationTx>()
  private waitingLPToBurnPoolsSubject = new Subject<WaitLPBurning>()
  private safetyCheckCompleteSubject = new Subject<SafetyCheckComplete | WaitLPBurningComplete>()
  private readyToTradeSubject = new Subject<{ status: TokenSafetyStatus, data: PoolSafetyData }>()
  private skippedPoolsSubject = new Subject<{ data: ParsedPoolCreationTx | PoolSafetyData, reason: string }>()
  private logsSubject = new Subject<{ data: ParsedPoolCreationTx | PoolSafetyData, reason: string }>()
  private NEW_POOLS_BUFFER = 10
  async start() {

    console.log(`Start Solana bot. Simulation=${config.simulateOnly}`)
    await initializeDb()
    this.tradingWallet = (await createNewTradingWallet())!

    await this.fetchInitialWalletSOLBalance()

    console.log(`Wallet:\n${JSON.stringify(this.tradingWallet, null, 2)}`)

    const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);

    this.onLogsSubscriptionId = this.connection.onLogs(raydium, async (txLogs) => {
      this.raydiumLogsSubject.next(txLogs)
    })

    const parseNewIcomingObservable = this.raydiumLogsSubject
      .pipe(
        distinct((x) => x.signature),
        filter((x) => findLogEntry('init_pc_amount', x.logs) !== null),
        map(x => x.signature),
        mergeMap((txId) => from(parsePoolCreationTx(this.connection, txId)).pipe(printError()), 5),
        map(x => checkIfPoolPostponed(x)),
        map(x => { return { ...x, isEnabled: checkIfSwapEnabled(x.parsed).isEnabled } })
      )

    this.parseResSub = parseNewIcomingObservable.subscribe(async (parseResults) => {
      await onPoolDataParsed(parseResults.parsed, parseResults.startTime, parseResults.isEnabled)
      if (parseResults.startTime) {
        this.postponedPoolsSubject.next({ kind: 'Postponed', parsed: parseResults.parsed, startTime: parseResults.startTime })
      } else if (parseResults.isEnabled) {
        this.readyToSafetyCheckSubject.next(parseResults.parsed)
      } else {
        this.skippedPoolsSubject.next({ data: parseResults.parsed, reason: 'Swapping is disabled' })
      }
    })

    const postponedObservable = this.postponedPoolsSubject.pipe(
      switchMap(x => from(this.waitUntilPoolStartsAndNotify(x.parsed, x.startTime)))
    )

    this.validationSub = this.readyToSafetyCheckSubject
      .pipe(
        map(x => {
          const obj: WaitingLPMint = { kind: 'OK', data: x }
          return obj
        }),
        concatWith(postponedObservable),
        windowCount(this.NEW_POOLS_BUFFER),
        mergeAll(),
        mergeMap(parsed => {
          switch (parsed.kind) {
            case 'OK': {
              return from(checkToken(this.connection, parsed.data))
            }
            case 'TO_LONG': {
              const obj: WaitLPBurningTooLong = {
                kind: 'WaitLPBurningTooLong',
                data: parsed.data
              }
              return from([obj])
            }
          }
        }, 3)
      )
      .subscribe({
        next: safetyCheckResults => {
          onPoolValidationChanged(safetyCheckResults)
          switch (safetyCheckResults.kind) {
            case 'CreatorIsScammer': {
              const msg = `Pool ${safetyCheckResults.pool.poolKeys.id} Skipped because creator ${safetyCheckResults.pool.creator.toString()} is in blacklist.`
              this.skippedPoolsSubject.next({ data: safetyCheckResults.pool, reason: msg })
              break
            }
            case 'WaitLPBurningTooLong': {
              const msg = `Pool ${safetyCheckResults.data.poolKeys.id} Skipped because it's postponed for too long.`
              this.skippedPoolsSubject.next({ data: safetyCheckResults.data, reason: msg })
              break
            }
            case 'WaitLPBurning': {
              this.waitingLPToBurnPoolsSubject.next(safetyCheckResults)
              break
            }
            case 'Complete': {
              this.safetyCheckCompleteSubject.next(safetyCheckResults)
              break
            }
          }
        },
        error: error => {
          console.error(error)
        }
      })

    const waitLPBurnedObservable: Observable<WaitLPBurningComplete> = this.waitingLPToBurnPoolsSubject.pipe(
      mergeMap(x => from(this.waitUntilLPTokensAreBurned(x.data, x.lpTokenMint)), 10),
      mergeMap(x => from(getTokenOwnershipInfo(this.connection, x.data.tokenMint))
        .pipe(
          map(res => { return { ...x, data: { ...x.data, ownershipInfo: res } } })
        )
      )
    )

    this.pushToTradingTrendSub = this.safetyCheckCompleteSubject.pipe(
      concatWith(waitLPBurnedObservable),
      map(x => evaluateSafetyState(x.data, x.isliquidityLocked)),
      switchMap(data => {
        onPoolValidationEvaluated(data)
        if (data.status === 'RED') {
          return EMPTY
        } else {
          onStartGettingTrades(data)
          return from(checkLatestTrades(this.connection, data.data.pool))
            .pipe(
              map(x => { return { data: data.data, status: data.status, statusReason: data.reason, tradingInfo: x } })
            )
        }
      })
    ).subscribe({
      next: data => {
        this.checkTokenStatusAndTradingTrend({ pool: data.data, safetyStatus: data.status, statusReason: data.statusReason, tradingInfo: data.tradingInfo })
      },
      error: e => {
        console.error(`${e}`)
      }
    })


    this.tradingSub = this.readyToTradeSubject
      .pipe(
        mergeMap(x => {
          onStartTrading(x.data)
          return from(tryPerformTrading(this.connection, x.data.pool, x.status))
            .pipe(map(tr => { return { poolData: x.data, results: tr } }))
        })
      )
      .subscribe({
        next: x => {
          onFinishTrading(x.poolData, x.results)
          this.onTradingResults(x.poolData.pool.id.toString(), x.results)
        },
        error: e => {
          console.error(`${e}`)
        }
      })


    console.log(chalk.cyan('Listening to new pools...'))
  }

  private checkTokenStatusAndTradingTrend(data: { pool: PoolSafetyData, safetyStatus: TokenSafetyStatus, statusReason: string, tradingInfo: TradingInfo }) {
    if (data.safetyStatus === 'RED') {
      // Should be verified and filterd out earlier
      return
    }

    if (data.tradingInfo.dump) {
      const log = `Already dumped. TX1: https://solscan.io/tx/${data.tradingInfo.dump[0].signature} TX2:TX1: https://solscan.io/tx/${data.tradingInfo.dump[1].signature}`
      onTradesEvaluated(data.pool, log)
      this.skippedPoolsSubject.next({ data: data.pool, reason: log })
      return
    }

    const tradingAnalisis = data.tradingInfo.analysis
    if (!tradingAnalisis) {
      onTradesEvaluated(data.pool, `Couldn't fetch trades`)
      this.skippedPoolsSubject.next({ data: data.pool, reason: `Couldn't fetch trades` })
      return
    }

    if (data.safetyStatus === 'GREEN') {
      onTradesEvaluated(data.pool, `${data.safetyStatus}`)
      if (tradingAnalisis.type === 'PUMPING' || tradingAnalisis.type === 'EQUILIBRIUM') {
        this.readyToTradeSubject.next({ status: data.safetyStatus, data: data.pool })
      } else {
        this.skippedPoolsSubject.next({ data: data.pool, reason: `Trend is DUMPING` })
      }

      return
    }

    if (tradingAnalisis.type !== 'PUMPING') {
      onTradesEvaluated(data.pool, `${data.safetyStatus}`)
      this.skippedPoolsSubject.next({ data: data.pool, reason: `Trend is DUMPING` })
      return
    }

    if (tradingAnalisis.volatility > config.safePriceValotilityRate) {
      const msg = `Not GREEN token and Price volatility is to high ${tradingAnalisis.volatility}`
      onTradesEvaluated(data.pool, msg)
      this.skippedPoolsSubject.next({ data: data.pool, reason: msg })
      return
    }

    if (tradingAnalisis.buysCount < config.safeBuysCountInFirstMinute) {
      const msg = `Not GREEN token and Very little BUY txs ${tradingAnalisis.buysCount}`
      onTradesEvaluated(data.pool, msg)
      this.skippedPoolsSubject.next({ data: data.pool, reason: msg })
      return
    }

    onTradesEvaluated(data.pool, `${data.safetyStatus}`)
    this.readyToTradeSubject.next({ status: data.safetyStatus, data: data.pool })
  }

  async waitUntilPoolStartsAndNotify(parsed: ParsedPoolCreationTx, startTime: number): Promise<WaitingLPMint> {
    const delayBeforeStart = (startTime * 1000) - Date.now()
    const maxTimeToWait = 24 * 60 * 60 * 1000
    if (delayBeforeStart > 0 && delayBeforeStart < maxTimeToWait) {
      console.log(`Wait until it starts`)
      await delay(delayBeforeStart + 300)
      return { kind: 'OK', data: parsed }
    } else {
      return { kind: 'TO_LONG', data: parsed }
    }
  }

  async waitUntilLPTokensAreBurned(safetyData: PoolSafetyData, lpTokenMint: PublicKey): Promise<WaitLPBurningComplete> {
    const isLiquidityLocked = await checkLPTokenBurnedOrTimeout(
      this.connection,
      lpTokenMint,
      2 * 60 * 60 * 1000
    )
    return { kind: 'WaitLPBurningComplete', isliquidityLocked: isLiquidityLocked, data: safetyData }
  }

  stop() {
    if (this.onLogsSubscriptionId) {
      this.connection.removeOnLogsListener(this.onLogsSubscriptionId)
    }
  }

  private onError(error: Error) {
    console.error(error)
  }

  private onTradingResults(poolId: string, tradeResults: SellResults) {
    this.updateWSOLBalance(tradeResults)
    console.log(chalk.yellow('Got trading results'))
  }
}

function printError<T, O extends ObservableInput<any>>(): OperatorFunction<T, T | ObservedValueOf<O>> {
  return catchError(e => {
    console.error(e)
    return EMPTY
  })
}