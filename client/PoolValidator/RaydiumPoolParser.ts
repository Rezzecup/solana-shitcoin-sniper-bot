import { LiquidityPoolKeysV4, Market, MARKET_STATE_LAYOUT_V3, TOKEN_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  ParsedInnerInstruction,
  ParsedInstruction
} from "@solana/web3.js";
import chalk from "chalk";
import { delay } from "../Utils";

const RAYDIUM_POOL_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const SERUM_OPENBOOK_PROGRAM_ID = 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

export interface PoolKeys {
  id: string,
  baseMint: string,
  quoteMint: string,
  lpMint: string,
  baseDecimals: number,
  quoteDecimals: number,
  lpDecimals: number,
  version: number,
  programId: string,
  authority: string,
  openOrders: string,
  targetOrders: string,
  baseVault: string,
  quoteVault: string,
  withdrawQueue: string,
  lpVault: string,
  marketVersion: number,
  marketProgramId: string,
  marketId: string,
  marketAuthority: string,
  marketBaseVault: string,
  marketQuoteVault: string,
  marketBids: string,
  marketAsks: string,
  marketEventQueue: string,
}

export function findLogEntry(needle: string, logEntries: Array<string>): string | null {
  for (let i = 0; i < logEntries.length; ++i) {
    if (logEntries[i].includes(needle)) {
      return logEntries[i];
    }
  }

  return null;
}

export async function fetchPoolKeysForLPInitTransactionHash(connection: Connection, txSignature: string)
  : Promise<{ poolKeys: PoolKeys, mintTransaction: ParsedTransactionWithMeta }> {
  console.log(chalk.yellow(`Fetching TX inf ${txSignature}`));
  const tx = await retryGetParsedTransaction(connection, txSignature, 5)
  if (!tx) {
    throw new Error('Failed to fetch transaction with signature ' + txSignature);
  }
  const poolInfo = parsePoolInfoFromLpTransaction(tx);
  const marketInfo = await fetchMarketInfo(connection, poolInfo.marketId);

  const keys = {
    id: poolInfo.id.toString(),
    baseMint: poolInfo.baseMint.toString(),
    quoteMint: poolInfo.quoteMint.toString(),
    lpMint: poolInfo.lpMint.toString(),
    baseDecimals: poolInfo.baseDecimals,
    quoteDecimals: poolInfo.quoteDecimals,
    lpDecimals: poolInfo.lpDecimals,
    version: 4,
    programId: poolInfo.programId.toString(),
    authority: poolInfo.authority.toString(),
    openOrders: poolInfo.openOrders.toString(),
    targetOrders: poolInfo.targetOrders.toString(),
    baseVault: poolInfo.baseVault.toString(),
    quoteVault: poolInfo.quoteVault.toString(),
    withdrawQueue: poolInfo.withdrawQueue.toString(),
    lpVault: poolInfo.lpVault.toString(),
    marketVersion: 3,
    marketProgramId: poolInfo.marketProgramId.toString(),
    marketId: poolInfo.marketId.toString(),
    marketAuthority: Market.getAssociatedAuthority({ programId: poolInfo.marketProgramId, marketId: poolInfo.marketId }).publicKey.toString(),
    marketBaseVault: marketInfo.baseVault.toString(),
    marketQuoteVault: marketInfo.quoteVault.toString(),
    marketBids: marketInfo.bids.toString(),
    marketAsks: marketInfo.asks.toString(),
    marketEventQueue: marketInfo.eventQueue.toString(),
  }
  return { mintTransaction: tx, poolKeys: keys }
}

async function retryGetParsedTransaction(
  connection: Connection,
  txSignature: string,
  maxAttempts: number,
  delayMs: number = 200,
  attempt: number = 1
): Promise<ParsedTransactionWithMeta | null> {
  try {
    console.log(`Attempt ${attempt} to get  https://solscan.io/tx/${txSignature} info`)
    const tx = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0 });
    if (tx !== null) {
      console.log(`Successfully fetched https://solscan.io/tx/${txSignature} info from attempt ${attempt}`)
      return tx; // Return the transaction if it's not null
    } else if (attempt < maxAttempts) {
      console.log(`Attempt ${attempt} failed, retrying...`)
      await delay(delayMs) // Wait for the specified delay
      return retryGetParsedTransaction(connection, txSignature, maxAttempts, delayMs, attempt + 1);
    } else {
      console.log('Max attempts reached, returning null');
      return null; // Return null if max attempts are reached
    }
  } catch (error) {
    console.error(`Attempt ${attempt} failed with error: ${error}, retrying...`);
    if (attempt < maxAttempts) {
      await delay(delayMs) // Wait for the specified delay // Wait for the specified delay before retrying
      return retryGetParsedTransaction(connection, txSignature, maxAttempts, delayMs, attempt + 1);
    } else {
      console.log('Max attempts reached, returning null');
      return null; // Return null if max attempts are reached
    }
  }
}

async function fetchMarketInfo(connection: Connection, marketId: PublicKey) {
  const marketAccountInfo = await connection.getAccountInfo(marketId);
  if (!marketAccountInfo) {
    throw new Error('Failed to fetch market info for market id ' + marketId.toBase58());
  }

  return MARKET_STATE_LAYOUT_V3.decode(marketAccountInfo.data);
}


function parsePoolInfoFromLpTransaction(txData: ParsedTransactionWithMeta) {
  const initInstruction = findInstructionByProgramId(txData.transaction.message.instructions, new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID)) as PartiallyDecodedInstruction | null;
  if (!initInstruction) {
    throw new Error('Failed to find lp init instruction in lp init tx');
  }
  const baseMint = initInstruction.accounts[8];
  const baseVault = initInstruction.accounts[10];
  const quoteMint = initInstruction.accounts[9];
  const quoteVault = initInstruction.accounts[11];
  const lpMint = initInstruction.accounts[7];
  const baseAndQuoteSwapped = baseMint.toBase58() === SOL_MINT;
  const lpMintInitInstruction = findInitializeMintInInnerInstructionsByMintAddress(txData.meta?.innerInstructions ?? [], lpMint);
  if (!lpMintInitInstruction) {
    throw new Error('Failed to find lp mint init instruction in lp init tx');
  }
  const lpMintInstruction = findMintToInInnerInstructionsByMintAddress(txData.meta?.innerInstructions ?? [], lpMint);
  if (!lpMintInstruction) {
    throw new Error('Failed to find lp mint to instruction in lp init tx');
  }
  const baseTransferInstruction = findTransferInstructionInInnerInstructionsByDestination(txData.meta?.innerInstructions ?? [], baseVault, TOKEN_PROGRAM_ID);
  if (!baseTransferInstruction) {
    throw new Error('Failed to find base transfer instruction in lp init tx');
  }
  const quoteTransferInstruction = findTransferInstructionInInnerInstructionsByDestination(txData.meta?.innerInstructions ?? [], quoteVault, TOKEN_PROGRAM_ID);
  if (!quoteTransferInstruction) {
    throw new Error('Failed to find quote transfer instruction in lp init tx');
  }
  const lpDecimals = lpMintInitInstruction.parsed.info.decimals;
  const lpInitializationLogEntryInfo = extractLPInitializationLogEntryInfoFromLogEntry(findLogEntry('init_pc_amount', txData.meta?.logMessages ?? []) ?? '');
  const basePreBalance = (txData.meta?.preTokenBalances ?? []).find(balance => balance.mint === baseMint.toBase58());
  if (!basePreBalance) {
    throw new Error('Failed to find base tokens preTokenBalance entry to parse the base tokens decimals');
  }
  const baseDecimals = basePreBalance.uiTokenAmount.decimals;

  return {
    id: initInstruction.accounts[4],
    baseMint,
    quoteMint,
    lpMint,
    baseDecimals: baseAndQuoteSwapped ? SOL_DECIMALS : baseDecimals,
    quoteDecimals: baseAndQuoteSwapped ? baseDecimals : SOL_DECIMALS,
    lpDecimals,
    version: 4,
    programId: new PublicKey(RAYDIUM_POOL_V4_PROGRAM_ID),
    authority: initInstruction.accounts[5],
    openOrders: initInstruction.accounts[6],
    targetOrders: initInstruction.accounts[13],
    baseVault,
    quoteVault,
    withdrawQueue: new PublicKey("11111111111111111111111111111111"),
    lpVault: new PublicKey(lpMintInstruction.parsed.info.account),
    marketVersion: 3,
    marketProgramId: initInstruction.accounts[15],
    marketId: initInstruction.accounts[16],
    baseReserve: parseInt(baseTransferInstruction.parsed.info.amount),
    quoteReserve: parseInt(quoteTransferInstruction.parsed.info.amount),
    lpReserve: parseInt(lpMintInstruction.parsed.info.amount),
    openTime: lpInitializationLogEntryInfo.open_time,
  }
}

function findTransferInstructionInInnerInstructionsByDestination(innerInstructions: Array<ParsedInnerInstruction>, destinationAccount: PublicKey, programId?: PublicKey): ParsedInstruction | null {
  for (let i = 0; i < innerInstructions.length; i++) {
    for (let y = 0; y < innerInstructions[i].instructions.length; y++) {
      const instruction = innerInstructions[i].instructions[y] as ParsedInstruction;
      if (!instruction.parsed) { continue };
      if (instruction.parsed.type === 'transfer' && instruction.parsed.info.destination === destinationAccount.toBase58() && (!programId || instruction.programId.equals(programId))) {
        return instruction;
      }
    }
  }

  return null;
}

function findInitializeMintInInnerInstructionsByMintAddress(innerInstructions: Array<ParsedInnerInstruction>, mintAddress: PublicKey): ParsedInstruction | null {
  for (let i = 0; i < innerInstructions.length; i++) {
    for (let y = 0; y < innerInstructions[i].instructions.length; y++) {
      const instruction = innerInstructions[i].instructions[y] as ParsedInstruction;
      if (!instruction.parsed) { continue };
      if (instruction.parsed.type === 'initializeMint' && instruction.parsed.info.mint === mintAddress.toBase58()) {
        return instruction;
      }
    }
  }

  return null;
}

function findMintToInInnerInstructionsByMintAddress(innerInstructions: Array<ParsedInnerInstruction>, mintAddress: PublicKey): ParsedInstruction | null {
  for (let i = 0; i < innerInstructions.length; i++) {
    for (let y = 0; y < innerInstructions[i].instructions.length; y++) {
      const instruction = innerInstructions[i].instructions[y] as ParsedInstruction;
      if (!instruction.parsed) { continue };
      if (instruction.parsed.type === 'mintTo' && instruction.parsed.info.mint === mintAddress.toBase58()) {
        return instruction;
      }
    }
  }

  return null;
}

function findInstructionByProgramId(instructions: Array<ParsedInstruction | PartiallyDecodedInstruction>, programId: PublicKey): ParsedInstruction | PartiallyDecodedInstruction | null {
  for (let i = 0; i < instructions.length; i++) {
    if (instructions[i].programId.equals(programId)) {
      return instructions[i];
    }
  }

  return null;
}

function extractLPInitializationLogEntryInfoFromLogEntry(lpLogEntry: string): { nonce: number, open_time: number, init_pc_amount: number, init_coin_amount: number } {
  const lpInitializationLogEntryInfoStart = lpLogEntry.indexOf('{');

  return JSON.parse(fixRelaxedJsonInLpLogEntry(lpLogEntry.substring(lpInitializationLogEntryInfoStart)));
}

function fixRelaxedJsonInLpLogEntry(relaxedJson: string): string {
  return relaxedJson.replace(/([{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, "$1\"$2\":");
}