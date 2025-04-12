import { open, type RootDatabase, type Database as SubDatabase, type Key } from 'lmdb'

type Miner = {
  balance: bigint
}

type Block = {
  timestamp: number
}

const defaultMiner: Miner = {
  balance: 0n
}

export default class Database {
  db: RootDatabase<any, Key>
  miners: SubDatabase<Miner, string>
  blocks: SubDatabase<Block, string>

  constructor (path: string) {
    this.db = open({
      path: path
    })
    this.miners = this.db.openDB('miners', {})
    this.blocks = this.db.openDB('blocks', {})
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

  // Block tracking methods
  addBlock(blockHash: string, timestamp: number) {
    this.blocks.putSync(blockHash, { timestamp })
  }

  getTotalBlocks(): number {
    return Array.from(this.blocks.getKeys()).length
  }

  getDailyBlocks(): number {
    const now = Date.now()
    return Array.from(this.blocks.getKeys()).filter(blockHash => {
      const block = this.blocks.get(blockHash)
      return block && block.timestamp > now - 86400000
    }).length
  }
}
