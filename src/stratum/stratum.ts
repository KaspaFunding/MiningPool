import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { type Miner } from './index.ts';
import { StratumError, type Event } from './protocol.ts';
import type Templates from '../templates/index.ts';
import { calculateTarget, Address } from '../../wasm/kaspa';
import { Decimal } from 'decimal.js';

export type Contribution = { 
  address: string, 
  difficulty: Decimal, 
  timestamp: number, 
  workerName?: string 
};

export type MinerStats = { 
  address: string, 
  workers: number, 
  hashrate: Decimal, 
  shares: number,
  lastActive: number 
};

export type PoolStats = {
  poolHashRate: string,
  connectedMiners: number,
  activeMiners: number,
  blocksFound: number,
  sharesLastHour: number,
  uptime: number
  totalShares: number 
};

export default class Stratum extends EventEmitter {
  private templates: Templates;
  private contributions: Map<bigint, Contribution> = new Map();
  private shareHistory: {timestamp: number, difficulty: Decimal}[] = [];
  private startupTime: number = Date.now();
  private pplnsWindowSize: number = 100000; // Configurable PPLNS window size
  
  subscriptors: Set<Socket<Miner>> = new Set();
  miners: Map<string, Set<Socket<Miner>>> = new Map();
  minerStats: Map<string, MinerStats> = new Map();
  poolHashRate: Decimal = new Decimal(0);
  blocksFound: number = 0;
  totalShares: number = 0;

  constructor(templates: Templates) {
    super();
    this.templates = templates;
    this.templates.register((id, hash, timestamp) => this.announce(id, hash, timestamp));
    this.setupCleanupInterval();
  }

  private announce(id: string, hash: string, timestamp: bigint) {
    const timestampLE = Buffer.alloc(8);
    timestampLE.writeBigUInt64LE(timestamp);

    const task: Event<'mining.notify'> = {
      method: 'mining.notify',
      params: [id, hash + timestampLE.toString('hex')],
    };

    const job = JSON.stringify(task);

    this.subscriptors.forEach((socket) => {
      // @ts-ignore
      if (socket.readyState === 1) {
        socket.write(job + '\n');
      } else {
        for (const [address] of socket.data.workers) {
          const miners = this.miners.get(address)!;
          miners.delete(socket);

          if (miners.size === 0) {
            this.miners.delete(address);
          }
        }

        this.subscriptors.delete(socket);
      }
    });
  }

  private pruneContributions() {
    if (this.contributions.size > this.pplnsWindowSize) {
      // Remove oldest entries
      const entries = Array.from(this.contributions.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      const toRemove = entries.length - this.pplnsWindowSize;
      for (let i = 0; i < toRemove; i++) {
        this.contributions.delete(entries[i][0]);
      }
    }
  }

  private updateMinerStats(address: string, difficulty: Decimal) {
    const stats = this.minerStats.get(address) || {
      address,
      workers: 0,
      hashrate: new Decimal(0),
      shares: 0,
      lastActive: Date.now()
    };

    stats.shares += 1;
    stats.lastActive = Date.now();
    stats.workers = this.miners.get(address)?.size || 0;
    stats.hashrate = stats.hashrate.plus(difficulty);
    
    this.minerStats.set(address, stats);
  }

  subscribe(socket: Socket<Miner>, agent: string) {
    if (this.subscriptors.has(socket)) throw Error('Already subscribed');

    socket.data.agent = agent;
    this.subscriptors.add(socket);

    this.emit('subscription', socket.remoteAddress, agent);
  }

  authorize(socket: Socket<Miner>, identity: string) {
    const [address, name] = identity.split('.');
    if (!Address.validate(address)) throw Error('Invalid address');

    const workers = this.miners.get(address);

    if (workers) {
      if (!workers.has(socket)) workers.add(socket);
    } else {
      const workers = this.miners.set(address, new Set<Socket<Miner>>()).get(address)!;
      workers.add(socket);
    }

    socket.data.workers.add([address, name]);
    this.deriveNonce(socket);
    this.updateDifficulty(socket);
  }

  private deriveNonce(socket: Socket<Miner>) {
    const event: Event<'set_extranonce'> = {
      method: 'set_extranonce',
      params: [randomBytes(4).toString('hex')],
    };

    socket.write(JSON.stringify(event) + '\n');
  }

  private updateDifficulty(socket: Socket<Miner>) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty.toNumber()],
    };

    socket.write(JSON.stringify(event) + '\n');
  }

  async submit(socket: Socket<Miner>, identity: string, id: string, work: string) {
    const [address, workerName] = identity.split('.');
    const hash = this.templates.getHash(id)!;
    const state = this.templates.getPoW(hash);
    if (!state) throw new StratumError('job-not-found');

    const nonce = BigInt('0x' + work);
    if (this.contributions.has(nonce)) throw new StratumError('duplicate-share');

    const [isBlock, target] = state.checkWork(nonce);
    if (target > calculateTarget(socket.data.difficulty.toNumber())) throw new StratumError('low-difficulty-share');

    const timestamp = Date.now();
    if (isBlock) {
      const block = await this.templates.submit(hash, nonce);
      this.blocksFound += 1;
      this.emit('block', block, { address, difficulty: socket.data.difficulty });
    }

    // Record the share
    this.contributions.set(nonce, {
      address,
      difficulty: socket.data.difficulty,
      timestamp,
      workerName
    });
    this.shareHistory.push({ timestamp, difficulty: socket.data.difficulty });
    this.totalShares += 1;
    this.poolHashRate = this.poolHashRate.plus(socket.data.difficulty);
    this.updateMinerStats(address, socket.data.difficulty);
    this.pruneContributions();
  }

  dump() {
    const contributions = Array.from(this.contributions.values());
    this.contributions.clear();
    return contributions;
  }

  getPoolStats(): PoolStats {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    
    const sharesLastHour = this.shareHistory
      .filter(share => share.timestamp > oneHourAgo)
      .reduce((sum, share) => sum.plus(share.difficulty), new Decimal(0));
    
    return {
      poolHashRate: this.poolHashRate.toString(),
      connectedMiners: this.miners.size,
      activeMiners: Array.from(this.minerStats.values())
        .filter(s => s.lastActive > now - 300000).length, // 5 min threshold
      blocksFound: this.blocksFound,
      sharesLastHour: sharesLastHour.toNumber(),
      totalShares: this.totalShares,
      uptime: (now - this.startupTime) / 1000
    };
  }

  private setupCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      
      // Clean up inactive miners
      this.minerStats.forEach((stats, address) => {
        if (stats.lastActive < now - 3600000) { // 1 hour inactive
          this.minerStats.delete(address);
        }
      });
      
      // Clean up share history
      this.shareHistory = this.shareHistory
        .filter(share => share.timestamp > now - 86400000); // Keep 24 hours
    }, 60000); // Run every minute
  }
}
