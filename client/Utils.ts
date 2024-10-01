import { TOKEN_PROGRAM_ID, TokenAccount, SPL_ACCOUNT_LAYOUT, LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { Connection, PublicKey, SignatureResult, Commitment, TokenBalance } from '@solana/web3.js'
import chalk from 'chalk';
import { BN } from '@project-serum/anchor';
import { PoolKeys } from './PoolValidator/RaydiumPoolParser';

export function printTime(date: Date) {
  const formatted = formatDate(date);
  console.log(formatted);
}

export function formatDate(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
  const formattedTime = `${hours}:${minutes}:${seconds}.${milliseconds}`;
  return formattedTime;
}

export function timeout(ms: number, cancellationToken: { cancelled: boolean } | null = null): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      if (cancellationToken != null) {
        cancellationToken.cancelled = true;
      }
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function findTokenAccountAddress(connection: Connection, tokenMintAddress: PublicKey, owner: PublicKey): Promise<PublicKey | null> {
  const tokenAccountsByOwner = await connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID }
  );

  const myTokenAccount = tokenAccountsByOwner.value.find(account => account.account.data.parsed.info.mint === tokenMintAddress.toString());
  if (myTokenAccount) {
    console.log('Your token account address:', myTokenAccount.pubkey.toString());
    return myTokenAccount.pubkey;
  } else {
    console.log('Token account not found for this mint address and wallet.');
    return null;
  }
}

export async function getTransactionConfirmation(connection: Connection, txid: string): Promise<SignatureResult> {
  console.log(`Confirming...`)
  const confirmResult = await connection.confirmTransaction({ signature: txid, ...(await connection.getLatestBlockhash()) }, 'confirmed');
  console.log(`Confirming... Get results`)
  return confirmResult.value;
}

export async function confirmTransaction(connection: Connection, txid: string): Promise<boolean> {
  try {
    const confirmResult = await Promise.race([
      getTransactionConfirmation(connection, txid),
      timeout(20 * 1000)
    ])
    const transactionFailed = confirmResult.err !== null;
    if (transactionFailed) {
      console.log(`Buying transaction ${chalk.bold(txid)} ${chalk.red('FAILED')}. Error: ${chalk.redBright(JSON.stringify(confirmResult.err))}`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(`Buying transaction ${chalk.bold(txid)} ${chalk.red('FAILED')}. Error: ${chalk.redBright(e)}`);
    return false;
  }
}

export async function getTokenAccounts(
  connection: Connection,
  owner: PublicKey,
  commitment?: Commitment,
) {

  const tokenResp = await connection.getTokenAccountsByOwner(
    owner,
    {
      programId: TOKEN_PROGRAM_ID,
    },
    commitment,
  );

  const accounts: TokenAccount[] = [];
  for (const { pubkey, account } of tokenResp.value) {
    accounts.push({
      pubkey,
      programId: account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
    });
  }

  return accounts;
}

export async function getNewTokenBalance(connection: Connection, hash: string, tokenAddress: string, ownerAddress: string): Promise<TokenBalance | undefined> {
  let tr = await connection.getTransaction(hash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (tr === null) {
    const _ = await connection.getLatestBlockhash('confirmed');
    tr = await connection.getTransaction(hash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  }
  const postTokenBalances = tr?.meta?.postTokenBalances;
  if (postTokenBalances === null || postTokenBalances === undefined) {
    return undefined;
  }
  const tokenBalance = postTokenBalances.find((x) => x.mint === tokenAddress && x.owner === ownerAddress);
  return tokenBalance;
}

export async function makeTokenAccount() {
  //splToken.createAssociatedTokenAccountIdempotent
}

export function lamportsToSOLNumber(lamportsBN: BN, decimals: number = 9): number | undefined {
  //const SOL_DECIMALS = 9; // SOL has 9 decimal places
  const divisor = new BN(10).pow(new BN(decimals));

  // Convert lamports to SOL as a BN to maintain precision
  const solBN = lamportsBN.div(divisor);

  // Additionally, handle fractional part if necessary
  const fractionalBN = lamportsBN.mod(divisor);

  // Convert integer part to number
  if (solBN.lte(new BN(Number.MAX_SAFE_INTEGER))) {
    const integerPart = solBN.toNumber();
    const fractionalPart = fractionalBN.toNumber() / Math.pow(10, decimals);

    // Combine integer and fractional parts
    const total = integerPart + fractionalPart;

    return total;
  } else {
    console.warn('The amount of SOL exceeds the safe integer limit for JavaScript numbers.');
    return undefined; // or handle as appropriate
  }
}

export async function retryAsyncFunction<T, Args extends any[]>(
  fn: (...args: Args) => Promise<T>, // Async function to retry
  args: Args,                        // Arguments of the async function
  retries: number = 5,               // Number of retries
  delayMs: number = 300               // Delay between retries in milliseconds
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn(...args); // Attempt to execute the function
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries - 1) {
        await delay(delayMs) // Wait for the delay before retrying
      }
    }
  }

  // If all retries failed, throw the last error
  throw lastError;
}

export async function retryAsyncFunctionOrDefault<T, Args extends any[]>(
  fn: (...args: Args) => Promise<T>, // Async function to retry
  args: Args,                        // Arguments of the async function
  defaultValue: T,                       // Default value if all attempts failed
  retries: number = 5,               // Number of retries
  delay: number = 300               // Delay between retries in milliseconds
): Promise<T> {
  try {
    return retryAsyncFunction(fn, args, retries, delay)
  } catch {
    return defaultValue
  }
}

export function convertStringKeysToDataKeys(poolInfo: PoolKeys): LiquidityPoolKeysV4 {
  return {
    id: new PublicKey(poolInfo.id),
    baseMint: new PublicKey(poolInfo.baseMint),
    quoteMint: new PublicKey(poolInfo.quoteMint),
    lpMint: new PublicKey(poolInfo.lpMint),
    baseDecimals: poolInfo.baseDecimals,
    quoteDecimals: poolInfo.quoteDecimals,
    lpDecimals: poolInfo.lpDecimals,
    version: 4,
    programId: new PublicKey(poolInfo.programId),
    authority: new PublicKey(poolInfo.authority),
    openOrders: new PublicKey(poolInfo.openOrders),
    targetOrders: new PublicKey(poolInfo.targetOrders),
    baseVault: new PublicKey(poolInfo.baseVault),
    quoteVault: new PublicKey(poolInfo.quoteVault),
    withdrawQueue: new PublicKey(poolInfo.withdrawQueue),
    lpVault: new PublicKey(poolInfo.lpVault),
    marketVersion: 3,
    marketProgramId: new PublicKey(poolInfo.marketProgramId),
    marketId: new PublicKey(poolInfo.marketId),
    marketAuthority: new PublicKey(poolInfo.marketAuthority),
    marketBaseVault: new PublicKey(poolInfo.baseVault),
    marketQuoteVault: new PublicKey(poolInfo.quoteVault),
    marketBids: new PublicKey(poolInfo.marketBids),
    marketAsks: new PublicKey(poolInfo.marketAsks),
    marketEventQueue: new PublicKey(poolInfo.marketEventQueue),
  } as LiquidityPoolKeysV4;
}