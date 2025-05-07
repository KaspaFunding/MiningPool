import { Header, PoW, type RpcClient, type IRawBlock } from "../../wasm/kaspa"
import Jobs from "./jobs"

export default class Templates {
  private rpc: RpcClient
  private address: string
  private identity: string
  private daaWindow: number

  private templates: Map<string, [IRawBlock, PoW]> = new Map()
  private jobs = new Jobs()

  constructor(rpc: RpcClient, address: string, identity: string, daaWindow: number) {
    this.rpc = rpc
    this.address = address
    this.identity = identity
    this.daaWindow = daaWindow

    this.rpc.addEventListener('connect', () => this.rpc.subscribeNewBlockTemplate())
  }

  getHash(id: string) {
    return this.jobs.getHash(id)
  }

  getPoW(hash: string) {
    return this.templates.get(hash)?.[1]
  }

  /**
   * Submits a block to the node after setting the nonce.
   * Handles different rejection reasons and retries if necessary.
   * 
   * @param hash The hash of the block template
   * @param nonce The nonce to set in the block header
   * @returns {Promise<Header>} The finalized block header
   */
  async submit(hash: string, nonce: bigint): Promise<Header> {
    const template = this.templates.get(hash)
    if (!template) throw new Error("Template not found")
    template[0].header.nonce = nonce

    while (true) {
      const { report } = await this.rpc.submitBlock({
        block: template[0],
        allowNonDAABlocks: false
      })

      // If the block is successfully submitted
      if (report.type === 'success') {
        // Return the header directly without finalizing (if finalize returns string)
        return new Header(template[0].header) // Create a new Header object
      }

      // If the block submission was rejected
      if (report.type === 'reject') {
        let errorMsg = 'Block submission failed. Reason unknown.'

        // Handle rejection reasons
        if (report.reason === 'IsInIBD') {
          errorMsg = 'Node is in Initial Block Download (IBD) — retrying in 5 seconds.'
        } else if (report.reason === 'RouteIsFull') {
          errorMsg = 'Route is full — retrying in 5 seconds.'
        } else if (report.reason === 'BlockInvalid') {
          errorMsg = 'Block is invalid — please check block data.'
        }

        console.warn(errorMsg)
        
        // Retry after a brief delay for certain errors
        if (report.reason === 'IsInIBD' || report.reason === 'RouteIsFull') {
          await new Promise(resolve => setTimeout(resolve, 5000)) // Retry after delay
        } else {
          // If the block is invalid, throw an error immediately
          throw new Error(errorMsg)
        }
      }
    }
  }

  async register(callback: (id: string, hash: string, timestamp: bigint) => void) {
    this.rpc.addEventListener('new-block-template', async () => {
      const { block } = await this.rpc.getBlockTemplate({
        payAddress: this.address,
        extraData: this.identity
      })

      const proofOfWork = new PoW(block.header)
      if (this.templates.has(proofOfWork.prePoWHash)) return

      this.templates.set(proofOfWork.prePoWHash, [block, proofOfWork])
      const id = this.jobs.deriveId(proofOfWork.prePoWHash)

      if (this.templates.size > this.daaWindow) {
        this.templates.delete(this.templates.entries().next().value![0])
        this.jobs.expireNext()
      }

      callback(id, proofOfWork.prePoWHash, block.header.timestamp)
    })

    await this.rpc.subscribeNewBlockTemplate()
  }
}
