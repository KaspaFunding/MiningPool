import { EventEmitter } from 'events';
import { PrivateKey, UtxoProcessor, UtxoContext, type RpcClient, type IPaymentOutput, createTransactions } from "../../wasm/kaspa";

const startTime = BigInt(Date.now());

UtxoProcessor.setCoinbaseTransactionMaturityDAA('mainnet', 200n);
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-10', 200n);
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-11', 2000n);

export default class Treasury extends EventEmitter {
  privateKey: PrivateKey;
  address: string;
  processor: UtxoProcessor;
  context: UtxoContext;
  fee: number;
  rpc: RpcClient;

  constructor(rpc: RpcClient, networkId: string, privateKey: string, fee: number) {
    super();

    this.rpc = rpc;
    this.privateKey = new PrivateKey(privateKey);
    this.address = (this.privateKey.toAddress(networkId)).toString();
    this.processor = new UtxoProcessor({ rpc, networkId });
    this.context = new UtxoContext({ processor: this.processor });
    this.fee = fee;

    this.registerProcessor();
  }

  /**
   * Sends the specified outputs after confirming there are enough spendable UTXOs.
   * @param {IPaymentOutput[]} outputs - The payment outputs to send.
   * @returns {Promise<string[]>} - Transaction hashes.
   */
  async send(outputs: IPaymentOutput[]): Promise<string[]> {
    const { estimate } = await this.rpc.getFeeEstimate({});
    const rpc = this.processor.rpc;

    // Retrieve all mature UTXOs from the UtxoContext
    const matureUtxos = await this.context.getMatureRange(0, 100); // Retrieve the first 100, adjust based on your needs
    const availableBalance = matureUtxos.reduce((total, utxo) => total + BigInt(utxo.amount), 0n);

    // Calculate the required balance (including fees)
    const requiredBalance = outputs.reduce((total, output) => total + BigInt(output.amount), 0n);
    const feeAmount = BigInt(estimate.lowBuckets[0].feerate); // Adjust this based on your fee rate
    const totalRequired = requiredBalance + feeAmount;

    // Check if we have enough mature UTXOs to cover the required amount
    if (availableBalance < totalRequired) {
      throw new Error('Insufficient funds: Not enough mature UTXOs to cover the required amount.');
    }

    const hashes: string[] = [];

    for (const output of outputs) {
      const { transactions, summary } = await createTransactions({
        entries: this.context,
        outputs: [output],
        changeAddress: this.address,
        priorityFee: 0n,
        feeRate: estimate.lowBuckets[0].feerate,
      });

      for (const transaction of transactions) {
        transaction.sign([this.privateKey.toString()]);
        await transaction.submit(rpc);
        hashes.push(summary.finalTransactionId!);
      }
    }

    return hashes;
  }

  private registerProcessor(): void {
    this.processor.addEventListener("utxo-proc-start", async () => {
      await this.context.clear();
      await this.context.trackAddresses([this.address]);
    });

    this.processor.addEventListener('maturity', async (e) => {
      if (!e.data.isCoinbase) return;

      const { timestamps } = await this.rpc.getDaaScoreTimestampEstimate({
        daaScores: [e.data.blockDaaScore],
      });

      if (timestamps[0] < startTime) return;

      const reward = e.data.value;
      const poolFee = (reward * BigInt(this.fee * 100)) / 10000n;

      this.emit('coinbase', reward - poolFee);
      this.emit('revenue', poolFee);
    });

    this.processor.start();
  }
}
