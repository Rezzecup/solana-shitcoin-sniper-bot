import { config } from './Config'
import { Connection } from '@solana/web3.js'
import { TurboBot } from './TurboBot'

const connection = new Connection(config.rpcHttpURL, {
  wsEndpoint: config.rpcWsURL
})

let backupConnection: Connection | null = null
if (config.backupRpcUrl && config.backupWsRpcUrl) {
  backupConnection = new Connection(config.backupRpcUrl, {
    wsEndpoint: config.backupWsRpcUrl
  })
}

const bot = new TurboBot(connection, backupConnection)

async function main() {
  console.log('Run Turbo Bot')

  await bot.start(false)
  // await bot.buySellQuickTest('BZivKpJWgQvrA3yYe3ubomufeGVouoYoUhosmBEdqF9y')
  console.log('Trading complete')
}

main().catch(console.error)