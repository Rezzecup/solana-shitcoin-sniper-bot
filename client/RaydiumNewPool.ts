import { Connection, PublicKey, ParsedTransactionWithMeta, PartiallyDecodedInstruction, Logs } from "@solana/web3.js";
import { delay, formatDate, printTime } from "./Utils";
import { Liquidity, LiquidityPoolKeys, LiquidityPoolKeysV4, Market, WSOL } from "@raydium-io/raydium-sdk";
const RAYDIUM_PUBLIC_KEY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
import chalk from 'chalk';
import { fetchPoolKeysForLPInitTransactionHash, findLogEntry } from "./PoolMaker";
import { checkToken } from "./SafetyCheck";
// const connection = new Connection(process.env.RPC_URL!, {
//   wsEndpoint: process.env.WS_URL!
// });

export type PoolWithStrategy = {
  pool: LiquidityPoolKeysV4,
  exitTimeoutInMillis: number,
  targetProfit: number
}

const SAFE_TRADING_STRATEGY = {
  exitTimeoutInMillis: 30 * 60 * 1000, // 10 minutes time when token looks good
  targetProfit: 4.9 // 500% to target, we must be early to 
}

const DANGEROUS_TRADING_STRATEGY = {
  exitTimeoutInMillis: 1 * 60 * 1000, // 1 minutes time when token looks good
  targetProfit: 0.09 // make 9% to target 10% in more secure way. owner could dump all tokens
}


const seenTransactions = new Set();
let poolIsProcessing = false;

const TEST_TX = '5WaD3YGDY8xGuBEanaqqNNFEU9qU2JuHPFhdS8RAZJLYK3APQd2wqaAjFypJMAhfVeQwWyYDYtQLUNvuRYKXgfSE'


async function handleNewTxLog(connection: Connection, txId: string): Promise<PoolWithStrategy | null> {
  try {
    const date = new Date();
    const { poolKeys, mintTransaction } = await fetchPoolKeysForLPInitTransactionHash(txId, connection); // With poolKeys you can do a swap
    console.log(`Found new POOL at ${chalk.bgYellow(formatDate(date))}`);
    console.log(`${poolKeys.id}`);

    const info = await Liquidity.fetchInfo({ connection: connection, poolKeys: poolKeys });
    console.log(chalk.cyan(JSON.stringify(info, null, 2)))
    const features = Liquidity.getEnabledFeatures(info);
    console.log(chalk.cyan(JSON.stringify(features, null, 2)))

    if (!features.swap) {
      console.log(`${chalk.gray(`Swapping is disabled, skipping`)}`);
      return null
    }

    const safetyCheckResults = await checkToken(connection, mintTransaction, poolKeys)

    if (safetyCheckResults === null) {
      console.log(chalk.red(`Couldn't verify safety for pool ${poolKeys.id}. Skipping`))
      return null
    }

    console.log(chalk.cyan(JSON.stringify(safetyCheckResults, null, 2)))

    const SAFE_LOCKED_LIQUIDITY_PERCENT = 0.9
    const MIN_PERCENT_NEW_TOKEN_INPOOL = 0.8
    const LOW_IN_USD = 1000;
    const HIGH_IN_USD = 100000000;

    /// Check is liquidiity amount is too low r otoo high (both are suspicous)
    if (safetyCheckResults.totalLiquidity.amountInUSD < LOW_IN_USD || safetyCheckResults.totalLiquidity.amountInUSD > HIGH_IN_USD) {
      console.log(`${chalk.gray('Liquiidity is too low or too high. Dangerous. Skipping.')}`)
      return null
    }

    if (safetyCheckResults.lockedPercentOfLiqiodity < SAFE_LOCKED_LIQUIDITY_PERCENT) {
      /// If locked percent of liquidity is less then SAFE_LOCKED_LIQUIDITY_PERCENT
      /// most likely it will be rugged at any time, better to stay away
      console.log(`${chalk.gray('Large percent of liquidity is unlocked. Dangerous. Skipping.')}`)
      return null
    }

    /// When token is mintable but almost 100% LP is locked
    if (safetyCheckResults.lockedPercentOfLiqiodity >= 0.99) {
      /// Check percent in pool
      if (safetyCheckResults.newTokenPoolBalancePercent >= 0.99) {
        /// When almost all tokens in pool 
        if (safetyCheckResults.ownershipInfo.isMintable) {
          /// When token is still mintable
          /// We can try to get some money out of it
          console.log(`${chalk.gray('Some amount of LP is locked, but token is mintable. Try with less profit target')}`)
          return {
            pool: poolKeys,
            ...DANGEROUS_TRADING_STRATEGY
          }
        } else {
          /// When token is not mintable
          console.log(`${chalk.green('Safety check passed. LFG')}`)
          return {
            pool: poolKeys,
            ...SAFE_TRADING_STRATEGY
          }
        }
      } else if (safetyCheckResults.newTokenPoolBalancePercent >= MIN_PERCENT_NEW_TOKEN_INPOOL) {
        /// When at least MIN_PERCENT_NEW_TOKEN_INPOOL tokens in pool 
        if (!safetyCheckResults.ownershipInfo.isMintable) {
          /// If token is not mintable
          console.log(`${chalk.gray('Some tokens are not in pool, but token is not mintable. Try with less profit target')}`)
          return {
            pool: poolKeys,
            ...DANGEROUS_TRADING_STRATEGY
          }
        } if (safetyCheckResults.newTokenPoolBalancePercent >= 0.95) {
          /// If token is mintable, but should not be dumped fast (from my experience)
          console.log(`${chalk.gray('Some tokens are not in pool, but token is not mintable. Try with less profit target')}`)
          return {
            pool: poolKeys,
            ...DANGEROUS_TRADING_STRATEGY
          }
        } else {
          /// If token is mintable
          console.log(`${chalk.gray('Some tokens are not in pool and token is mintable. Could be dumped very fast. Stay away')}`)
          return null
        }
      } else {
        /// When too much new tokens is not in pool
        console.log(`${chalk.gray('Too much new tokens is not in pool. Could be dumped very fast. Stay away')}`)
        return null
      }
    } else { /// When 10% or less is unlocked
      /// When token is not mintable
      if (!safetyCheckResults.ownershipInfo.isMintable) {
        /// We can try to get some money out of it
        console.log(`${chalk.gray('10% or less of LP is unlocked and token is not mintable. Try with less profit target')}`)
        return {
          pool: poolKeys,
          ...DANGEROUS_TRADING_STRATEGY
        }
      } else {
        /// When token is mintable
        /// Better to stay away
        console.log(`${chalk.gray('10% or less of LP is unlocked and token is mintable. Stay away.')}`)
        return null
      }
    }
  } catch (e) {
    console.error(`Couldn't fetch or verify TX ${chalk.yellow(txId)}. ${e}`);
    return null
  }
}

async function main(connection: Connection, raydium: PublicKey, onNewPair: (pool: PoolWithStrategy) => void) {
  /* Uncomment to test with constatnt txid */
  // await handleNewTxLog(connection, TEST_TX)
  // return

  console.log(`${chalk.cyan('Monitoring logs...')} ${chalk.bold(raydium.toString())}`);

  connection.onLogs(raydium, async (txLogs) => {
    if (poolIsProcessing) { return; }
    if (seenTransactions.has(txLogs.signature)) {
      return;
    }
    seenTransactions.add(txLogs.signature);
    if (!findLogEntry('init_pc_amount', txLogs.logs)) {
      return; // If "init_pc_amount" is not in log entries then it's not LP initialization transaction
    }
    poolIsProcessing = true
    console.log(chalk.yellow(`Fetching mint tx - ${txLogs.signature}`))
    let poolWithStrategy
    try {
      poolWithStrategy = await handleNewTxLog(connection, txLogs.signature)
    } catch (e) {
      await delay(200)
      poolWithStrategy = await handleNewTxLog(connection, txLogs.signature)
    }

    if (poolWithStrategy !== null) { onNewPair(poolWithStrategy) }
    poolIsProcessing = false
  });
  console.log('Listening to new pools...');

  // connection.onLogs(raydium, async ({ logs, err, signature }) => {
  //   if (err) return;
  //   if (logs && logs.some(log => log.includes('initialize2') && !processedSignatures.has(signature))) {
  //     processedSignatures.add(signature);
  //     console.log('Signature for Initialize2:', signature);
  //     printTime(new Date());
  //     const tokens = await fetchRaydiumAccounts(signature, connection);
  //     if (tokens === null) {
  //       return
  //     }
  //     const [tokenA, tokenB, pool] = tokens
  //     onNewPair(tokenA, tokenB, pool);
  //   }
  // }, "finalized");
}

async function fetchRaydiumAccounts(signature: string, connection: Connection): Promise<[string, string, LiquidityPoolKeys] | null> {
  const txId = signature;
  const tx = await connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  console.log(`Pool creation transaction: ${tx}`);
  const transaction = tx?.transaction?.message?.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY)
  if (transaction === undefined) {
    console.log("Transaction not found")
    return null
  }
  const instruction = tx?.transaction?.message?.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY) as PartiallyDecodedInstruction
  const accounts = instruction?.accounts;
  const innerInstructions = tx?.meta?.innerInstructions ?? []
  const allInstructions = innerInstructions.flatMap(x => x.instructions);
  const marketInstruction = allInstructions.find((x) => {
    const parsedInstr = (x as any);
    if (parsedInstr.parsed?.info?.space !== undefined) {
      return parsedInstr.parsed?.info?.space === 752;
    }
    return false;
  });
  const marketAddress = new PublicKey((marketInstruction as any).parsed.info.account);

  if (!accounts) {
    console.log('No accounts found');
    return null;
  }
  const tokenAIndex = 8;
  const tokenBIndex = 9;

  const tokeAAccount = accounts[tokenAIndex];
  const tokenBAccount = accounts[tokenBIndex];
  const displayData = [
    { Token: 'Token A', account: tokeAAccount },
    { Token: 'Token B', account: tokenBAccount },
  ];

  const poolKey = await fetchPoolKeys(connection, marketAddress);

  console.log("New Raydium Liquidity Pool Created Found");
  printTime(new Date());
  console.log(generateExplorerUrl(txId));
  console.table(displayData);
  // await sleep(2000);
  return [tokeAAccount.toString(), tokenBAccount.toString(), poolKey];
}

function generateExplorerUrl(txId: string) {
  return `https://solscan.io/tx/${txId}?cluster=mainnet`;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchPoolKeys(
  connection: Connection,
  poolId: PublicKey,
  version: 4 | 5 = 4): Promise<LiquidityPoolKeys> {

  const serumVersion = 10
  const marketVersion: 3 = 3

  const programId = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
  const serumProgramId = new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX')

  const account = await connection.getAccountInfo(poolId)
  const { state: LiquidityStateLayout } = Liquidity.getLayouts(version)

  //@ts-ignore
  const fields = LiquidityStateLayout.decode(account?.data);
  const { status, baseMint, quoteMint, lpMint, openOrders, targetOrders, baseVault, quoteVault, marketId, baseDecimal, quoteDecimal, } = fields;

  let withdrawQueue, lpVault;
  if (Liquidity.isV4(fields)) {
    withdrawQueue = fields.withdrawQueue;
    lpVault = fields.lpVault;
  } else {
    withdrawQueue = PublicKey.default;
    lpVault = PublicKey.default;
  }

  // uninitialized
  // if (status.isZero()) {
  //   return ;
  // }

  const associatedPoolKeys = Liquidity.getAssociatedPoolKeys({
    version: version,
    marketVersion,
    marketId,
    baseMint: baseMint,
    quoteMint: quoteMint,
    baseDecimals: baseDecimal.toNumber(),
    quoteDecimals: quoteDecimal.toNumber(),
    programId,
    marketProgramId: serumProgramId,
  });

  const poolKeys = {
    id: poolId,
    baseMint,
    quoteMint,
    lpMint,
    baseDecimals: associatedPoolKeys.baseDecimals,
    quoteDecimals: associatedPoolKeys.quoteDecimals,
    lpDecimals: associatedPoolKeys.lpDecimals,
    lookupTableAccount: associatedPoolKeys.lookupTableAccount,
    version,
    programId,
    authority: associatedPoolKeys.authority,
    openOrders,
    targetOrders,
    baseVault,
    quoteVault,
    withdrawQueue,
    lpVault,
    marketProgramId: serumProgramId,
    marketId,
    marketAuthority: associatedPoolKeys.marketAuthority,
  };



  const marketInfo = await connection.getAccountInfo(marketId);
  const { state: MARKET_STATE_LAYOUT } = Market.getLayouts(marketVersion);
  //@ts-ignore
  const market = MARKET_STATE_LAYOUT.decode(marketInfo.data);

  const {
    baseVault: marketBaseVault,
    quoteVault: marketQuoteVault,
    bids: marketBids,
    asks: marketAsks,
    eventQueue: marketEventQueue,
  } = market;

  // const poolKeys: LiquidityPoolKeys;
  return {
    ...poolKeys,
    marketVersion: 3,
    ...{
      marketBaseVault,
      marketQuoteVault,
      marketBids,
      marketAsks,
      marketEventQueue,
    },
  };
}


// main(connection,raydium).catch(console.error);
export async function runNewPoolObservation(onNewPair: (pool: PoolWithStrategy) => void) {
  const connection = new Connection(process.env.RPC_URL!, {
    wsEndpoint: process.env.WS_URL!
  });
  await main(connection, raydium, onNewPair);
  // try {
  //   await main(connection, raydium);
  // } catch (error) {
  //   console.error(`Error occurred: ${error}`);
  //   console.log('Restarting the program...');
  //   runNewPoolObservation();
  // }
}

export function setPoolProcessed() {
  poolIsProcessing = false;
}

//runProgram().catch(console.error);