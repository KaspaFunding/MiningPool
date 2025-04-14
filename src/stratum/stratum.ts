import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { Decimal } from 'decimal.js';
import type { Miner } from './index.ts';
import { StratumError, type Event } from './protocol.ts';
import type Templates from '../templates/index.ts';
import { calculateTarget, Address } from '../../wasm/kaspa';

export type Contribution = { 
  address: string; 
  difficulty: Decimal; 
  timestamp: number; 
  workerName?: string; 
};

export type MinerStats = { 
  address: string; 
  workers: number; 
  hashrate: Decimal; 
  shares: number;
  lastActive: number; 
};

export type PoolStats = {
  poolHashRate: number;  // In TH/s as number
  connectedMiners: number;
  activeMiners: number;
  blocksFound: number;
  sharesLastHour: number;
  uptime: number;
  totalShares: number;
};

export default class Stratum extends EventEmitter {
  private readonly templates: Templates;
  private readonly contributions = new Map<bigint, Contribution>();
  private shareHistory: { timestamp: number; difficulty: Decimal }[] = [];
  private readonly startupTime = Date.now();
  private readonly pplnsWindowSize = 100000; // Configurable PPLNS window size
  
  subscriptors = new Set<Socket<Miner>>();
  miners = new Map<string, Set<Socket<Miner>>>();
  minerStats = new Map<string, MinerStats>();
  poolHashRate = new Decimal(0);
  blocksFound = 0;
  totalShares = 0;

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
      params: [id, `${hash}${timestampLE.toString('hex')}`],
    };

    const job = JSON.stringify(task);

    this.subscriptors.forEach((socket) => {
      // @ts-ignore: Bun socket state check
      if (socket.readyState === 1) {
        socket.write(`${job}\n`);
      } else {
        for (const [address] of socket.data.workers) {
          const miners = this.miners.get(address);
          if (miners) {
            miners.delete(socket);
            if (miners.size === 0) this.miners.delete(address);
          }
        }
        this.subscriptors.delete(socket);
      }
    });
  }

  private pruneContributions() {
    if (this.contributions.size <= this.pplnsWindowSize) return;

    const entries = Array.from(this.contributions.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.length - this.pplnsWindowSize;
    for (let i = 0; i < toRemove; i++) {
      this.contributions.delete(entries[i][0]);
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
    stats.hashrate = stats.hashrate.add(difficulty);
    
    this.minerStats.set(address, stats);
  }

  subscribe(socket: Socket<Miner>, agent: string) {
    if (this.subscriptors.has(socket)) {
      throw Error('Already subscribed');
    }

    socket.data.agent = agent;
    this.subscriptors.add(socket);
    this.emit('subscription', socket.remoteAddress, agent);
  }

  authorize(socket: Socket<Miner>, identity: string) {
    const [address, name] = identity.split('.');
    if (!Address.validate(address)) throw Error('Invalid address');

    const workers = this.miners.get(address) ?? new Set<Socket<Miner>>();
    workers.add(socket);
    this.miners.set(address, workers);

    socket.data.workers.add([address, name]);
    this.deriveNonce(socket);
    this.updateDifficulty(socket);
  }

  private deriveNonce(socket: Socket<Miner>) {
    const event: Event<'set_extranonce'> = {
      method: 'set_extranonce',
      params: [randomBytes(4).toString('hex')], // 4 bytes = 8 hex characters
    };
    socket.write(`${JSON.stringify(event)}\n`);
  }

  private updateDifficulty(socket: Socket<Miner>) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty.toNumber()],
    };
    socket.write(`${JSON.stringify(event)}\n`);
  }

  async submit(socket: Socket<Miner>, identity: string, id: string, work: string) {
    const [address, workerName] = identity.split('.');
    const hash = this.templates.getHash(id);
    
    if (!hash) throw new StratumError('job-not-found');
    const state = this.templates.getPoW(hash);
    if (!state) throw new StratumError('job-not-found');

    const nonce = BigInt(`0x${work}`);
    if (this.contributions.has(nonce)) throw new StratumError('duplicate-share');

    const [isBlock, target] = state.checkWork(nonce);
    if (target > calculateTarget(socket.data.difficulty.toNumber())) {
      throw new StratumError('low-difficulty-share');
    }

    const timestamp = Date.now();
    if (isBlock) {
      const block = await this.templates.submit(hash, nonce);
      this.blocksFound += 1;
      this.emit('block', block, { address, difficulty: socket.data.difficulty });
    }

    this.contributions.set(nonce, {
      address,
      difficulty: socket.data.difficulty,
      timestamp,
      workerName
    });

    this.shareHistory.push({ timestamp, difficulty: socket.data.difficulty });
    this.totalShares += 1;
    this.poolHashRate = this.poolHashRate.add(socket.data.difficulty);
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
    const oneHourAgo = now - 3_600_000;
    const uptimeSeconds = (now - this.startupTime) / 1000;
    
    // Hash rate calculation: (difficulty * 2^32) / TH / seconds
    const hashRateTH = uptimeSeconds > 0 
      ? this.poolHashRate
          .mul(4_294_967_296)  // 2^32
          .div(1e12)
          .div(uptimeSeconds)
      : new Decimal(0);

    return {
      poolHashRate: hashRateTH.toNumber(),
      connectedMiners: this.subscriptors.size,
      activeMiners: Array.from(this.minerStats.values())
        .filter(s => s.lastActive > now - 300_000).length,
      blocksFound: this.blocksFound,
      sharesLastHour: this.shareHistory
        .filter(share => share.timestamp > oneHourAgo).length,
      uptime: uptimeSeconds,
      totalShares: this.totalShares
    };
  }

  private setupCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      
      // Clean up inactive miners (1 hour threshold)
      this.minerStats.forEach((stats, address) => {
        if (stats.lastActive < now - 3_600_000) {
          this.minerStats.delete(address);
        }
      });
      
      // Keep 24 hours of share history
      this.shareHistory = this.shareHistory
        .filter(share => share.timestamp > now - 86_400_000);
    }, 60_000); // Run every minute
  }
}
