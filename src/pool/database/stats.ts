import { open, type RootDatabase, type Database as SubDatabase, type Key, type DatabaseOptions } from 'lmdb'
import { Decimal } from 'decimal.js'

type MinerStats = {
  lastActive: number
  totalShares: number
  totalBlocks: number
  hashrate: number
  workers: Set<string>
  lastBlock: number
  totalReward: bigint
  efficiency: number
  validShares: number
  invalidShares: number
  averageDifficulty: number
  bestDifficulty: number
  recentShares: { timestamp: number; difficulty: number }[]
}

type WorkerStats = {
  name: string
  hashrate: number
  shares: number
  lastActive: number
  difficulty: number
  efficiency: number
  validShares: number
  invalidShares: number
  recentShares: { timestamp: number; difficulty: number }[]
}

type HourlyStats = {
  timestamp: number
  shares: number
  totalShares: number
  avgDifficulty: number
  hashrate: number
  blocks: number
  reward: bigint
  efficiency: number
}

type PoolStats = {
  totalHashrate: number
  activeMiners: number
  totalWorkers: number
  blocksFound: number
  totalShares: number
  averageDifficulty: number
  efficiency: number
  lastUpdate: number
  poolHashRate: string
  connectedMiners: number
  sharesLastHour: number
  uptime: number
}

const WINDOW_SIZE = 10 * 60 * 1000 // 10 minutes
const MAX_RECENT_SHARES = 100

export default class Stats {
  private db: RootDatabase<any, Key>
  private minerStats: SubDatabase<MinerStats, string>
  private workerStats: SubDatabase<WorkerStats, [string, string]>
  private hourlyStats: SubDatabase<HourlyStats, [string, number]>
  private poolStats: SubDatabase<PoolStats, string>
  private startupTime: number = Date.now()

  constructor(path: string) {
    this.db = open({ path })
    
    this.minerStats = this.db.openDB<MinerStats, string>('miner_stats', {
      name: 'miner_stats',
      encoding: 'json',
      cache: true
    })

    this.workerStats = this.db.openDB<WorkerStats, [string, string]>('worker_stats', {
      name: 'worker_stats',
      keyEncoding: 'ordered-binary',
      encoding: 'json',
      cache: true
    })

    this.hourlyStats = this.db.openDB<HourlyStats, [string, number]>('hourly_stats', {
      name: 'hourly_stats',
      keyEncoding: 'ordered-binary',
      encoding: 'json',
      cache: true
    })

    this.poolStats = this.db.openDB<PoolStats, string>('pool_stats', {
      name: 'pool_stats',
      encoding: 'json',
      cache: true
    })

    // Initialize pool stats if not exists
    if (!this.poolStats.get('current')) {
      this.poolStats.putSync('current', {
        totalHashrate: 0,
        activeMiners: 0,
        totalWorkers: 0,
        blocksFound: 0,
        totalShares: 0,
        averageDifficulty: 0,
        efficiency: 0,
        lastUpdate: Date.now(),
        poolHashRate: '0',
        connectedMiners: 0,
        sharesLastHour: 0,
        uptime: 0
      })
    }

    // Setup cleanup interval
    setInterval(() => this.cleanup(), 60000)
  }

  private cleanup() {
    const now = Date.now()
    const oneDayAgo = now - 86400000

    // Cleanup old miner stats
    this.minerStats.getRange().forEach(({ key, value }) => {
      if (value.lastActive < oneDayAgo) {
        this.minerStats.removeSync(key)
      }
    })

    // Cleanup old worker stats
    this.workerStats.getRange().forEach(({ key, value }) => {
      if (value.lastActive < oneDayAgo) {
        this.workerStats.removeSync(key)
      }
    })

    // Cleanup old hourly stats
    this.hourlyStats.getRange().forEach(({ key, value }) => {
      if (value.timestamp < oneDayAgo) {
        this.hourlyStats.removeSync(key)
      }
    })
  }

  private calculateHashrate(recentShares: { timestamp: number; difficulty: number }[]): number {
    const now = Date.now()
    const relevantShares = recentShares.filter(share => now - share.timestamp <= WINDOW_SIZE)
    
    if (relevantShares.length === 0) return 0

    const avgDifficulty = relevantShares.reduce((acc, share) => acc + share.difficulty, 0) / relevantShares.length
    const timeDiff = (now - relevantShares[0].timestamp) / 1000
    return (avgDifficulty * relevantShares.length) / timeDiff
  }

  updateHashrate(address: string, worker: string, hashrate: number) {
    const stats = this.getMinerStats(address)
    const workerStats = this.getWorkerStats(address, worker)
    
    // Update miner stats
    stats.hashrate = hashrate
    stats.lastActive = Date.now()
    this.minerStats.putSync(address, stats)

    // Update worker stats
    workerStats.hashrate = hashrate
    workerStats.lastActive = Date.now()
    this.workerStats.putSync([address, worker], workerStats)

    // Update pool stats
    this.updatePoolStats()
  }

  recordShare(address: string, worker: string, difficulty: number, isValid: boolean = true) {
    const stats = this.getMinerStats(address)
    const workerStats = this.getWorkerStats(address, worker)
    const now = Date.now()
    
    // Update miner stats
    stats.totalShares++
    stats.lastActive = now
    if (isValid) {
      stats.validShares++
      stats.averageDifficulty = (stats.averageDifficulty * (stats.validShares - 1) + difficulty) / stats.validShares
      if (difficulty > stats.bestDifficulty) {
        stats.bestDifficulty = difficulty
      }
      stats.recentShares.push({ timestamp: now, difficulty })
      if (stats.recentShares.length > MAX_RECENT_SHARES) {
        stats.recentShares.shift()
      }
      stats.hashrate = this.calculateHashrate(stats.recentShares)
    } else {
      stats.invalidShares++
    }
    stats.workers.add(worker)
    stats.efficiency = (stats.validShares / stats.totalShares) * 100
    this.minerStats.putSync(address, stats)

    // Update worker stats
    workerStats.shares++
    workerStats.lastActive = now
    if (isValid) {
      workerStats.validShares++
      workerStats.difficulty = difficulty
      workerStats.recentShares.push({ timestamp: now, difficulty })
      if (workerStats.recentShares.length > MAX_RECENT_SHARES) {
        workerStats.recentShares.shift()
      }
      workerStats.hashrate = this.calculateHashrate(workerStats.recentShares)
    } else {
      workerStats.invalidShares++
    }
    workerStats.efficiency = (workerStats.validShares / workerStats.shares) * 100
    this.workerStats.putSync([address, worker], workerStats)

    // Update hourly stats
    const hour = Math.floor(now / 3600000) * 3600000
    const hourly = this.hourlyStats.get([address, hour]) || {
      timestamp: hour,
      shares: 0,
      totalShares: 0,
      avgDifficulty: 0,
      hashrate: 0,
      blocks: 0,
      reward: 0n,
      efficiency: 0
    }
    
    hourly.shares++
    if (isValid) {
      hourly.avgDifficulty = (hourly.avgDifficulty * (hourly.shares - 1) + difficulty) / hourly.shares
    }
    hourly.efficiency = (hourly.shares / hourly.totalShares) * 100
    this.hourlyStats.putSync([address, hour], hourly)

    // Update pool stats
    this.updatePoolStats()
  }

  recordBlock(address: string, reward: bigint) {
    const stats = this.getMinerStats(address)
    stats.totalBlocks++
    stats.lastBlock = Date.now()
    stats.totalReward += reward
    this.minerStats.putSync(address, stats)

    // Update hourly stats
    const hour = Math.floor(Date.now() / 3600000) * 3600000
    const hourly = this.hourlyStats.get([address, hour]) || {
      timestamp: hour,
      shares: 0,
      totalShares: 0,
      avgDifficulty: 0,
      hashrate: 0,
      blocks: 0,
      reward: 0n,
      efficiency: 0
    }
    
    hourly.blocks++
    hourly.reward += reward
    this.hourlyStats.putSync([address, hour], hourly)

    // Update pool stats
    this.updatePoolStats()
  }

  private updatePoolStats() {
    const now = Date.now()
    const activeThreshold = 300000 // 5 minutes
    const oneHourAgo = now - 3600000

    const miners = Array.from(this.minerStats.getRange())
    const activeMiners = miners.filter(({ value }) => now - value.lastActive < activeThreshold)
    
    const poolStats: PoolStats = {
      totalHashrate: activeMiners.reduce((sum, { value }) => sum + value.hashrate, 0),
      activeMiners: activeMiners.length,
      totalWorkers: activeMiners.reduce((sum, { value }) => sum + value.workers.size, 0),
      blocksFound: miners.reduce((sum, { value }) => sum + value.totalBlocks, 0),
      totalShares: miners.reduce((sum, { value }) => sum + value.totalShares, 0),
      averageDifficulty: miners.reduce((sum, { value }) => sum + value.averageDifficulty, 0) / miners.length || 0,
      efficiency: miners.reduce((sum, { value }) => sum + value.efficiency, 0) / miners.length || 0,
      lastUpdate: now,
      poolHashRate: new Decimal(activeMiners.reduce((sum, { value }) => sum + value.hashrate, 0)).toString(),
      connectedMiners: miners.length,
      sharesLastHour: miners.reduce((sum, { value }) => 
        sum + value.recentShares.filter(share => share.timestamp > oneHourAgo).length, 0),
      uptime: (now - this.startupTime) / 1000
    }

    this.poolStats.putSync('current', poolStats)
  }

  getMinerStats(address: string): MinerStats {
    return this.minerStats.get(address) || {
      lastActive: 0,
      totalShares: 0,
      totalBlocks: 0,
      hashrate: 0,
      workers: new Set<string>(),
      lastBlock: 0,
      totalReward: 0n,
      efficiency: 0,
      validShares: 0,
      invalidShares: 0,
      averageDifficulty: 0,
      bestDifficulty: 0,
      recentShares: []
    }
  }

  getWorkerStats(address: string, worker: string): WorkerStats {
    return this.workerStats.get([address, worker]) || {
      name: worker,
      hashrate: 0,
      shares: 0,
      lastActive: 0,
      difficulty: 0,
      efficiency: 0,
      validShares: 0,
      invalidShares: 0,
      recentShares: []
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

  getPoolStats(): PoolStats {
    return this.poolStats.get('current') || {
      totalHashrate: 0,
      activeMiners: 0,
      totalWorkers: 0,
      blocksFound: 0,
      totalShares: 0,
      averageDifficulty: 0,
      efficiency: 0,
      lastUpdate: Date.now(),
      poolHashRate: '0',
      connectedMiners: 0,
      sharesLastHour: 0,
      uptime: 0
    }
  }
}
