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
        '/blocks/total': () => ({ totalBlocks: this.database.getTotalBlocks() }),
        '/blocks/daily': () => ({ dailyBlocks: this.database.getDailyBlocks() })
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
      averageBlockReward: this.database.getAverageBlockReward()?.toString() || 'N/A',
      lastBlockReward: this.database.getLastBlockReward()?.toString() || 'N/A'
    };

    return {
      ...networkStats,
      totalMiners: this.stratum.miners.size,
      totalWorkers: this.stratum.subscriptors.size,
      pendingPayouts: this.database.getPendingPayoutsCount(),
      totalPaid: this.database.getTotalPaid()
    };
  }

  private getPoolStats() {
    return {
      totalMiners: this.stratum.miners.size,
      totalWorkers: this.stratum.subscriptors.size
    };
  }

  private getMiner(address: string) {
    const miner = this.database.getMiner(address);
    const connections = this.stratum.miners.get(address);

    const workers = connections
      ? Array.from(connections).flatMap((session) => {
          const { agent, difficulty, workers } = session.data;

          return Array.from(workers, ([, workerName]) => ({
            name: workerName,
            agent,
            difficulty: difficulty.toNumber(),
            shares: 0, // Not tracked anymore
            lastActive: 0, // Not tracked anymore
            hashrate: '0' // Not tracked anymore
          }));
        })
      : [];

    return {
      address,
      balance: miner.balance.toString(),
      connections: connections?.size ?? 0,
      totalWorkers: workers.length,
      totalShares: 0,
      hashrate: '0',
      lastActive: 0,
      workers,
    };
  }

  private getAllMiners() {
    const miners: Record<string, any> = {};

    for (const [address, connections] of this.stratum.miners) {
      const miner = this.database.getMiner(address);

      miners[address] = {
        balance: miner.balance.toString(),
        connections: connections?.size || 0,
        workers: Array.from(connections ?? []).reduce((acc, session) => acc + session.data.workers.size, 0),
        shares: 0,
        hashrate: '0',
        lastActive: 0,
        active: false
      };
    }

    return {
      totalMiners: this.stratum.miners.size,
      activeMiners: 0,
      miners
    };
  }
}
