// Local test fixture only. It never connects to a blockchain or moves funds.
import http from "node:http";
import { once } from "node:events";
import { Keypair, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import { decodeTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

export async function startRpcFixture() {
  const transactions = new Map();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    let result;
    try {
      switch (request.method) {
        case "getGenesisHash": result = "EtWTRAB-test-fixture-not-a-real-chain"; break;
        case "getLatestBlockhash": result = { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 10000 } }; break;
        case "getBalance": result = { context: { slot: 1 }, value: 10_000_000_000 }; break;
        case "getFeeForMessage": result = { context: { slot: 1 }, value: 5000 }; break;
        case "getSignatureStatuses": result = { context: { slot: 1 }, value: request.params[0].map((signature) => transactions.has(signature)
          ? { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null) }; break;
        case "getBlockHeight": result = 1; break;
        case "getTransaction": result = transactions.get(request.params[0]) || null; break;
        case "sendTransaction": {
          const tx = Transaction.from(Buffer.from(request.params[0], "base64"));
          if (!tx.verifySignatures()) throw new Error("Unsigned test transaction");
          const signature = bs58.encode(tx.signature);
          const instructions = [];
          for (const ix of tx.instructions) {
            if (ix.programId.equals(SystemProgram.programId)) {
              const transfer = SystemInstruction.decodeTransfer(ix);
              instructions.push({ programId: ix.programId.toBase58(), parsed: { type: "transfer", info: {
                source: transfer.fromPubkey.toBase58(), destination: transfer.toPubkey.toBase58(), lamports: Number(transfer.lamports),
              } } });
            } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
              const transfer = decodeTransferCheckedInstruction(ix);
              instructions.push({ programId: ix.programId.toBase58(), parsed: { type: "transferChecked", info: {
                source: transfer.keys.source.pubkey.toBase58(), destination: transfer.keys.destination.pubkey.toBase58(),
                authority: transfer.keys.owner.pubkey.toBase58(), mint: transfer.keys.mint.pubkey.toBase58(),
                tokenAmount: { amount: transfer.data.amount.toString(), decimals: transfer.data.decimals },
              } } });
            }
          }
          transactions.set(signature, { blockTime: Math.floor(Date.now() / 1000), meta: { err: null }, transaction: {
            signatures: [signature], message: { accountKeys: [{ pubkey: tx.feePayer.toBase58(), signer: true }], instructions },
          } });
          result = signature; break;
        }
        default: throw new Error(`Unsupported fixture method ${request.method}`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } }));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, transactions, close: () => new Promise((resolve) => server.close(resolve)) };
}
