import {
  Connection, PublicKey,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  Commitment, KeyedAccountInfo
} from "@solana/web3.js";
import { printTime } from "./Utils";
import {
  GetStructureSchema,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityStateV4,
  Liquidity, LiquidityPoolKeys,
  MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V2,
  Market, struct, publicKey, Token, MARKET_STATE_LAYOUT_V3, MarketStateV3, LiquidityPoolKeysV4
} from "@raydium-io/raydium-sdk";
export const RAYDIUM_LIQUIDITY_PROGRAM_ID_V4 = MAINNET_PROGRAM_ID.AmmV4;
export const OPENBOOK_PROGRAM_ID = MAINNET_PROGRAM_ID.OPENBOOK_MARKET;
import chalk from 'chalk';
import bs58 from "bs58";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const MINIMAL_MARKET_STATE_LAYOUT_V3 = struct([
  publicKey('eventQueue'),
  publicKey('bids'),
  publicKey('asks'),
]);

export type MinimalMarketStateLayoutV3 = typeof MINIMAL_MARKET_STATE_LAYOUT_V3;
export type MinimalMarketLayoutV3 =
  GetStructureSchema<MinimalMarketStateLayoutV3>;

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

const OWNER_ADDRESS = new PublicKey(process.env.WALLET_PUBLIC_KEY!);

const solanaConnection = new Connection(process.env.RPC_URL!, {
  wsEndpoint: process.env.WS_URL!
});
const commitment: Commitment = 'confirmed';
const quoteToken = Token.WSOL;
let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<
  string,
  MinimalTokenAccountData
>();

function shouldBuy(key: string): boolean {
  return true;
  //return USE_SNIPE_LIST ? snipeList.includes(key) : true;
}

function createPoolKeys(
  id: PublicKey,
  accountData: LiquidityStateV4,
  minimalMarketLayoutV3: MinimalMarketLayoutV3,
): LiquidityPoolKeys {
  return {
    id,
    baseMint: accountData.baseMint,
    quoteMint: accountData.quoteMint,
    lpMint: accountData.lpMint,
    baseDecimals: accountData.baseDecimal.toNumber(),
    quoteDecimals: accountData.quoteDecimal.toNumber(),
    lpDecimals: 5,
    version: 4,
    programId: RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    authority: Liquidity.getAssociatedAuthority({
      programId: RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    }).publicKey,
    openOrders: accountData.openOrders,
    targetOrders: accountData.targetOrders,
    baseVault: accountData.baseVault,
    quoteVault: accountData.quoteVault,
    marketVersion: 3,
    marketProgramId: accountData.marketProgramId,
    marketId: accountData.marketId,
    marketAuthority: Market.getAssociatedAuthority({
      programId: accountData.marketProgramId,
      marketId: accountData.marketId,
    }).publicKey,
    marketBaseVault: accountData.baseVault,
    marketQuoteVault: accountData.quoteVault,
    marketBids: minimalMarketLayoutV3.bids,
    marketAsks: minimalMarketLayoutV3.asks,
    marketEventQueue: minimalMarketLayoutV3.eventQueue,
    withdrawQueue: accountData.withdrawQueue,
    lpVault: accountData.lpVault,
    lookupTableAccount: PublicKey.default,
  };
}

function makePool(
  accountId: PublicKey,
  accountData: LiquidityStateV4,
): LiquidityPoolKeys | null {
  const tokenAccount = existingTokenAccounts.get(
    accountData.baseMint.toString(),
  );

  if (!tokenAccount) {
    return null;
  }

  return createPoolKeys(
    accountId,
    accountData,
    tokenAccount.market!,
  );

  // tokenAccount.poolKeys = createPoolKeys(
  //   accountId,
  //   accountData,
  //   tokenAccount.market!,
  // );
  // const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
  //   {
  //     poolKeys: tokenAccount.poolKeys,
  //     userKeys: {
  //       tokenAccountIn: quoteTokenAssociatedAddress,
  //       tokenAccountOut: tokenAccount.address,
  //       owner: wallet.publicKey,
  //     },
  //     amountIn: quoteAmount.raw,
  //     minAmountOut: 0,
  //   },
  //   tokenAccount.poolKeys.version,
  // );

  // const latestBlockhash = await solanaConnection.getLatestBlockhash({
  //   commitment: commitment,
  // });
  // const messageV0 = new TransactionMessage({
  //   payerKey: wallet.publicKey,
  //   recentBlockhash: latestBlockhash.blockhash,
  //   instructions: [
  //     ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
  //     ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30000 }),
  //     createAssociatedTokenAccountIdempotentInstruction(
  //       wallet.publicKey,
  //       tokenAccount.address,
  //       wallet.publicKey,
  //       accountData.baseMint,
  //     ),
  //     ...innerTransaction.instructions,
  //   ],
  // }).compileToV0Message();
  // const transaction = new VersionedTransaction(messageV0);
  // transaction.sign([wallet, ...innerTransaction.signers]);
  // const signature = await solanaConnection.sendRawTransaction(
  //   transaction.serialize(),
  //   {
  //     maxRetries: 20,
  //     preflightCommitment: commitment,
  //   },
  // );
  // logger.info(
  //   {
  //     mint: accountData.baseMint,
  //     url: `https://solscan.io/tx/${signature}?cluster=${network}`,
  //   },
  //   'Buy',
  // );
}

function processRaydiumPool(updatedAccountInfo: KeyedAccountInfo): LiquidityPoolKeys | null {
  let accountData: LiquidityStateV4 | undefined;
  try {
    accountData = LIQUIDITY_STATE_LAYOUT_V4.decode(
      updatedAccountInfo.accountInfo.data,
    );

    if (!shouldBuy(accountData.baseMint.toString())) {
      return null;
    }

    return makePool(updatedAccountInfo.accountId, accountData);
  } catch (e) {
    console.error({ ...accountData, error: e }, `Failed to process pool`);
    return null;
  }
}

function processOpenBookMarket(
  updatedAccountInfo: KeyedAccountInfo,
) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(
      updatedAccountInfo.accountInfo.data,
    );

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    const ata = getAssociatedTokenAddressSync(
      accountData.baseMint,
      OWNER_ADDRESS,
    );
    existingTokenAccounts.set(accountData.baseMint.toString(), <
      MinimalTokenAccountData
      >{
        address: ata,
        mint: accountData.baseMint,
        market: <MinimalMarketLayoutV3>{
          bids: accountData.bids,
          asks: accountData.asks,
          eventQueue: accountData.eventQueue,
        },
      });
  } catch (e) {
    console.error({ ...accountData, error: e }, `Failed to process market`);
  }
}

export function startObserving(onNewPool: (pool: LiquidityPoolKeys) => void) {
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingLiquidityPools.has(key);
      if (!existing) {
        existingLiquidityPools.add(key);
        const pool = processRaydiumPool(updatedAccountInfo);
        let x: LiquidityPoolKeysV4

        if (pool !== null) {
          onNewPool(pool);
        }
      }
    },
    commitment,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      console.log('On OPENBOOK_PROGRAM_ID');
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key);
        const _ = processOpenBookMarket(updatedAccountInfo);
      }
    },
    commitment,
    [
      { dataSize: MARKET_STATE_LAYOUT_V2.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V2.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

}