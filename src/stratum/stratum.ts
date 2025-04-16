import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { Decimal } from 'decimal.js';
import type { Miner } from './index';
import { StratumError, type Event } from './protocol';
import type Templates from '../templates';
import { calculateTarget, Address } from '../../wasm/kaspa';

export interface Contribution {
  address: string;
  difficulty: Decimal;
  timestamp: number;
  workerName?: string;
}

export interface BlockData {
  hash: string;
  contributions: Contribution[];
  timestamp: number;
}

export default class Stratum extends EventEmitter {
  private templates: Templates;
  private contributions = new Map<bigint, Contribution>();
  private blockData = new Map<string, BlockData>();
  private pplnsWindowSize = 100000;

  subscriptors = new Set<Socket<Miner>>();
  miners = new Map<string, Set<Socket<Miner>>>();

  constructor(templates: Templates) {
    super();
    this.templates = templates;
    this.templates.register((id, hash, timestamp) => this.announce(id, hash, timestamp));
  }

  private announce(id: string, hash: string, timestamp: bigint) {
    const timestampLE = Buffer.alloc(8);
    timestampLE.writeBigUInt64LE(timestamp);

    const event: Event<'mining.notify'> = {
      method: 'mining.notify',
      params: [id, hash + timestampLE.toString('hex')],
    };

    const json = JSON.stringify(event);

    this.subscriptors.forEach((socket) => {
      // @ts-ignore
      if (socket.readyState === 1) {
        socket.write(json + '\n');
      } else {
        for (const [address] of socket.data.workers) {
          const group = this.miners.get(address);
          group?.delete(socket);
          if (group && group.size === 0) this.miners.delete(address);
        }
        this.subscriptors.delete(socket);
      }
    });
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

    const group = this.miners.get(address) ?? new Set<Socket<Miner>>();
    group.add(socket);
    this.miners.set(address, group);

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
    const hash = this.templates.getHash(id);
    if (!hash) throw new StratumError('job-not-found');

    const state = this.templates.getPoW(hash);
    if (!state) throw new StratumError('job-not-found');

    const nonce = BigInt('0x' + work);
    if (this.contributions.has(nonce)) throw new StratumError('duplicate-share');

    const [isBlock, target] = state.checkWork(nonce);
    if (target > calculateTarget(socket.data.difficulty.toNumber())) {
      throw new StratumError('low-difficulty-share');
    }

    const contribution: Contribution = {
      address,
      difficulty: socket.data.difficulty,
      timestamp: Date.now(),
      workerName,
    };

    this.contributions.set(nonce, contribution);
    this.trimContributions();

    if (isBlock) {
      const blockHash = await this.templates.submit(hash, nonce);
      const recent = Array.from(this.contributions.values()).filter(
        c => Date.now() - c.timestamp < 600_000
      );

      this.blockData.set(blockHash, {
        hash: blockHash,
        contributions: recent,
        timestamp: Date.now(),
      });

      this.emit('block', blockHash, {
        address,
        difficulty: socket.data.difficulty,
        contributions: recent,
      });
    }
  }

  dump(): Contribution[] {
    const values = Array.from(this.contributions.values());
    this.contributions.clear();
    return values;
  }

  private trimContributions() {
    if (this.contributions.size > this.pplnsWindowSize) {
      const sorted = [...this.contributions.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      );
      const toRemove = sorted.length - this.pplnsWindowSize;
      for (let i = 0; i < toRemove; i++) {
        this.contributions.delete(sorted[i][0]);
      }
    }
  }

  getBlockContributions(hash: string): Contribution[] {
    return this.blockData.get(hash)?.contributions || [];
  }
}
