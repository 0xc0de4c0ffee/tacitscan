// Bitcoin Core JSON-RPC client (works with dRPC, QuickNode, GetBlock,
// or any provider exposing the standard Bitcoin RPC surface). Implements
// BitcoinDataSource so it can stand in for Esplora.
//
// The big win over Esplora: `getblock <hash> 2` returns a full block —
// header + every tx with witness data — in ONE HTTP call. Esplora
// requires `tx_count / 25` page calls per block.
import pRetry, { AbortError } from "p-retry";
import type { EsploraTx, EsploraTxInput, EsploraTxOutput } from "./esplora.js";
import type { BitcoinDataSource, FullBlock } from "./source.js";

interface RpcVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  scriptSig?: { asm: string; hex: string };
  txinwitness?: string[];
  sequence?: number;
}

interface RpcVout {
  value: number;
  n: number;
  scriptPubKey: { asm: string; hex: string; type: string; address?: string; addresses?: string[] };
}

interface RpcTx {
  txid: string;
  hash: string;
  version: number;
  size: number;
  weight: number;
  locktime: number;
  vin: RpcVin[];
  vout: RpcVout[];
}

interface RpcBlockV2 {
  hash: string;
  height: number;
  time: number;
  previousblockhash?: string;
  nTx: number;
  tx: RpcTx[];
}

export class BitcoinRpcClient implements BitcoinDataSource {
  readonly name = "rpc";
  constructor(private readonly url: string) {}

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    return pRetry(
      async () => {
        const r = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "tacitscan-indexer/0.1" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
          // Bound per-call latency so a single stuck dRPC connection
          // can't freeze the block walker.
          signal: AbortSignal.timeout(20_000),
        });
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          const text = await r.text();
          throw new AbortError(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { result?: T; error?: { code: number; message: string } };
        if (data.error) {
          // Some RPC errors are permanent (bad params); others are transient.
          // We can't always distinguish, so retry — pRetry's cap will stop us.
          throw new Error(`rpc ${method}: ${data.error.message}`);
        }
        return data.result as T;
      },
      { retries: 4, minTimeout: 400, maxTimeout: 4000, factor: 2 },
    );
  }

  async getTipHeight(): Promise<number> {
    return this.call<number>("getblockcount");
  }

  async getBlockHashByHeight(h: number): Promise<string> {
    return this.call<string>("getblockhash", [h]);
  }

  async fetchBlock(height: number): Promise<FullBlock> {
    const hash = await this.getBlockHashByHeight(height);
    const blk = await this.call<RpcBlockV2>("getblock", [hash, 2]);
    const txs = blk.tx.map((tx) => rpcTxToEsplora(tx, blk.height, blk.hash, blk.time));
    return {
      hash: blk.hash,
      height: blk.height,
      timestamp: blk.time,
      previousblockhash: blk.previousblockhash ?? null,
      tx_count: blk.tx.length,
      txs,
    };
  }

  async getMempoolTxids(): Promise<string[]> {
    // verbose=false → array of txids; cheap (~few MB at peak mempool).
    return this.call<string[]>("getrawmempool", [false]);
  }

  async fetchTx(txid: string): Promise<EsploraTx> {
    // verbose=2 returns full decoded tx including witness data.
    const tx = await this.call<RpcTx & { in_active_chain?: boolean; blockhash?: string; blocktime?: number; confirmations?: number }>(
      "getrawtransaction",
      [txid, 2],
    );
    // Mempool tx has no block context; pass 0/empty placeholders that the
    // caller (mempool poller) ignores. Block fields aren't used downstream
    // for chain_status='mempool' inserts.
    return rpcTxToEsplora(tx, 0, tx.blockhash ?? "", tx.blocktime ?? Math.floor(Date.now() / 1000));
  }
}

function rpcTxToEsplora(tx: RpcTx, blockHeight: number, blockHash: string, blockTime: number): EsploraTx {
  const vin: EsploraTxInput[] = tx.vin.map((v) => ({
    txid: v.txid ?? "",
    vout: v.vout ?? 0,
    prevout: null,
    scriptsig: v.scriptSig?.hex ?? "",
    scriptsig_asm: v.scriptSig?.asm ?? "",
    witness: v.txinwitness,
    is_coinbase: typeof v.coinbase === "string",
    sequence: v.sequence ?? 0,
  }));
  const vout: EsploraTxOutput[] = tx.vout.map((o) => ({
    scriptpubkey: o.scriptPubKey.hex,
    scriptpubkey_asm: o.scriptPubKey.asm,
    scriptpubkey_type: o.scriptPubKey.type,
    scriptpubkey_address: o.scriptPubKey.address ?? o.scriptPubKey.addresses?.[0],
    // Bitcoin RPC returns BTC; convert to sats. Use round to avoid floating
    // imprecision around 8-decimal boundaries.
    value: Math.round((o.value ?? 0) * 1e8),
  }));
  return {
    txid: tx.txid,
    version: tx.version,
    locktime: tx.locktime,
    size: tx.size,
    weight: tx.weight,
    // Fee isn't part of getblock v2 output; we'd need prevouts to compute
    // it. null means "unknown" so the frontend renders "—" instead of
    // "0 sats" (which would be a lie).
    fee: null,
    vin,
    vout,
    status: {
      confirmed: true,
      block_height: blockHeight,
      block_hash: blockHash,
      block_time: blockTime,
    },
  };
}
