import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { config } from './Config'
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { error } from 'console';
import { ApiPoolInfoV4, LIQUIDITY_STATE_LAYOUT_V4, Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, MARKET_STATE_LAYOUT_V3, Market } from '@raydium-io/raydium-sdk';

const RAYDIUM_POOL_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'

type operation = 'buy' | 'sell'

// const argv = yargs(hideBin(process.argv)).options({
//   operation: { type: 'string', default: 'sell' },
//   mint: { type: 'string', demandOption: true },
//   pair: { type: 'string', demandOption: true },
//   amount: { type: 'number', default: 0.1 },
// }).parseSync()

// async function main() {
//   config.simulateOnly = false
//   const connection = new Connection(config.rpcHttpURL, {
//     wsEndpoint: config.rpcWsURL
//   })

//   const mintAddress = new PublicKey(argv.mint)
//   const poolInfo = await getPoolInfo(connection, new PublicKey(argv.pair))
//   console.log(poolInfo)
// }

export async function getPoolInfo(connection: Connection, poolId: PublicKey): Promise<ApiPoolInfoV4> {
  const info = await connection.getAccountInfo(poolId);
  if (!info) {
    throw error('No Pool Info')
  }

  let amAccountData = { id: poolId, programId: info.owner, ...LIQUIDITY_STATE_LAYOUT_V4.decode(info.data) }
  const marketProgramId = amAccountData.marketProgramId
  const allMarketInfo = await connection.getAccountInfo(marketProgramId)
  if (!allMarketInfo) {
    throw error('No Pool Info')
  }
  const itemMarketInfo = MARKET_STATE_LAYOUT_V3.decode(allMarketInfo.data)


  const marketInfo = {
    marketProgramId: allMarketInfo.owner.toString(),
    marketAuthority: Market.getAssociatedAuthority({ programId: allMarketInfo.owner, marketId: marketProgramId }).publicKey.toString(),
    marketBaseVault: itemMarketInfo.baseVault.toString(),
    marketQuoteVault: itemMarketInfo.quoteVault.toString(),
    marketBids: itemMarketInfo.bids.toString(),
    marketAsks: itemMarketInfo.asks.toString(),
    marketEventQueue: itemMarketInfo.eventQueue.toString()
  }

  const format: ApiPoolInfoV4 = {
    id: amAccountData.id.toString(),
    baseMint: amAccountData.baseMint.toString(),
    quoteMint: amAccountData.quoteMint.toString(),
    lpMint: amAccountData.lpMint.toString(),
    baseDecimals: amAccountData.baseDecimal.toNumber(),
    quoteDecimals: amAccountData.quoteDecimal.toNumber(),
    lpDecimals: amAccountData.baseDecimal.toNumber(),
    version: 4,
    programId: amAccountData.programId.toString(),
    authority: Liquidity.getAssociatedAuthority({ programId: amAccountData.programId }).publicKey.toString(),
    openOrders: amAccountData.openOrders.toString(),
    targetOrders: amAccountData.targetOrders.toString(),
    baseVault: amAccountData.baseVault.toString(),
    quoteVault: amAccountData.quoteVault.toString(),
    withdrawQueue: amAccountData.withdrawQueue.toString(),
    lpVault: amAccountData.lpVault.toString(),
    marketVersion: 3,
    marketId: amAccountData.marketId.toString(),
    ...marketInfo,
    lookupTableAccount: PublicKey.default.toString()
  }

  return format
}

async function buy(connection: Connection, mintAddress: PublicKey) {
  const allAccs = (await connection.getProgramAccounts(new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID))).values

  const poolAddress = getAssociatedTokenAddressSync(mintAddress, new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID))
  return poolAddress.toString()
}

// function convertStringKeysToDataKeys(poolId: PublicKey, poolInfo: LiquidityStateV4): LiquidityPoolKeysV4 {
//   return {
//     id: poolId,
//     baseMint: poolInfo.baseMint,
//     quoteMint: poolInfo.quoteMint,
//     lpMint: poolInfo.lpMint,
//     baseDecimals: poolInfo.baseDecimal.toNumber(),
//     quoteDecimals: poolInfo.quoteDecimal.toNumber(),
//     lpDecimals: 6,
//     version: 4,
//     programId: poolInfo.marketProgramId,
//     authority: new ,
//     openOrders: new PublicKey(poolInfo.openOrders),
//     targetOrders: new PublicKey(poolInfo.targetOrders),
//     baseVault: new PublicKey(poolInfo.baseVault),
//     quoteVault: new PublicKey(poolInfo.quoteVault),
//     withdrawQueue: new PublicKey(poolInfo.withdrawQueue),
//     lpVault: new PublicKey(poolInfo.lpVault),
//     marketVersion: 3,
//     marketProgramId: new PublicKey(poolInfo.marketProgramId),
//     marketId: new PublicKey(poolInfo.marketId),
//     marketAuthority: new PublicKey(poolInfo.marketAuthority),
//     marketBaseVault: new PublicKey(poolInfo.baseVault),
//     marketQuoteVault: new PublicKey(poolInfo.quoteVault),
//     marketBids: new PublicKey(poolInfo.marketBids),
//     marketAsks: new PublicKey(poolInfo.marketAsks),
//     marketEventQueue: new PublicKey(poolInfo.marketEventQueue),
//   } as LiquidityPoolKeysV4;
// }

// main().catch(console.error)