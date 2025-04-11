import Server from './server';
import type Stratum from '../../stratum';
import type Treasury from '../../treasury';
import type Database from '../database';

type Worker = {
  name: string;
  agent: string;
  difficulty: number;
  shares: number;
  lastActive: number;
  hashrate: string;
};

export default class Api extends Server {
  private treasury: Treasury;
  private stratum: Stratum;
  private database: Database;

  constructor(port: number, treasury: Treasury, stratum: Stratum, database: Database) {
    super(
      {
        '/status': () => this.status(),
        '/miner': ({ address }) => this.getMiner(address),
        '/pool': () => this.getPoolStats(),
        '/miners': () => this.getAllMiners(),
      },
      port
    );

    this.treasury = treasury;
    this.stratum = stratum;
    this.database = database;
  }

  private status() {
    // Network stats from treasury
    const networkStats = {
      networkId: this.treasury.processor.networkId!,
      networkHashRate: this.treasury.processor.networkHashRate?.toString() || 'N/A',
      averageBlockTime: this.treasury.processor.averageBlockTime?.toString() || 'N/A',
      blocksFound: this.treasury.processor.blocksFound?.toString() || 'N/A',
      difficulty: this.treasury.processor.difficulty?.toString() || 'N/A',
    };

    // Pool stats from stratum
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

          return Array.from(workers, ([, workerName]) => ({
            name: workerName,
            agent,
            difficulty: difficulty.toNumber(),
            shares: stats?.shares || 0,
            lastActive: stats?.lastActive || 0,
            hashrate: stats?.hashrate.toString() || '0',
          }));
        })
      : [];

    return {
      address,
      balance: miner.balance.toString(),
      connections: connections?.size ?? 0,
      totalWorkers: workers.length,
      totalShares: stats?.shares || 0,
      hashrate: stats?.hashrate.toString() || '0',
      lastActive: stats?.lastActive || 0,
      workers,
    };
  }

  private getAllMiners() {
    const miners: Record<string, any> = {};
    
    this.stratum.minerStats.forEach((stats, address) => {
      const connections = this.stratum.miners.get(address);
      const miner = this.database.getMiner(address);

      miners[address] = {
        balance: miner.balance.toString(),
        connections: connections?.size || 0,
        workers: stats.workers,
        shares: stats.shares,
        hashrate: stats.hashrate.toString(),
        lastActive: stats.lastActive,
        active: stats.lastActive > Date.now() - 300000, // 5 min threshold
      };
    });

    return {
      totalMiners: this.stratum.miners.size,
      activeMiners: Array.from(this.stratum.minerStats.values())
        .filter(s => s.lastActive > Date.now() - 300000).length,
      miners
    };
  }
}
