import { open, type RootDatabase, type Database as SubDatabase, type Key, type DatabaseOptions } from 'lmdb'

type MinerStats = {
  lastActive: number
  totalShares: number
  totalBlocks: number
  hashrate: number
  workers: Set<string>
}

type HourlyStats = {
  timestamp: number
  shares: number
  avgDifficulty: number
}

export default class Stats {
  private db: RootDatabase<any, Key>
  private minerStats: SubDatabase<MinerStats, string>
  private hourlyStats: SubDatabase<HourlyStats, [string, number]>

  constructor(path: string) {
    this.db = open({ path })
    
    // Fixed database initialization with proper options
    this.minerStats = this.db.openDB<MinerStats, string>('miner_stats', {
      name: 'miner_stats',
      encoding: 'json',
      cache: true
    })

    this.hourlyStats = this.db.openDB<HourlyStats, [string, number]>('hourly_stats', {
      name: 'hourly_stats',
      keyEncoding: 'ordered-binary',
      encoding: 'json',
      cache: true
    })
  }

  // Rest of the class remains the same
  updateHashrate(address: string, hashrate: number) {
    const stats = this.getMinerStats(address)
    stats.hashrate = hashrate
    stats.lastActive = Date.now()
    this.minerStats.putSync(address, stats)
  }

  recordShare(address: string, worker: string, difficulty: number) {
    const stats = this.getMinerStats(address)
    stats.totalShares++
    stats.workers.add(worker)
    this.minerStats.putSync(address, stats)

    const hour = Math.floor(Date.now() / 3600000) * 3600000
    const hourly = this.hourlyStats.get([address, hour]) || {
      timestamp: hour,
      shares: 0,
      avgDifficulty: 0
    }
    
    hourly.shares++
    hourly.avgDifficulty = (hourly.avgDifficulty * (hourly.shares - 1) + difficulty) / hourly.shares
    this.hourlyStats.putSync([address, hour], hourly)
  }

  getMinerStats(address: string): MinerStats {
    return this.minerStats.get(address) || {
      lastActive: 0,
      totalShares: 0,
      totalBlocks: 0,
      hashrate: 0,
      workers: new Set<string>()
    }
  }

  getHourlyStats(address: string, hours: number): HourlyStats[] {
    const now = Date.now()
    return Array.from(
      this.hourlyStats.getRange({
        start: [address, now - (hours * 3600000)],
        end: [address, now]
      })
    ).map(({ value }) => value)
  }
}
