import { open, type RootDatabase, type Database as SubDatabase, type Key } from 'lmdb'

type Miner = {
  balance: bigint
}

const defaultMiner: Miner = {
  balance: 0n
}

export default class Database {
  db: RootDatabase<any, Key>
  miners: SubDatabase<Miner, string>

  constructor (path: string) {
    this.db = open({
      path: path
    })
    this.miners = this.db.openDB('miners', {})
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
}
