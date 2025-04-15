import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { Decimal } from 'decimal.js';
import type { Miner } from './index';
import { StratumError, type Event } from './protocol';
import type Templates from '../templates';
import { calculateTarget, Address } from '../../wasm/kaspa';

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
  poolHashRate: number;
  connectedMiners: number;
  activeMiners: number;
  blocks24h: number;
  totalBlocks: number;
  sharesLastHour: number;
  uptime: number;
  totalShares: number;
};

export default class Stratum extends EventEmitter {
  private templates: Templates;
  private contributions = new Map<bigint, Contribution>();
  private shareHistory: { timestamp: number; difficulty: Decimal; isBlock: boolean }[] = [];
  private blockHistory: { timestamp: number }[] = [];
  private startupTime = Date.now();
  private pplnsWindowSize = 100000;

  private blocksTotal = 0;
  private blocks24h = 0;

  subscriptors = new Set<Socket<Miner>>();
  miners = new Map<string, Set<Socket<Miner>>>();
  minerStats = new Map<string, MinerStats>();
  poolHashRate = new Decimal(0);
  totalShares = 0;

  constructor(templates: Templates) {
    super();
    this.templates = templates;
    this.templates.register((id, hash, timestamp) => this.announce(id, hash, timestamp));
    this.setupCleanupInterval();
  }

  getContributions(): Map<bigint, Contribution> {
    return this.contributions;
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
          if (miners.size === 0) this.miners.delete(address);
        }
        this.subscriptors.delete(socket);
      }
    });
  }

  private pruneContributions() {
    if (this.contributions.size > this.pplnsWindowSize) {
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
      const newWorkers = new Set<Socket<Miner>>();
      newWorkers.add(socket);
      this.miners.set(address, newWorkers);
    }

    socket.data.workers.add([address, name]);
    this.deriveNonce(socket);
    this.updateDifficulty(socket);
  }

  private deriveNonce(socket: Socket<Miner>) {
    const event: Event<'set_extranonce'> = {
      method: 'set_extranonce',  // Use 'set_extranonce' without 'mining.' prefix
      params: [randomBytes(4).toString('hex')],
    };
    socket.write(JSON.stringify(event) + '\n');
  }

  private updateDifficulty(socket: Socket<Miner>) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',  // Difficulty setting
      params: [socket.data.difficulty.toNumber()],
    };
    socket.write(JSON.stringify(event) + '\n');
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
      this.blockHistory.push({ timestamp });
      this.blocksTotal += 1;
      this.emit('block', block, { address, difficulty: socket.data.difficulty });
    }

    this.contributions.set(nonce, {
      address,
      difficulty: socket.data.difficulty,
      timestamp,
      workerName
    });

    this.shareHistory.push({ timestamp, difficulty: socket.data.difficulty, isBlock });

    this.totalShares += 1;
    this.poolHashRate = this.poolHashRate.add(socket.data.difficulty);
    this.updateMinerStats(address, socket.data.difficulty);
    this.pruneContributions();
  }

  getPoolStats(): PoolStats {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const twentyFourHoursAgo = now - 86400000;

    this.blocks24h = this.blockHistory.filter(
      b => b.timestamp > twentyFourHoursAgo
    ).length;

    const hashRateTH = this.poolHashRate
    .mul(4_294_967_296) // Kaspa network-specific multiplier
    .div((now - this.startupTime) / 1000 || 1) // Time in seconds
    .div(1e12); // Convert from H/s to TH/s

    return {
      poolHashRate: hashRateTH.toNumber(),
      connectedMiners: this.subscriptors.size,
      activeMiners: Array.from(this.minerStats.values())
        .filter(s => s.lastActive > now - 300_000).length,
      blocks24h: this.blocks24h,
      totalBlocks: this.blocksTotal,
      sharesLastHour: this.shareHistory
        .filter(share => share.timestamp > oneHourAgo).length,
      uptime: (now - this.startupTime) / 1000,
      totalShares: this.totalShares
    };
  }

  private setupCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      this.blockHistory = this.blockHistory.filter(
        b => b.timestamp > now - 172800000
      );
      this.minerStats.forEach((stats, address) => {
        if (stats.lastActive < now - 3600000) {
          this.minerStats.delete(address);
        }
      });
      this.shareHistory = this.shareHistory
        .filter(share => share.timestamp > now - 86400000);
    }, 60000);
  }
}
