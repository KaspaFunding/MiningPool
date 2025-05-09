import { open, type RootDatabase, type Database as SubDatabase, type Key } from 'lmdb'

type Miner = {
  balance: bigint
}

type Payout = {
  address: string
  amount: bigint
  txid: string
  timestamp: number
}

type HashratePoint = {
  timestamp: number
  hashrate: number
}

const defaultMiner: Miner = {
  balance: 0n
}

export default class Database {
  db: RootDatabase<any, Key>
  miners: SubDatabase<Miner, string>
  payouts: SubDatabase<Payout[], string>
  hashrateHistory: SubDatabase<HashratePoint[], string>

  constructor (path: string) {
    this.db = open({
      path: path
    })
    this.miners = this.db.openDB('miners', {})
    this.payouts = this.db.openDB('payouts', {})
    this.hashrateHistory = this.db.openDB('hashrate', {})
  }

  getMiner (address: string) {
    return this.miners.get(address) ?? { ...defaultMiner }
  }

  addBalance (address: string, balance: bigint) {
    return this.miners.transactionSync(() => {
      const miner = this.getMiner(address)
      miner.balance += balance

      this.miners.putSync(address, miner)
    })
  }

  getRecentPayouts() {
    return this.payouts.get('recent') ?? []
  }

  getHashrateHistory() {
    return this.hashrateHistory.get('history') ?? []
  }

  recordPayout(payout: Payout) {
    return this.payouts.transactionSync(() => {
      const recent = this.getRecentPayouts()
      recent.unshift(payout)
      if (recent.length > 100) recent.pop()
      this.payouts.putSync('recent', recent)
    })
  }

  recordHashrate(hashrate: number) {
    return this.hashrateHistory.transactionSync(() => {
      const history = this.getHashrateHistory()
      history.push({
        timestamp: Date.now(),
        hashrate
      })
      if (history.length > 100) history.shift()
      this.hashrateHistory.putSync('history', history)
    })
  }
}
