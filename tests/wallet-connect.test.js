import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createWalletRegistry } from "../wallet-connect.js";

function fixture({ versions = ["legacy", 0], chains = ["solana:devnet"] } = {}) {
  const signer = Keypair.generate();
  const other = Keypair.generate();
  let change;
  let listed = [];
  let cluster = "devnet";
  const listeners = new Map();
  const account = { address: signer.publicKey.toBase58(), publicKey: signer.publicKey.toBytes(), chains, features: ["solana:signTransaction", "solana:signMessage"] };
  const wallet = {
    name: "Test Standard Wallet", accounts: [account],
    features: {
      "standard:connect": { connect: async () => ({ accounts: wallet.accounts }) },
      "standard:events": { on: (_event, callback) => { change = callback; return () => { change = null; }; } },
      "standard:disconnect": { disconnect: async () => {} },
      "solana:signTransaction": {
        supportedTransactionVersions: versions,
        signTransaction: async ({ transaction, chain, account: selected }) => {
          assert.equal(chain, "solana:devnet"); assert.equal(selected, account);
          let tx;
          try { tx = Transaction.from(transaction); tx.sign(signer); }
          catch { tx = VersionedTransaction.deserialize(transaction); tx.sign([signer]); }
          return [{ signedTransaction: tx.serialize() }];
        },
      },
      "solana:signMessage": { signMessage: async ({ message, account: selected }) => { assert.equal(selected, account); return [{ signedMessage: message, signature: new Uint8Array(64) }]; } },
    },
  };
  const registry = {
    get: () => listed,
    on(event, callback) { listeners.set(event, callback); return () => listeners.delete(event); },
  };
  const api = createWalletRegistry({ target: {}, registry, getCluster: () => cluster });
  function register() { listed = [wallet]; listeners.get("register")?.(wallet); }
  const legacy = () => new Transaction({ feePayer: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: other.publicKey, lamports: 1 }));
  const versioned = () => new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: legacy().instructions }).compileToV0Message());
  return { signer, other, wallet, account, api, register, legacy, versioned, change: (...args) => change?.(...args), cluster: (value) => { cluster = value; } };
}

test("compatible wallets register late alongside injected fallbacks", async () => {
  const f = fixture(); const notifications = [];
  f.api.subscribe((wallets) => notifications.push(wallets.map((wallet) => wallet.id)));
  assert.deepEqual(f.api.list().map((wallet) => wallet.id), ["phantom", "solflare"]);
  f.register();
  assert.equal(notifications.length, 2);
  assert.equal(f.api.list()[2].name, "Test Standard Wallet");
  assert.equal((await f.api.list()[2].connect()).address, f.signer.publicKey.toBase58());
  f.api.dispose();
});

test("standard wallets sign legacy and versioned transactions on the requested network", async () => {
  const f = fixture(); f.register(); const adapter = f.api.list()[2]; await adapter.connect();
  const legacy = f.legacy(); const signed = await adapter.signTransaction(legacy);
  assert.ok(signed.verifySignatures()); assert.deepEqual(signed.serializeMessage(), legacy.serializeMessage());
  const v0 = f.versioned(); const signedV0 = await adapter.signTransaction(v0);
  assert.equal(signedV0.version, 0); assert.ok(signedV0.signatures[0].some(Boolean));
  assert.deepEqual(signedV0.message.serialize(), v0.message.serialize());
  assert.equal((await adapter.signMessage(new Uint8Array([1, 2, 3]))).length, 64);
});

test("standard wallets reject unsupported chains and transaction versions", async () => {
  const f = fixture({ chains: ["solana:mainnet"] }); f.register();
  await assert.rejects(f.api.list()[2].connect(), /no signing account/);
  const g = fixture({ versions: ["legacy"] }); g.register(); const adapter = g.api.list()[2]; await adapter.connect();
  await assert.rejects(adapter.signTransaction(g.versioned()), /transaction format/);
});

test("account changes and disconnects propagate and prevent signing with the old account", async () => {
  const f = fixture(); f.register(); const adapter = f.api.list()[2]; await adapter.connect();
  let changedAddress; let disconnected = false;
  adapter.on("accountChanged", (key) => { changedAddress = key.toBase58(); });
  adapter.on("disconnect", () => { disconnected = true; });
  f.change({ accounts: [{ ...f.account, address: f.other.publicKey.toBase58(), publicKey: f.other.publicKey.toBytes() }] });
  assert.equal(changedAddress, f.other.publicKey.toBase58());
  f.change({ accounts: [] }); assert.equal(disconnected, true);
  await assert.rejects(adapter.signTransaction(f.legacy()), /Reconnect/);
});

test("an account switch during standard signing rejects the returned transaction", async () => {
  const f = fixture(); f.register(); const adapter = f.api.list()[2]; await adapter.connect();
  const original = f.wallet.features["solana:signTransaction"].signTransaction;
  f.wallet.features["solana:signTransaction"].signTransaction = async (input) => {
    const result = await original(input); f.change({ accounts: [] }); return result;
  };
  await assert.rejects(adapter.signTransaction(f.legacy()), /account or network changed/);
});

test("injected adapters detect altered transactions and optional message-signing support", async () => {
  const signer = Keypair.generate(), destination = Keypair.generate().publicKey;
  const injected = { publicKey: signer.publicKey, connect: async () => {}, signTransaction: async (tx) => { tx.instructions[0].data[4] = 99; tx.sign(signer); return tx; } };
  const registry = { get: () => [], on: () => () => {} };
  const wallets = createWalletRegistry({ target: { phantom: { solana: injected } }, registry, getCluster: () => "devnet" });
  const adapter = wallets.list()[0]; await adapter.connect(); assert.equal(adapter.canSignMessage, false);
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: destination, lamports: 1 }));
  await assert.rejects(adapter.signTransaction(tx), /signed transaction changed/);
  await assert.rejects(adapter.signMessage(new Uint8Array([1])), /cannot sign messages/);
});
