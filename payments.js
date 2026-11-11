import bs58 from "bs58";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { formatAmount } from "./amounts.js";

const METHODS = new Set(["getLatestBlockhash", "getBalance", "getAccountInfo", "getTokenAccountsByOwner", "getTokenAccountBalance", "getSignatureStatuses", "getFeeForMessage", "getMinimumBalanceForRentExemption", "getBlockHeight", "sendTransaction"]);

export function createPayments({ rpcUrl, cluster, mint = "" }) {
  const endpoint = new URL(rpcUrl);
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw new Error("SOLANA_RPC_URL must use HTTPS.");
  async function rpc(method, params = [], id = 1) {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("The Solana network is unavailable. Please try again shortly.");
    return response.json();
  }
  let checkedCluster;
  async function checkCluster() {
    checkedCluster ||= rpc("getGenesisHash").then((data) => {
      const prefix = cluster === "devnet" ? "EtWTRAB" : "5eykt4";
      if (typeof data.result !== "string" || !data.result.startsWith(prefix)) throw new Error("The Solana RPC network does not match the displayed tipping network.");
    }).catch((error) => { checkedCluster = null; throw error; });
    return checkedCluster;
  }
  return {
    config: { cluster, chain: cluster === "devnet" ? "solana:devnet" : "solana:mainnet", rpcPath: "/api/solana", mint: mint || null },
    async proxy(body) {
      if (!body || !METHODS.has(body.method) || !Array.isArray(body.params || [])) throw new Error("Unsupported Solana request.");
      if (body.id != null && !["number", "string"].includes(typeof body.id)) throw new Error("Invalid RPC request.");
      await checkCluster();
      return rpc(body.method, body.params || [], body.id ?? 1);
    },
    async verifyTip({ signature, recipient, asset, notBefore }) {
      try { if (bs58.decode(signature).length !== 64) throw new Error(); } catch { throw new Error("Invalid transaction signature."); }
      if (!["SOL", "JCQ"].includes(asset) || (asset === "JCQ" && !mint)) throw new Error("This tipping asset is not configured.");
      await checkCluster();
      const result = await rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (result.error) throw new Error("Could not verify this transaction. Check its explorer receipt.");
      const tx = result.result;
      if (!tx || tx.meta?.err !== null || tx.transaction?.signatures?.[0] !== signature) throw new Error("This transaction is not confirmed successfully yet.");
      if (!Number.isFinite(tx.blockTime) || tx.blockTime * 1000 < notBefore - 30_000) throw new Error("This transaction predates the live room.");
      const sender = tx.transaction.message.accountKeys.find((key) => key.signer)?.pubkey;
      if (!sender || sender === recipient) throw new Error("The sender and host must be different wallets.");
      const instructions = tx.transaction.message.instructions;
      let amount, decimals;
      if (asset === "SOL") {
        const transfer = instructions.find((ix) => ix.programId === SystemProgram.programId.toBase58()
          && ix.parsed?.type === "transfer" && ix.parsed.info.destination === recipient && ix.parsed.info.source === sender);
        if (!transfer || !Number.isSafeInteger(transfer.parsed.info.lamports) || transfer.parsed.info.lamports <= 0) throw new Error("This transaction does not tip the host receiving wallet.");
        amount = BigInt(transfer.parsed.info.lamports);
        decimals = 9;
      } else {
        const destination = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(recipient)).toBase58();
        const transfer = instructions.find((ix) => ix.programId === TOKEN_PROGRAM_ID.toBase58() && ix.parsed?.type === "transferChecked"
          && ix.parsed.info.destination === destination && ix.parsed.info.mint === mint && ix.parsed.info.authority === sender);
        if (!transfer) throw new Error("This transaction does not send JCQ to the host.");
        amount = BigInt(transfer.parsed.info.tokenAmount.amount);
        decimals = transfer.parsed.info.tokenAmount.decimals;
        if (amount <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid JCQ transfer.");
      }
      return { signature, sender, recipient, asset, amount: formatAmount(amount, decimals), cluster };
    },
  };
}
