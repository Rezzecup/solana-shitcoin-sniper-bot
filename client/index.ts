import express, { Request, Response } from 'express'
import { config } from './Config'
import { Connection } from '@solana/web3.js'
import { TradingBot } from './Bot'

const connection = new Connection(config.rpcHttpURL, {
  wsEndpoint: config.rpcWsURL
})


const app = express()

// Internal state
const bot = new TradingBot(connection)

// Single endpoint that increments and displays the visit count
app.get('/start', (req: Request, res: Response) => {
  if (bot.isStarted()) {
    res.send('Is already started')
  } else {
    bot.start()
    res.send(`Bot is started to handle new pools`);
  }
})

app.get('/stop', (req: Request, res: Response) => {
  if (bot.isStarted()) {
    bot.stop()
    res.send('Bot is stopped')
  } else {
    res.send(`Bot is already stopped`);
  }
})

app.get('/wallet', (req: Request, res: Response) => {
  if (bot.isStarted()) {
    res.send(`Bot is started. Current wallet:\n${JSON.stringify(bot.getWalletTradingInfo())}`)
  } else {
    res.send(`Bot is not started. Current wallet:\n${JSON.stringify(bot.getWalletTradingInfo())}`)
  }
})

// app.get('/skipped', (req: Request, res: Response) => {
//   res.send(JSON.stringify(bot.getSkippedPools()))
// })

// app.get('/trades', (req: Request, res: Response) => {
//   res.send(JSON.stringify(bot.getTradingResults()))
// })

// app.get('/running_validations', (req: Request, res: Response) => {
//   const mapToObject = Object.fromEntries(bot.getRunningValidationInfo())
//   res.json(mapToObject)
// })

// app.get('/completed_validations', (req: Request, res: Response) => {
//   const mapToObject = Object.fromEntries(bot.getCompletedValidations())
//   res.json(mapToObject)
// })

// app.get('/validation_errors', (req: Request, res: Response) => {
//   res.json(bot.getValidationErrors())
// })

// Start the server
app.listen(config.appPort, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${config.appPort}`);
})