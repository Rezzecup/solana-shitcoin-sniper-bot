import {
  ApiClmmConfigItem,
  ApiClmmPoolsItem,
  PoolInfoLayout
} from '@raydium-io/raydium-sdk';
import {
  PublicKey,
  Connection
} from '@solana/web3.js';

import { formatConfigInfo } from './formaClmmConfigs';
import { getApiClmmPoolsItemStatisticsDefault } from './formatClmmKeys';

async function getMintProgram(connection: Connection, mint: PublicKey) {
  const account = await connection.getAccountInfo(mint)
  if (account === null) throw Error(`getMintProgram - get id info error, mint ${mint.toString()}`)
  return account.owner
}
async function getConfigInfo(connection: Connection, configId: PublicKey): Promise<ApiClmmConfigItem> {
  const account = await connection.getAccountInfo(configId)
  if (account === null) throw Error(`getConfigInfo - get id info error, configId ${configId}`)
  return formatConfigInfo(configId, account)
}

export async function formatClmmKeysById(connection: Connection, id: string): Promise<ApiClmmPoolsItem> {
  const account = await connection.getAccountInfo(new PublicKey(id))
  if (account === null) throw Error(`formatClmmKeysById - get id info error, id ${id}`)
  const info = PoolInfoLayout.decode(account.data)

  return {
    id,
    mintProgramIdA: (await getMintProgram(connection, info.mintA)).toString(),
    mintProgramIdB: (await getMintProgram(connection, info.mintB)).toString(),
    mintA: info.mintA.toString(),
    mintB: info.mintB.toString(),
    vaultA: info.vaultA.toString(),
    vaultB: info.vaultB.toString(),
    mintDecimalsA: info.mintDecimalsA,
    mintDecimalsB: info.mintDecimalsB,
    ammConfig: await getConfigInfo(connection, info.ammConfig),
    rewardInfos: await Promise.all(
      info.rewardInfos
        .filter((i) => !i.tokenMint.equals(PublicKey.default))
        .map(async (i) => ({
          mint: i.tokenMint.toString(),
          programId: (await getMintProgram(connection, i.tokenMint)).toString(),
        }))
    ),
    tvl: 0,
    day: getApiClmmPoolsItemStatisticsDefault(),
    week: getApiClmmPoolsItemStatisticsDefault(),
    month: getApiClmmPoolsItemStatisticsDefault(),
    lookupTableAccount: PublicKey.default.toBase58(),
  }
}