import { CurrencyAmount, Fraction, Liquidity, LiquidityPoolKeysV4, Percent, Price, SOL, Token, TokenAccount, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import { Connection, PublicKey, Commitment, TransactionMessage, ComputeBudgetProgram, VersionedTransaction, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'
import chalk from "chalk";
import { delay, lamportsToSOLNumber, timeout } from "./Utils";
import { onTradingPNLChanged } from "./StateAggregator/ConsoleOutput";
import * as nacl from "tweetnacl";

export async function swapTokens(
  connection: Connection,
  poolKeys: LiquidityPoolKeysV4,
  tokenAccountIn: PublicKey,
  tokenAccountOut: PublicKey,
  signer: Wallet,
  amountIn: TokenAmount,
  commitment: Commitment = 'confirmed'
): Promise<string> {
  const otherTokenMint = (poolKeys.baseMint.toString() === WSOL.mint) ? poolKeys.quoteMint : poolKeys.baseMint;
  const associatedTokenAcc = (amountIn.token.mint.toString() === WSOL.mint) ? tokenAccountOut : tokenAccountIn;
  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: tokenAccountIn,
        tokenAccountOut: tokenAccountOut,
        owner: signer.publicKey,
      },
      amountIn: amountIn.raw,
      minAmountOut: 0,
    },
    poolKeys.version,
  );

  console.log(`Getting last block`)
  const blockhashResponse = await connection.getLatestBlockhashAndContext();
  const lastValidBlockHeight = blockhashResponse.context.slot + 150;
  const recentFee = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: [new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')] })
  const avgFee = (recentFee.reduce((sum, x) => sum + x.prioritizationFee, 0)) / recentFee.length
  console.log(`Avg fee: ${avgFee}`)
  const effectiveFee = Math.round(avgFee * 1.5)
  console.log(`Effective Fee: ${effectiveFee}`)
  // const latestBlockhash = await connection.getLatestBlockhash({
  //   commitment: 'finalized',
  // });
  console.log(`Building tx`)

  const messageV0 = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhashResponse.value.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: effectiveFee }),
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        associatedTokenAcc,
        signer.publicKey,
        otherTokenMint,
      ),
      ...innerTransaction.instructions,
    ],
  }).compileToV0Message();


  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([signer.payer]);
  console.log(`Sending tx`)
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: true,
      maxRetries: 20
    },
  );

  console.log(`Tx sent https://solscan.io/tx/${signature}`)
  return signature;
}

export async function sellTokens(
  connection: Connection,
  poolKeys: LiquidityPoolKeysV4,
  quoteTokenAccount: TokenAccount,
  baseTokenAccount: TokenAccount,
  signer: Wallet,
  amountToSell: TokenAmount,
  commitment: Commitment = 'confirmed'
): Promise<string> {
  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: baseTokenAccount.pubkey,
        tokenAccountOut: quoteTokenAccount.pubkey,
        owner: signer.publicKey,
      },
      amountIn: amountToSell.raw,
      minAmountOut: 0,
    },
    poolKeys.version,
  );

  const latestBlockhash = await connection.getLatestBlockhash({
    commitment: 'finalized',
  });
  const messageV0 = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        baseTokenAccount.pubkey,
        signer.publicKey,
        baseTokenAccount.accountInfo.mint,
      ),
      ...innerTransaction.instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([signer.payer, ...innerTransaction.signers]);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: commitment,
    },
  );
  return signature;
}

export async function calculateAmountOut(connection: Connection, amountIn: TokenAmount, tokenOut: Token, poolKeys: LiquidityPoolKeysV4) {
  const poolInfo = await Liquidity.fetchInfo({ connection: connection, poolKeys })
  const slippage = new Percent(1000, 100); // 1000% slippage

  const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut: tokenOut,
    slippage,
  })

  return {
    amountIn,
    amountOut,
    minAmountOut,
    currentPrice,
    executionPrice,
    priceImpact,
    fee,
  }
}

export async function calcProfit(
  spent: number,
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4): Promise<{ currentAmountOut: number, profit: number } | null> {
  try {
    const {
      amountOut,
      minAmountOut,
      currentPrice,
      executionPrice,
      priceImpact,
      fee,
    } = await calculateAmountOut(connection, amountIn, tokenOut, poolKeys)
    // console.log(chalk.yellow('Calculated sell prices'));
    // console.log(`${chalk.bold('current price: ')}: ${currentPrice.toFixed()}`);
    // if (executionPrice !== null) {
    //   console.log(`${chalk.bold('execution price: ')}: ${executionPrice.toFixed()}`);
    // }
    // console.log(`${chalk.bold('price impact: ')}: ${priceImpact.toFixed()}`);
    // console.log(`${chalk.bold('amount out: ')}: ${amountOut.toFixed()}`);
    // console.log(`${chalk.bold('min amount out: ')}: ${minAmountOut.toFixed()}`);

    const amountOutInSOL = lamportsToSOLNumber(amountOut.raw) ?? 0
    const potentialProfit = (amountOutInSOL - spent) / spent;

    return { currentAmountOut: amountOutInSOL, profit: potentialProfit };
  } catch (e) {
    console.error('Faiiled to calculate amountOut and profit.');
    return null;
  }
}

async function loopAndWaitForProfit(
  spentAmount: number,
  targetProfitPercentage: number,
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4,
  amountOutCalculationDelayMs: number,
  profitObject: { amountOut: number, profit: number },
  cancellationToken: { cancelled: boolean }
) {
  console.log(`Target profit: ${targetProfitPercentage}`)
  const STOP_LOSS_PERCENT = -0.5

  let profitToTakeOrLose: number = 0;
  let prevAmountOut: number = 0;
  let priceDownCounter = 5;
  //priceDownCounter > 0 && 
  do {
    if (cancellationToken.cancelled) {
      break;
    }
    try {
      const calculationResult = await calcProfit(spentAmount, connection, amountIn, tokenOut, poolKeys);
      if (calculationResult !== null) {
        const { currentAmountOut, profit } = calculationResult;
        const profitChanges = Math.abs(profit - profitToTakeOrLose)
        if (profitChanges >= 0.01) {
          onTradingPNLChanged(poolKeys.id.toString(), profit)
        }
        profitToTakeOrLose = profit;
        profitObject.profit = profit
        profitObject.amountOut = currentAmountOut

        if (currentAmountOut < prevAmountOut) {
          priceDownCounter -= 1;
        } else {
          if (priceDownCounter < 5) { priceDownCounter += 1; }
        }

        prevAmountOut = currentAmountOut;
      }
      await delay(amountOutCalculationDelayMs);
    } catch (e) {
      await delay(amountOutCalculationDelayMs);
    }
  } while (profitToTakeOrLose < targetProfitPercentage && profitToTakeOrLose > STOP_LOSS_PERCENT)

  return { amountOut: prevAmountOut, profit: profitToTakeOrLose };
}

export async function waitForProfitOrTimeout(
  spentAmount: number,
  targetProfitPercentage: number,
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4,
  profitCalculationIterationDelayMs: number,
  timeutInMillis: number
): Promise<{ amountOut: number, profit: number }> {
  const cancellationToken = { cancelled: false }
  let profitObject: { amountOut: number, profit: number } = { amountOut: 0, profit: 0 }
  try {
    await Promise.race([
      loopAndWaitForProfit(spentAmount, targetProfitPercentage, connection, amountIn, tokenOut, poolKeys, profitCalculationIterationDelayMs, profitObject, cancellationToken),
      timeout(timeutInMillis, cancellationToken)
    ])
  } catch (e) {
    const profitInPercent = (profitObject.profit * 100).toFixed(2) + '%'
    console.error(`Timeout happened ${chalk.bold('Profit to take: ')} ${profitObject.profit < 0 ? chalk.red(profitInPercent) : chalk.green(profitInPercent)}`);
  }
  return { amountOut: profitObject.amountOut, profit: profitObject.profit }
}

export async function validateTradingTrendOrTimeout(
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4): Promise<GeneralTokenCondition | null> {
  let trendingCondition: GeneralTokenCondition | null;
  const cancellationToken = { cancelled: false }
  try {
    trendingCondition = await Promise.race([
      loopAndCheckPriceTrend(connection, amountIn, tokenOut, poolKeys, cancellationToken),
      timeout(30 * 1000, cancellationToken) // 30 seconds
    ]);
  } catch (e) {
    console.error(chalk.red(`Timeout happend. Can't identify trend.`));
    return null;
  }
  return trendingCondition;
}

type PriceTrend = 'UP' | 'DOWN' | 'UNSTABLE';
export type GeneralTokenCondition =
  'PUMPING' | 'DUMPING' | 'NOT_PUMPING_BUT_GROWING' | 'NOT_DUMPING_BUT_DIPPING' | 'ALREADY_DUMPED'

async function loopAndCheckPriceTrend(
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4,
  cancellationToken: { cancelled: boolean }
): Promise<GeneralTokenCondition | null> {
  if (cancellationToken.cancelled) {
    return null;
  }
  const amountOfChecks = 5;
  let failedAttempts = 0;
  let prevPriceTrend: PriceTrend = 'DOWN';
  let allChecks: { amountOut: TokenAmount | CurrencyAmount, trend: PriceTrend }[] = new Array();

  for (let i = 1; i <= amountOfChecks; i++) {
    const priceTrend = await checkPriceTrend(connection, amountIn, tokenOut, poolKeys);
    if (cancellationToken.cancelled) {
      return null;
    }
    if (priceTrend === null) {
      failedAttempts += 1;
    } else {
      allChecks.push(priceTrend);
    }
  }
  const lastItemsIndex = amountOfChecks - failedAttempts - 1;

  if (cancellationToken.cancelled) {
    return null;
  }

  if (failedAttempts > 2) {
    console.error(chalk.red(`Too many fails. Can't see the trend`));
    return null;
  }

  if (allChecks.find((x) => x.trend === 'UNSTABLE')) {
    /// Price is too valotile, most likely it's already dumped
    return 'ALREADY_DUMPED'
  }

  const upsCount = allChecks.filter((x) => x.trend === 'UP').length;
  const downsCount = allChecks.filter((x) => x.trend === 'DOWN').length;

  if (allChecks[0].amountOut.lt(allChecks[lastItemsIndex].amountOut)) { // overall growing trend
    return (upsCount - downsCount) > 2 ? 'PUMPING' : 'NOT_PUMPING_BUT_GROWING';
  } else { // overall dipping trend
    return (downsCount - upsCount) > 2 ? 'DUMPING' : 'NOT_DUMPING_BUT_DIPPING';
  }
}

async function checkPriceTrend(
  connection: Connection,
  amountIn: TokenAmount,
  tokenOut: Token,
  poolKeys: LiquidityPoolKeysV4): Promise<{ amountOut: TokenAmount | CurrencyAmount, trend: PriceTrend } | null> {
  try {
    const firstAttempt = await calculateAmountOut(connection, amountIn, tokenOut, poolKeys)
    await delay(200);
    const secodAttempt = await calculateAmountOut(connection, amountIn, tokenOut, poolKeys)

    const dumpedPriceImpactPercent = 29 /// 30%
    const secondPriceImpact = Number(secodAttempt.priceImpact)
    const firstPriceImpact = Number(firstAttempt.priceImpact)
    if (secondPriceImpact > dumpedPriceImpactPercent || firstPriceImpact > dumpedPriceImpactPercent) {
      return { amountOut: secodAttempt.amountOut, trend: 'UNSTABLE' }
    }

    const trend = firstAttempt.amountOut.gt(secodAttempt.amountOut) ? 'DOWN' : 'UP';
    return { amountOut: secodAttempt.amountOut, trend };
  } catch (e) {
    console.error(chalk.yellow('Failed to get amountOut and identify price trend.'));
    return null;
  }
}