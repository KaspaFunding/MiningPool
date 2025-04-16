import type { RpcClient } from "../../wasm/kaspa";
import type { IPaymentOutput } from "../../wasm/kaspa";
import type Database from "./database";
import { Decimal } from "decimal.js";
import type { Contribution } from "../types"; // assumes Contribution includes address + difficulty

type PaymentCallback = (contributors: number, payments: IPaymentOutput[]) => void;

type BlockReward = {
  amount: bigint;
  blockHash: string;
};

export default class Rewarding {
  private node: RpcClient;
  private database: Database;
  private paymentThreshold: Decimal;

  private blockContributions = new Map<string, Contribution[]>();
  private pendingRewards: BlockReward[] = [];
  private isProcessing = false;

  constructor(node: RpcClient, database: Database, paymentThreshold: string) {
    this.node = node;
    this.database = database;
    this.paymentThreshold = new Decimal(paymentThreshold);
  }

  recordContributions(blockHash: string, contributions: Contribution[]) {
    this.blockContributions.set(blockHash, contributions);
    return contributions.length;
  }

  recordPayment(amount: bigint, blockHash: string, callback: PaymentCallback) {
    this.pendingRewards.push({ amount, blockHash });
    this.processPayments(callback);
  }

  private async processPayments(callback: PaymentCallback) {
    if (this.isProcessing || this.pendingRewards.length === 0) return;
    this.isProcessing = true;

    try {
      const { amount, blockHash } = this.pendingRewards.shift()!;
      const contributions = this.blockContributions.get(blockHash) || [];

      // Check if block is blue (finalized)
      const { blue } = await this.node.getCurrentBlockColor({ hash: blockHash }).catch(() => ({ blue: false }));
      if (!blue) {
        console.warn(`Skipping non-blue block: ${blockHash}`);
        return;
      }

      const totalWork = contributions.reduce(
        (sum, c) => sum.add(c.difficulty),
        new Decimal(0)
      );

      const payments: IPaymentOutput[] = [];
      const alreadyProcessed = new Set<string>();

      for (const contrib of contributions) {
        const share = contrib.difficulty.div(totalWork);
        const rewardDecimal = new Decimal(amount.toString()).mul(share);
        const rewardBigInt = BigInt(rewardDecimal.floor().toFixed(0));

        // Update miner's balance
        const miner = this.database.getMiner(contrib.address);
        const newBalance = new Decimal(miner.balance.toString()).add(rewardDecimal);
        alreadyProcessed.add(contrib.address);

        if (newBalance.greaterThanOrEqualTo(this.paymentThreshold)) {
          this.database.addBalance(contrib.address, -miner.balance); // Reset stored balance

          payments.push({
            address: contrib.address,
            amount: BigInt(newBalance.floor().toFixed(0))
          });
        } else {
          this.database.addBalance(contrib.address, rewardBigInt);
        }
      }

      callback(alreadyProcessed.size, payments);
    } catch (err) {
      console.error("Payment processing failed:", err);
    } finally {
      this.isProcessing = false;
      if (this.pendingRewards.length > 0) {
        setImmediate(() => this.processPayments(callback));
      }
    }
  }
}
