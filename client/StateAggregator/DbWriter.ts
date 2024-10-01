import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { StateRecord, TradingWallet } from './StateTypes';

let db: Database<sqlite3.Database, sqlite3.Statement>
export let dbIsInited = false

export async function initializeDb() {
  db = await open({
    filename: './mydb.sqlite',
    driver: sqlite3.Database,
  });

  // Create the table if it doesn't exist
  await db.exec(`CREATE TABLE IF NOT EXISTS state_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poolId TEXT NOT NULL UNIQUE,  /* Ensure there's a UNIQUE constraint for UPSERT to work */
    status TEXT NOT NULL,
    startTime TEXT,
    tokenId TEXT,
    safetyInfo TEXT,
    buyInfo TEXT,
    sellInfo TEXT,
    profit TEXT,
    maxProfit REAL,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS TradingWallet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    startValue REAL NOT NULL,
    current REAL NOT NULL,
    totalProfit REAL NOT NULL
  )`);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_poolId ON state_records (poolId)`);

  dbIsInited = true
}

export async function createNewTradingWallet(startValue: number = 1, current: number = 1, totalProfit: number = 0): Promise<TradingWallet | undefined> {
  await db.run(`INSERT INTO TradingWallet (startValue, current, totalProfit) VALUES (?, ?, ?)`, [startValue, current, totalProfit]);
  const { id } = await db.get(`SELECT last_insert_rowid() as id`);
  return await db.get<TradingWallet>(`SELECT * FROM TradingWallet WHERE id = ?`, [id]);
}

export async function updateTradingWalletRecord(record: TradingWallet) {
  await db.run(`UPDATE TradingWallet SET startValue = ?, current = ?, totalProfit = ? WHERE id = ?`, [record.startValue, record.current, record.totalProfit, record.id]);
}

export async function getStateRecordByPoolId(poolId: string): Promise<StateRecord | undefined> {
  return await db.get<StateRecord>(`SELECT * FROM state_records WHERE poolId = ?`, [poolId]);
}

export async function upsertRecord(record: StateRecord) {
  try {
    await db.run(`INSERT INTO state_records (poolId, status, startTime, tokenId, safetyInfo, buyInfo, sellInfo, profit, maxProfit, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(poolId) 
    DO UPDATE SET
      status = excluded.status,
      startTime = excluded.startTime,
      tokenId = excluded.tokenId,
      safetyInfo = excluded.safetyInfo,
      buyInfo = excluded.buyInfo,
      sellInfo = excluded.sellInfo,
      profit = excluded.profit,
      maxProfit = excluded.maxProfit,
      updatedAt = CURRENT_TIMESTAMP`,
      record.poolId, record.status, record.startTime, record.tokenId, record.safetyInfo, record.buyInfo, record.sellInfo, record.profit, record.maxProfit);
  } catch (e) {
    console.error(`Failed to write into DB. ${e}`)
  }
}