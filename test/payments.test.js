import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemInstruction } from "@solana/web3.js";
import { decodeTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { parseAmount, formatAmount } from "../amounts.js";
import { createTipTransaction, walletAddress } from "../transactions.js";
import { createPayments } from "../payments.js";
import { startRpcFixture } from "../test-fixtures/solana-rpc.js";

test("amounts stay exact and reject rounding, exponent and negative inputs", () => {
  assert.equal(parseAmount("0.000000001", 9), 1n);
  assert.equal(parseAmount("12.345678901", 9), 12345678901n);
  assert.equal(formatAmount(12345678901n, 9), "12.345678901");
  for (const value of ["0", "-1", "1e3", "0.0000000001", "NaN", "01.1", "1,000"]) assert.throws(() => parseAmount(value, 9));
});

test("SOL and JCQ transactions target the designated wallet and exact amount", () => {
  const sender = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const sol = createTipTransaction({ sender, recipient, amount: "0.005", asset: "SOL", blockhash });
  const transfer = SystemInstruction.decodeTransfer(sol.instructions[0]);
  assert.equal(transfer.toPubkey.toBase58(), recipient);
  assert.equal(transfer.lamports, 5_000_000n);
  const jcq = createTipTransaction({ sender, recipient, amount: "12.3456", asset: "JCQ", decimals: 6, mint: mint.toBase58(), blockhash });
  const token = decodeTransferCheckedInstruction(jcq.instructions[1]);
  assert.equal(token.keys.destination.pubkey.toBase58(), getAssociatedTokenAddressSync(mint, transfer.toPubkey).toBase58());
  assert.equal(token.data.amount, 12345600n);
  assert.throws(() => createTipTransaction({ sender, recipient, amount: "1", asset: "JCQ", blockhash }), /official mint/);
  assert.throws(() => createTipTransaction({ sender, recipient: sender, amount: "1", asset: "SOL", blockhash }), /different/);
  assert.throws(() => walletAddress("0x0123456789012345678901234567890123456789"), /Solana wallet/);
});

test("receipts verify the actual chain transfer and reject wrong recipient, asset, time and network", async (t) => {
  const fixture = await startRpcFixture(); t.after(() => fixture.close());
  const payments = createPayments({ rpcUrl: fixture.url, cluster: "devnet" });
  const payer = Keypair.generate(); const recipient = Keypair.generate().publicKey.toBase58();
  const recent = await payments.proxy({ method: "getLatestBlockhash", params: [], id: 1 });
  const tx = createTipTransaction({ sender: payer.publicKey.toBase58(), recipient, amount: "0.01", asset: "SOL", blockhash: recent.result.value.blockhash });
  tx.sign(payer);
  const sent = await payments.proxy({ method: "sendTransaction", params: [tx.serialize().toString("base64"), { encoding: "base64" }], id: 2 });
  const receipt = await payments.verifyTip({ signature: sent.result, recipient, asset: "SOL", notBefore: Date.now() - 1000 });
  assert.equal(receipt.amount, "0.01"); assert.equal(receipt.sender, payer.publicKey.toBase58());
  await assert.rejects(payments.verifyTip({ signature: sent.result, recipient: Keypair.generate().publicKey.toBase58(), asset: "SOL", notBefore: 0 }), /receiving wallet/);
  await assert.rejects(payments.verifyTip({ signature: sent.result, recipient, asset: "JCQ", notBefore: 0 }), /not configured/);
  await assert.rejects(payments.verifyTip({ signature: sent.result, recipient, asset: "SOL", notBefore: Date.now() + 120000 }), /predates/);
  await assert.rejects(createPayments({ rpcUrl: fixture.url, cluster: "mainnet-beta" }).proxy({ method: "getBalance", params: [] }), /network does not match/);
  await assert.rejects(payments.proxy({ method: "requestAirdrop", params: [] }), /Unsupported/);
  fixture.transactions.get(sent.result).meta.err = { InstructionError: [0, "InsufficientFunds"] };
  await assert.rejects(payments.verifyTip({ signature: sent.result, recipient, asset: "SOL", notBefore: 0 }), /not confirmed successfully/);
});

test("a configured JCQ receipt verifies the checked SPL transfer to the host token account", async (t) => {
  const fixture = await startRpcFixture(); t.after(() => fixture.close());
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const payments = createPayments({ rpcUrl: fixture.url, cluster: "devnet", mint });
  const recent = await payments.proxy({ method: "getLatestBlockhash", params: [] });
  const tx = createTipTransaction({ sender: payer.publicKey.toBase58(), recipient, asset: "JCQ", amount: "12.3456", decimals: 6, mint, blockhash: recent.result.value.blockhash });
  tx.sign(payer);
  const sent = await payments.proxy({ method: "sendTransaction", params: [tx.serialize().toString("base64")] });
  const receipt = await payments.verifyTip({ signature: sent.result, recipient, asset: "JCQ", notBefore: Date.now() - 1000 });
  assert.equal(receipt.asset, "JCQ");
  assert.equal(receipt.amount, "12.3456");
  assert.equal(receipt.recipient, recipient);
});
