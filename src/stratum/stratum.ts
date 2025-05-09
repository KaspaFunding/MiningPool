import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { type Miner } from './index.ts';
import { StratumError, type Event } from './protocol.ts';
import type Templates from '../templates/index.ts';
import { calculateTarget, Address } from '../../wasm/kaspa';
import { Decimal } from 'decimal.js';
import { Encoding, encodeJob } from '../templates/jobs/encoding';
import Stats from '../pool/database/stats';

const bitMainRegex = new RegExp(".*(GodMiner).*", "i")
const iceRiverRegex = new RegExp(".*(IceRiverMiner).*", "i")
const goldShellRegex = new RegExp(".*(BzMiner).*", "i")

const bigGig = Math.pow(10, 9);
const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
const minHash = (BigInt(1) << BigInt(256)) / maxTarget;

export function stringifyHashrate(ghs: number): string {
  const unitStrings = ["M", "G", "T", "P", "E", "Z", "Y"];
  let unit = unitStrings[0];
  let hr = ghs * 1000; // Default to MH/s

  for (const u of unitStrings) {
    if (hr < 1000) {
      unit = u;
      break;
    }
    hr /= 1000;
  }

  return `${hr.toFixed(2)}${unit}H/s`;
}

export function diffToHash(diff: number): number {
  const hashVal = Number(minHash) * diff;
  return hashVal / bigGig;
}

export type WorkerStats = {
  shares: number;
  hashrate: number;
  lastShare: number;
  difficulty: number;
  recentShares: { timestamp: number; difficulty: number }[];
};

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
  lastActive: number,
  workerStats: Map<string, WorkerStats>
};

export type PoolStats = {
  poolHashRate: string,
  connectedMiners: number,
  activeMiners: number,
  blocksFound: number,
  sharesLastHour: number,
  uptime: number,
  totalShares: number 
};

export default class Stratum extends EventEmitter {
  private templates: Templates;
  private contributions: Map<bigint, Contribution> = new Map();
  private shareHistory: { timestamp: number, difficulty: Decimal }[] = [];
  private startupTime: number = Date.now();
  private pplnsWindowSize: number = 100000;
  private stats: Stats;

  subscriptors: Set<Socket<Miner>> = new Set();
  miners: Map<string, Set<Socket<Miner>>> = new Map();
  minerStats: Map<string, MinerStats> = new Map();
  poolHashRate: Decimal = new Decimal(0);
  blocksFound: number = 0;
  totalShares: number = 0;

  constructor(templates: Templates, stats: Stats) {
    super();
    this.templates = templates;
    this.stats = stats;
    this.templates.register((id, hash, timestamp) => this.announce(id, hash, timestamp));
    this.setupCleanupInterval();
  }

  private announce(id: string, hash: string, timestamp: bigint) {
    const timestampLE = Buffer.alloc(8);
    timestampLE.writeBigUInt64LE(timestamp);

    this.subscriptors.forEach((socket) => {
      if (socket.readyState === 'open') {
        const encoding = socket.data.encoding || Encoding.BigHeader;
        const header = this.templates.getHeader(hash);
        if (!header) return;
        
        const jobData = encodeJob(hash, timestamp, encoding, header);

        const task: Event<'mining.notify'> = {
          method: 'mining.notify',
          params: [id, jobData, timestamp],
        };

        socket.write(JSON.stringify(task) + '\n');
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

  private updateMinerStats(address: string, difficulty: Decimal, workerName?: string) {
    const stats = this.minerStats.get(address) || {
      address,
      workers: 0,
      hashrate: new Decimal(0),
      shares: 0,
      lastActive: Date.now(),
      workerStats: new Map<string, WorkerStats>()
    };

    stats.shares += 1;
    stats.lastActive = Date.now();
    stats.workers = this.miners.get(address)?.size || 0;
    stats.hashrate = stats.hashrate.plus(difficulty);

    if (workerName) {
      const workerStats = stats.workerStats.get(workerName) || {
        shares: 0,
        hashrate: 0,
        lastShare: Date.now(),
        difficulty: 0,
        recentShares: []
      };

      workerStats.shares++;
      workerStats.lastShare = Date.now();
      workerStats.difficulty = difficulty.toNumber();
      workerStats.recentShares.push({
        timestamp: Date.now(),
        difficulty: difficulty.toNumber()
      });

      // Keep only last 100 shares for hashrate calculation
      if (workerStats.recentShares.length > 100) {
        workerStats.recentShares.shift();
      }

      // Calculate worker hashrate
      const windowSize = 10 * 60 * 1000; // 10 minutes
      const relevantShares = workerStats.recentShares.filter(
        share => Date.now() - share.timestamp <= windowSize
      );

      if (relevantShares.length > 0) {
        const avgDifficulty = relevantShares.reduce(
          (acc, share) => acc + diffToHash(share.difficulty), 
          0
        ) / relevantShares.length;
        const timeDiff = (Date.now() - relevantShares[0].timestamp) / 1000;
        workerStats.hashrate = (avgDifficulty * relevantShares.length) / timeDiff;
      }

      stats.workerStats.set(workerName, workerStats);
    }

    this.minerStats.set(address, stats);
  }

  subscribe(socket: Socket<Miner>, agent: string) {
    if (this.subscriptors.has(socket)) throw Error('Already subscribed');

    socket.data.agent = agent;
    this.subscriptors.add(socket);

    // Detect miner type
    if (bitMainRegex.test(agent)) {
      socket.data.encoding = Encoding.Bitmain;
    } else {
      socket.data.encoding = Encoding.BigHeader;
    }

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
      // Block reward is handled by the treasury class through the coinbase event
      this.emit('block', block, { address, difficulty: socket.data.difficulty });
    }

    this.contributions.set(nonce, {
      address,
      difficulty: socket.data.difficulty,
      timestamp,
      workerName
    });

    this.shareHistory.push({ timestamp, difficulty: socket.data.difficulty });
    this.stats.recordShare(address, workerName || 'default', socket.data.difficulty.toNumber(), true);
    this.pruneContributions();
  }

  dump() {
    const contributions = Array.from(this.contributions.values());
    this.contributions.clear();
    return contributions;
  }

  getPoolStats() {
    return this.stats.getPoolStats();
  }

  private setupCleanupInterval() {
    setInterval(() => {
      const now = Date.now();

      // Clean up inactive miners
      this.minerStats.forEach((stats, address) => {
        if (stats.lastActive < now - 3600000) {
          this.minerStats.delete(address);
          // Clean up worker stats for this miner
          stats.workerStats.forEach((_, workerName) => {
            this.stats.cleanupWorkerStats(address, workerName);
          });
          // Clean up miner stats
          this.stats.cleanupMinerStats(address);
        }
      });

      // Clean up old share history
      this.shareHistory = this.shareHistory
        .filter(share => share.timestamp > now - 86400000);

      // Clean up old contributions
      this.contributions.forEach((contribution, nonce) => {
        if (contribution.timestamp < now - 86400000) {
          this.contributions.delete(nonce);
        }
      });
    }, 60000);
  }
}
