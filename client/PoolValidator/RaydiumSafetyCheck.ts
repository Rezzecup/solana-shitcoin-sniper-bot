import { PublicKey, Connection, TokenBalance } from '@solana/web3.js'
import { LiquidityPoolKeysV4, WSOL } from '@raydium-io/raydium-sdk'
import { MINT_SIZE, MintLayout } from '@solana/spl-token'
import { BURN_ACC_ADDRESS } from './Addresses'
import { KNOWN_SCAM_ACCOUNTS } from './BlackLists'
import { BN } from "@project-serum/anchor";
import chalk from 'chalk'
import { delay, timeout } from '../Utils'
import { error } from 'console'
import { ParsedPoolCreationTx } from './RaydiumPoolValidator'

const RAYDIUM_OWNER_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

type OwnershipInfo = {
  mintAuthority: string | null,
  freezeAuthority: string | null,
  isMintable: boolean,
  totalSupply: number
}

type LiquidityValue = {
  amount: number,
  amountInUSD: number,
  symbol: string
}

export type PoolSafetyData = {
  creator: PublicKey,
  totalLiquidity: LiquidityValue,
  newTokenPoolBalancePercent: number,
  ownershipInfo: OwnershipInfo,
  pool: LiquidityPoolKeysV4,
  tokenMint: PublicKey
}

export type WaitLPBurning = {
  kind: 'WaitLPBurning',
  data: PoolSafetyData,
  lpTokenMint: PublicKey
}

export type WaitLPBurningComplete = {
  kind: 'WaitLPBurningComplete',
  data: PoolSafetyData,
  isliquidityLocked: boolean,
}

export type WaitLPBurningTooLong = {
  kind: 'WaitLPBurningTooLong',
  data: ParsedPoolCreationTx,
}

type CreatorIsInBlackList = {
  kind: 'CreatorIsScammer',
  pool: ParsedPoolCreationTx,
}

export type SafetyCheckComplete = {
  kind: 'Complete',
  isliquidityLocked: boolean,
  data: PoolSafetyData
}

export type SafetyCheckResult = WaitLPBurning | WaitLPBurningTooLong | WaitLPBurningComplete | CreatorIsInBlackList | SafetyCheckComplete

export async function checkToken(connection: Connection, data: ParsedPoolCreationTx, isLightCheck: boolean = false): Promise<SafetyCheckResult> {
  /// Check blacklist first
  if (KNOWN_SCAM_ACCOUNTS.has(data.creator.toString())) {
    return { kind: 'CreatorIsScammer', pool: data }
  }

  const pool = data.poolKeys

  const baseIsWSOL = pool.baseMint.toString() === WSOL.mint
  const otherTokenMint = new PublicKey(baseIsWSOL ? pool.quoteMint : pool.baseMint)

  /// Check mint and freeze authorities
  /// Ideally `not set`
  /// Not to bad if address is not cretor's
  /// Red-flag if addresses is the same as creator's
  const ownershipInfo = await getTokenOwnershipInfo(connection, otherTokenMint)

  // /// Check creators and authorities balances
  // const calcOwnershipPercent = async (address: PublicKey) => {
  //   const tokenAcc = getAssociatedTokenAddressSync(otherTokenMint, address)
  //   const value = (await connection.getTokenAccountBalance(tokenAcc)).value.uiAmount ?? 0
  //   return value / totalSupply
  // }

  // const creatorsPercentage = await calcOwnershipPercent(creatorAddress)
  // let authorityPercentage: number = 0
  // if (mintAuthority) {
  //   authorityPercentage = await calcOwnershipPercent(mintAuthority)
  // } else if (freezeAuthority) {
  //   authorityPercentage = await calcOwnershipPercent(freezeAuthority)
  // }

  ///Check largest holders
  /// Should Raydiium LP
  let newTokenPoolBalancePercent = 0
  if (!isLightCheck) {
    const largestAccounts = await connection.getTokenLargestAccounts(otherTokenMint);
    const raydiumTokenAccount = await connection.getParsedTokenAccountsByOwner(new PublicKey(RAYDIUM_OWNER_AUTHORITY), { mint: otherTokenMint });

    if (largestAccounts.value.length > 0 && raydiumTokenAccount.value.length > 0) {
      const poolAcc = raydiumTokenAccount.value[0].pubkey.toString()
      const poolBalance = largestAccounts.value.find(x => x.address.toString() === poolAcc)
      if (poolBalance) {
        newTokenPoolBalancePercent = (poolBalance.uiAmount ?? 0) / ownershipInfo.totalSupply
      }
    }
  }

  /// Get real liquiidity value
  const realCurrencyLPBalance = await connection.getTokenAccountBalance(new PublicKey(baseIsWSOL ? pool.baseVault : pool.quoteVault));
  //const lpVaultBalance = await connection.getTokenAccountBalance(poolKeys.lpVault);
  const SOL_EXCHANGE_RATE = 150 /// With EXTRA as of 08.03.2024
  const liquitity = realCurrencyLPBalance.value.uiAmount ?? 0;
  const isSOL = realCurrencyLPBalance.value.decimals === WSOL.decimals;
  const symbol = isSOL ? 'SOL' : 'USD';
  const amountInUSD = isSOL ? liquitity * SOL_EXCHANGE_RATE : liquitity

  const resultData: PoolSafetyData = {
    creator: data.creator,
    totalLiquidity: {
      amount: liquitity,
      amountInUSD,
      symbol
    },
    newTokenPoolBalancePercent,
    ownershipInfo,
    pool: data.binaryKeys,
    tokenMint: otherTokenMint
  }

  let isLiquidityLocked = false

  if (isLightCheck) {
    return { kind: 'Complete', data: resultData, isliquidityLocked: isLiquidityLocked }
  }

  isLiquidityLocked = await checkIfLPTokenBurnedWithRetry(connection, 3, 200, data.lpTokenMint)
  // Liqidity is not locked, but more than half of supply is in pool
  // Possible that LP token wiill be burned later. Wait for a few hours
  if (!isLiquidityLocked && newTokenPoolBalancePercent >= 0.5) {
    console.log(chalk.cyan(`Pools ${pool.id.toString()}. All tokens are in pool, but LP tokens aren't burned yet. Start verifying it`))
    return { kind: 'WaitLPBurning', data: resultData, lpTokenMint: data.lpTokenMint }
  }

  return { kind: 'Complete', data: resultData, isliquidityLocked: isLiquidityLocked }
}

export async function getTokenOwnershipInfo(connection: Connection, tokenMint: PublicKey): Promise<OwnershipInfo> {
  const otherTokenInfo = await connection.getAccountInfo(tokenMint)
  const mintInfo = MintLayout.decode(otherTokenInfo!.data!.subarray(0, MINT_SIZE))
  const totalSupply = Number(mintInfo.supply) / (10 ** mintInfo.decimals)
  let mintAuthority = mintInfo.mintAuthorityOption > 0 ? mintInfo.mintAuthority : null
  const freezeAuthority = mintInfo.freezeAuthorityOption > 0 ? mintInfo.freezeAuthority : null
  return {
    mintAuthority: mintAuthority?.toString() ?? null,
    freezeAuthority: freezeAuthority?.toString() ?? null,
    isMintable: mintAuthority !== null,
    totalSupply
  }
}

export async function checkLPTokenBurnedOrTimeout(
  connection: Connection,
  lpTokenMint: PublicKey,
  timeoutInMillis: number,
): Promise<boolean> {
  let isBurned = false
  try {
    isBurned = await Promise.race([
      listenToLPTokenSupplyChanges(connection, lpTokenMint),
      timeout(timeoutInMillis)
    ])

    return isBurned
  } catch (e) {
    console.log(`Timeout happened during refreshing burned LP tokens percent`)
    return isBurned
  }
}

async function listenToLPTokenSupplyChanges(
  connection: Connection,
  lpTokenMint: PublicKey,
): Promise<boolean> {
  console.log(`Subscribing to LP mint changes. Waiting to burn. Mint: ${lpTokenMint.toString()}`)
  return new Promise((resolve, reject) => {
    connection.onAccountChange(lpTokenMint, (accInfoBuffer, _) => {
      const lpTokenMintInfo = MintLayout.decode(accInfoBuffer.data.subarray(0, MINT_SIZE))
      const lastSupply = Number(lpTokenMintInfo.supply) / (10 ** lpTokenMintInfo.decimals)
      console.log(`LP token mint ${lpTokenMint.toString()} changed. Current supply: ${lastSupply}`)
      const isBurned = lastSupply <= 100
      if (isBurned) {
        console.log(`LP token ${lpTokenMint.toString()} is Burned`)
        resolve(isBurned)
      }
    })
  })
}

async function checkIfLPTokenBurnedWithRetry(
  connection: Connection,
  attempts: number,
  waitBeforeAttempt: number,
  lpTokenMint: PublicKey,
): Promise<boolean> {
  let attempt = 1
  while (attempt <= attempts) {
    try {
      const supply = await getTokenSupply(connection, lpTokenMint)
      if (supply <= 100) {
        return true
      }
      attempt += 1
      if (attempt > attempts) { return false }
      await delay(200 + waitBeforeAttempt)
    } catch (e) {
      console.log(chalk.red(`Failed to get LP token supply: ${e}.`))
      attempt += 1
      if (attempt > attempts) { return false }
      await delay(200 + waitBeforeAttempt)
    }
  }
  return false
}

async function getTokenSupply(
  connection: Connection,
  tokenMint: PublicKey
): Promise<number> {
  const accountInfo = await connection.getAccountInfo(tokenMint)
  if (!accountInfo) {
    throw error('Couldnt get token mint info')
  }
  const lpTokenMintInfo = MintLayout.decode(accountInfo.data.subarray(0, MINT_SIZE))
  const lastSupply = Number(lpTokenMintInfo.supply) / (10 ** lpTokenMintInfo.decimals)
  return lastSupply
}

const BURN_INSTRCUTIONS = new Set(['burnChecked', 'burn'])

async function getPercentOfBurnedTokens(
  connection: Connection,
  lpTokenAccount: PublicKey,
  lpTokenMint: string,
  mintTxLPTokenBalance: TokenBalance,
): Promise<number> {
  const lpTokenAccountTxIds = await connection.getConfirmedSignaturesForAddress2(lpTokenAccount)
  const lpTokenAccountTxs = await connection
    .getParsedTransactions(
      lpTokenAccountTxIds.map(x => x.signature),
      { maxSupportedTransactionVersion: 0 })

  const filteredLPTokenAccountTxs = lpTokenAccountTxs.filter(x => x && x.meta && !x.meta.err)

  /// Check for either BURN instruction
  /// Transferring to burn address
  let totalLPTokensBurned: number = 0
  for (let i = 0; i < filteredLPTokenAccountTxs.length; i++) {
    const parsedWithMeta = filteredLPTokenAccountTxs[i]
    if (!parsedWithMeta || !parsedWithMeta.meta) { continue }
    const preLPTokenBalance = parsedWithMeta.meta.preTokenBalances?.find(x => x.mint === lpTokenMint)
    const postLPTokenBalance = parsedWithMeta.meta.postTokenBalances?.find(x => x.mint === lpTokenMint)
    const burnInstructions = parsedWithMeta.transaction
      .message.instructions
      .map((x: any) => x.parsed)
      .filter(x => x && BURN_INSTRCUTIONS.has(x.type) && x.info.mint === lpTokenMint)

    if (burnInstructions && burnInstructions.length > 0) {
      const amountBurned: BN = burnInstructions.reduce((acc: BN, x) => {
        const amount = x.info?.amount ?? x.info?.tokenAmount?.amount
        if (amount) {
          const currencyAmount = new BN(amount)
          return acc.add(currencyAmount)
        }
      }, new BN('0'))
      const burnedInHuman = amountBurned.toNumber() / (10 ** mintTxLPTokenBalance.uiTokenAmount.decimals)
      totalLPTokensBurned += burnedInHuman
    } else {
      const burnAddressInMessage = parsedWithMeta.transaction.message.accountKeys.find(x => x.pubkey.toString() === BURN_ACC_ADDRESS)
      if (burnAddressInMessage) {
        totalLPTokensBurned += (preLPTokenBalance?.uiTokenAmount.uiAmount ?? 0) - (postLPTokenBalance?.uiTokenAmount.uiAmount ?? 0)
      }
    }
  }

  return totalLPTokensBurned / (mintTxLPTokenBalance.uiTokenAmount.uiAmount ?? 1)
}