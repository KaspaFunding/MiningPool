import Server from './server';
import type Stratum from '../../stratum';
import type Treasury from '../../treasury';
import type Database from '../database';
import { stringifyHashrate } from '../../stratum/stratum';

type Worker = {
  name: string;
  agent: string;
  difficulty: number;
  shares: number;
  lastActive: number;
  hashrate: string;
  type: string;
  recentShares: number;
  lastShare: number;
};

export default class Api extends Server {
  private treasury: Treasury;
  private stratum: Stratum;
  private database: Database;

  constructor(port: number, treasury: Treasury, stratum: Stratum, database: Database) {
    super(
      {
        '/status': () => Promise.resolve(this.status()),
        '/miner': ({ address }) => Promise.resolve(this.getMiner(address)),
        '/pool': () => Promise.resolve(this.getPoolStats()),
        '/miners': () => Promise.resolve(this.getAllMiners()),
        '/blocks': () => Promise.resolve(this.getRecentBlocks()),
        '/payouts': () => Promise.resolve(this.getRecentPayouts()),
        '/contributions': () => Promise.resolve(this.getContributions()),
        '/hashrate-history': () => Promise.resolve(this.getHashrateHistory()),
        '/version': () => Promise.resolve(this.getVersion()),
        '/worker': ({ address, worker }) => Promise.resolve(this.getWorker(address, worker)),
      },
      port
    );

    this.treasury = treasury;
    this.stratum = stratum;
    this.database = database;
  }

  private status() {
    const networkStats = {
      networkId: this.treasury.processor.networkId!,
      networkHashRate: this.treasury.processor.networkHashRate?.toString() || 'N/A',
      averageBlockTime: this.treasury.processor.averageBlockTime?.toString() || 'N/A',
      blocksFound: this.treasury.processor.blocksFound?.toString() || 'N/A',
      difficulty: this.treasury.processor.difficulty?.toString() || 'N/A',
    };

    const poolStats = this.stratum.getPoolStats();

    return {
      ...networkStats,
      ...poolStats,
      totalMiners: this.stratum.miners.size,
      totalWorkers: this.stratum.subscriptors.size,
    };
  }

  private getPoolStats() {
    const poolStats = this.stratum.getPoolStats();
    return {
      ...poolStats,
      totalMiners: this.stratum.miners.size,
      totalWorkers: this.stratum.subscriptors.size,
      totalShares: this.stratum.totalShares,
    };
  }

  private getMiner(address: string) {
    const miner = this.database.getMiner(address);
    const connections = this.stratum.miners.get(address);
    const stats = this.stratum.minerStats.get(address);

    const workers = connections
      ? Array.from(connections).flatMap((session) => {
          const { agent, difficulty, workers } = session.data;
          let type = 'Unknown';
          if (agent.includes('GodMiner')) type = 'Bitmain';
          else if (agent.includes('IceRiverMiner')) type = 'IceRiver';
          else if (agent.includes('BzMiner')) type = 'GoldShell';

          return Array.from(workers, ([, workerName]) => {
            const workerStats = stats?.workerStats.get(workerName);
            return {
              name: workerName,
              agent,
              difficulty: difficulty.toNumber(),
              shares: workerStats?.shares || 0,
              lastActive: workerStats?.lastShare || 0,
              hashrate: stringifyHashrate(workerStats?.hashrate || 0),
              type,
              recentShares: workerStats?.recentShares.length || 0,
              lastShare: workerStats?.lastShare || 0
            };
          });
        })
      : [];

    return {
      address,
      balance: miner.balance.toString(),
      connections: connections?.size ?? 0,
      totalWorkers: workers.length,
      totalShares: stats?.shares || 0,
      hashrate: stringifyHashrate(Number(stats?.hashrate || 0)),
      lastActive: stats?.lastActive || 0,
      workers,
    };
  }

  private getWorker(address: string, workerName: string) {
    const stats = this.stratum.minerStats.get(address);
    const workerStats = stats?.workerStats.get(workerName);
    
    if (!workerStats) {
      return { error: 'Worker not found' };
    }

    return {
      name: workerName,
      address,
      shares: workerStats.shares,
      hashrate: stringifyHashrate(workerStats.hashrate),
      lastShare: workerStats.lastShare,
      difficulty: workerStats.difficulty,
      recentShares: workerStats.recentShares.length,
      active: Date.now() - workerStats.lastShare < 300000 // 5 minutes
    };
  }

  private getAllMiners() {
    const miners: Record<string, any> = {};

    this.stratum.minerStats.forEach((stats, address) => {
      const connections = this.stratum.miners.get(address);
      const miner = this.database.getMiner(address);
      const workerTypes = new Set<string>();
      const workerStats = new Map<string, any>();

      connections?.forEach(session => {
        const { agent } = session.data;
        if (agent.includes('GodMiner')) workerTypes.add('Bitmain');
        else if (agent.includes('IceRiverMiner')) workerTypes.add('IceRiver');
        else if (agent.includes('BzMiner')) workerTypes.add('GoldShell');
        else workerTypes.add('Unknown');

        // Add worker stats
        session.data.workers.forEach(([, workerName]) => {
          const workerStat = stats.workerStats.get(workerName);
          if (workerStat) {
            workerStats.set(workerName, {
              shares: workerStat.shares,
              hashrate: stringifyHashrate(workerStat.hashrate),
              lastShare: workerStat.lastShare,
              difficulty: workerStat.difficulty,
              recentShares: workerStat.recentShares.length
            });
          }
        });
      });

      miners[address] = {
        balance: miner.balance.toString(),
        connections: connections?.size || 0,
        workers: stats.workers,
        shares: stats.shares,
        hashrate: stringifyHashrate(Number(stats.hashrate)),
        lastActive: stats.lastActive,
        active: stats.lastActive > Date.now() - 300000,
        types: Array.from(workerTypes),
        workerStats: Object.fromEntries(workerStats)
      };
    });

    return {
      totalMiners: this.stratum.miners.size,
      activeMiners: Array.from(this.stratum.minerStats.values())
        .filter((s) => s.lastActive > Date.now() - 300000).length,
      miners,
    };
  }

  private getRecentBlocks() {
    return this.treasury.getRecentBlocks().map((block) => ({
      height: block.height,
      timestamp: block.timestamp,
      reward: block.reward.toString(),
      miner: block.miner,
    }));
  }

  private getRecentPayouts() {
    return this.database.getRecentPayouts().map((payout) => ({
      address: payout.address,
      amount: payout.amount.toString(),
      txid: payout.txid,
      timestamp: payout.timestamp,
    }));
  }

  private getContributions() {
    return this.stratum.dump();
  }

  private getHashrateHistory() {
    return this.database.getHashrateHistory();
  }

  private getVersion() {
    return {
      version: '1.0.0',
      commit: process.env.GIT_COMMIT || 'dev',
      buildTime: process.env.BUILD_TIME || new Date().toISOString(),
    };
  }
}
