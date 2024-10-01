import { TokenSafetyStatus } from "../PoolValidator/ValidationResult"

export type PoolStatus = {
  safety: TokenSafetyStatus | null,
  isEnabled: boolean,
  reason: string | null
}

export type BuyTxInfo = {
  amountInSOL: number,
  txId: string | null,
  error: string | null,
  newTokenAmount: number | null
}

export type SellTxInfo = {
  soldForAmountInSOL: number | null,
  txId: string | null,
  error: string | null
}

//'Status', 'ID', 'Safety', 'Start Time', 'Token', 'Buy', 'Sell', 'Profit'

export type StateRecord = {
  poolId: string,
  status: string,
  startTime: string | null,
  tokenId: string | null,
  safetyInfo: string | null,
  buyInfo: string | null,
  sellInfo: string | null,
  profit: string | null,
  maxProfit: number | null,
}

export type TradingWallet = { id: number, startValue: number, current: number, totalProfit: number }



export function createStateRecord(
  requiredFields: Pick<StateRecord, 'poolId' | 'status'>,
  optionalFields?: Partial<Omit<StateRecord, 'poolId' | 'status'>>
): StateRecord {
  const defaultStateRecord: Omit<StateRecord, 'poolId' | 'status'> = {
    startTime: null,
    tokenId: null,
    safetyInfo: null,
    buyInfo: null,
    sellInfo: null,
    profit: null,
    maxProfit: null
  };

  return { ...defaultStateRecord, ...requiredFields, ...optionalFields };
}