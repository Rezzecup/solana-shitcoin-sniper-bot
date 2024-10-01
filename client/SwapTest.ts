import * as dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import { confirmTransaction, findTokenAccountAddress, getTokenAccounts, getNewTokenBalance } from './Utils';
import { TokenAmount, Token, Percent, jsonInfo2PoolKeys, LiquidityPoolKeys, WSOL, ASSOCIATED_TOKEN_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Wallet } from '@project-serum/anchor'
import base58 from 'bs58'
import { swapOnlyCLMM } from "./CllmSwap"
import { DEFAULT_TOKEN } from './RaydiumConfig';
import { getWalletTokenAccount } from './RaydiumUtils';
import { swapOnlyAmm } from './RaydiumAMM/AmmSwap'
import chalk from 'chalk';
import { formatAmmKeysById } from './RaydiumAMM/formatAmmKeysById';
import { swapTokens, sellTokens } from './Swap';
import RaydiumSwap from './RaydiumSwap';

const wallet = new Wallet(Keypair.fromSecretKey(base58.decode(process.env.WALLET_PRIVATE_KEY!)));
const SHIT = '8w63or5Dfjb24TYmzXnY3VHPsczA1pUT7SzDW3JFe6Uz';
const SHIT_POOL_ID = '4doQnCB4ppx2oPfewcYrp63i7fvRN5bWb9x1XZwt6j3S';
const BUY_AMOUNT_IN_SOL = 0.01 // e.g. 0.01 SOL -> B_TOKEN


const connection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!, commitment: 'confirmed'
});

async function runSwapTest() {
  const [wsolAccountAddress] = PublicKey.findProgramAddressSync(
    [wallet.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log('Startttt')
  const targetPoolInfo = await formatAmmKeysById(connection, SHIT_POOL_ID);
  const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys

  const tokenToSnipe = new Token(TOKEN_PROGRAM_ID, new PublicKey(SHIT), 9)
  const quoteToken = DEFAULT_TOKEN.WSOL;
  const quoteTokenAmount = new TokenAmount(quoteToken, 0.01, false)
  const allWalletTokenAccounts = await getWalletTokenAccount(connection, wallet.publicKey)

  const shitCoinAccount = allWalletTokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === SHIT,
  )?.pubkey ?? getAssociatedTokenAddressSync(new PublicKey(SHIT), wallet.publicKey, false);

  const startWsolBalance = await connection.getTokenAccountBalance(wsolAccountAddress)

  const buyTxid = await swapTokens(
    connection,
    poolKeys,
    wsolAccountAddress,
    shitCoinAccount,
    wallet,
    quoteTokenAmount
  );

  // const [buyTxid] = (await swapOnlyAmm(connection, wallet.payer, {
  //   outputToken: tokenToSnipe,
  //   targetPool: SHIT_POOL_ID,
  //   inputTokenAmount: quoteTokenAmount,
  //   slippage: buySlippage,
  //   walletTokenAccounts: allWalletTokenAccounts,
  //   wallet: wallet.payer,
  // })).txids;

  console.log(`BUY tx https://solscan.io/tx/${buyTxid}`);

  console.log(`${chalk.yellow('Confirming...')}`);
  // const _ = await connection.getLatestBlockhash({
  //   commitment: 'confirmed',
  // });
  const transactionConfirmed = await confirmTransaction(connection, buyTxid);
  if (transactionConfirmed) {
    console.log(`${chalk.green('Confirmed')}`);
  } else {
    console.log(`${chalk.red('Failed :(')}`);
    return;
  }

  // const shitCoinAcc = await findTokenAccountAddress(connection, tokenToSnipe.mint, wallet.publicKey);
  // if (shitCoinAcc === null) {
  //   console.error("Failed to fetch token balance after transaction");
  //   return;
  // }

  const shitTokenBalance = await getNewTokenBalance(connection, buyTxid, SHIT, wallet.publicKey.toString());
  let snipedUIAmount: number
  if (shitTokenBalance !== undefined) {
    snipedUIAmount = shitTokenBalance.uiTokenAmount.uiAmount ?? 0;
  } else {
    console.log(`${chalk.red("Couldn't fetch new balance. Trying to fetch account with balance")}`)
    const balance = (await connection.getTokenAccountBalance(shitCoinAccount)).value
    snipedUIAmount = balance.uiAmount ?? 0
  }
  if (snipedUIAmount <= 0) {
    console.log(`${chalk.red("Couldn't get token balance, try to sell ot manually.")}`)
    console.log(`${chalk.yellow("BUY tx:")} ${buyTxid}`);
    return;
  }

  console.log(`${chalk.yellow(`Got ${snipedUIAmount} tokens`)}`);
  console.log('Selling')

  const sellTokenAmount = new TokenAmount(tokenToSnipe, snipedUIAmount, false)

  // const sellTxid = await sellTokens(connection, poolKeys, wsolAccount, shitCoinAcc, wallet, sellTokenAmount);

  let sellTxid = await swapTokens(
    connection,
    poolKeys,
    shitCoinAccount,
    wsolAccountAddress,
    wallet,
    sellTokenAmount
  );

  // let [sellTxid] = (await swapOnlyAmm(connection, wallet.payer, {
  //   outputToken: quoteToken,
  //   targetPool: SHIT_POOL_ID,
  //   inputTokenAmount: sellTokenAmount,
  //   slippage: sellSlippage,
  //   walletTokenAccounts: updatedWalletTokenAccounts,
  //   wallet: wallet.payer,
  // })).txids;

  console.log(`SELL tx https://solscan.io/tx/${sellTxid}`);

  console.log(`${chalk.yellow('Confirming...')}`);
  const sellConfirmed = await confirmTransaction(connection, sellTxid);
  if (sellConfirmed) {
    console.log(`${chalk.green('Confirmed')}`);
  } else {
    console.log(`${chalk.red('Failed :( retry sell')}`);
    const sellTokenAmount = new TokenAmount(tokenToSnipe, snipedUIAmount, false)

    // const sellTxid = await sellTokens(connection, poolKeys, wsolAccount, shitCoinAcc, wallet, sellTokenAmount);

    sellTxid = await swapTokens(
      connection,
      poolKeys,
      shitCoinAccount,
      wsolAccountAddress,
      wallet,
      sellTokenAmount
    );

    console.log(`${chalk.yellow('Confirming...')}`);
    const sellRetryConfirmed = await confirmTransaction(connection, sellTxid);
    if (sellRetryConfirmed) {
      console.log(`${chalk.green('Confirmed')}`);
    } else {
      console.log(`${chalk.red('Failed :( retry sell')}`);
    }
  }



  const finalWsolBalance = await getNewTokenBalance(connection, sellTxid, WSOL.mint, wallet.publicKey.toString());
  const startNumber = startWsolBalance.value.uiAmount ?? 0;
  const endNumber = finalWsolBalance?.uiTokenAmount.uiAmount ?? 0;
  const shotProfit = (endNumber - startNumber) / 0.01;
  const profitInPercent = shotProfit * 100;
  const formatted = Number(profitInPercent.toPrecision(3));
  const finalProfitString = formatted.toFixed(1) + '%';

  console.log(`Start WSOL: ${startNumber}`);
  console.log(`End WSOL: ${endNumber}`);
  console.log(`Shot profit: ${shotProfit > 0 ? chalk.green(finalProfitString) : chalk.red(finalProfitString)}`);
}

runSwapTest();