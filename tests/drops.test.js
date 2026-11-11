import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, decodeTransferCheckedInstruction } from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createDropService } from "../drops.js";

const DOMAIN = "community.example";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const U64 = (1n << 64n) - 1n;
const rejects = (operation, matcher) => assert.rejects(async () => operation(), matcher);

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "jcq-drops-"));
  const host = Keypair.generate();
  const otherHost = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const state = {
    time: Date.now(), balance: U64, frozen: false, mintProgram: TOKEN_PROGRAM_ID,
    genesis: GENESIS, accountMissing: false, blockHeight: 900_000, submissions: 0, confirmations: 0,
    sendError: null, confirmationError: null, chainStatus: null,
  };
  const env = {
    REWARD_HOST_WALLETS: `${host.publicKey.toBase58()},${otherHost.publicKey.toBase58()}`,
    TOKEN_MINT: mint.toBase58(), SOLANA_CLUSTER: "devnet", MEDIA_DATA_DIR: directory,
    ...options.env,
  };
  const connection = {
    getGenesisHash: async () => state.genesis,
    getAccountInfo: async (address) => {
      if (address.equals(mint)) {
        const data = Buffer.alloc(MINT_SIZE);
        MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: U64, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
        return { data, owner: state.mintProgram };
      }
      if (state.accountMissing) return null;
      const data = Buffer.alloc(ACCOUNT_SIZE);
      AccountLayout.encode({ mint, owner: host.publicKey, amount: state.balance, delegateOption: 0, delegate: PublicKey.default, state: state.frozen ? 2 : 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
      return { data, owner: TOKEN_PROGRAM_ID };
    },
    getBalance: async () => 2_000_000_000,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000_000 }),
    getBlockHeight: async () => state.blockHeight,
    sendRawTransaction: async (raw, options) => {
      assert.equal(options.skipPreflight, false);
      assert.equal(options.maxRetries, 0);
      state.submissions++;
      if (state.sendError) throw state.sendError;
      return bs58.encode(Transaction.from(raw).signature);
    },
    confirmTransaction: async () => { state.confirmations++; return { value: { err: state.confirmationError } }; },
    getSignatureStatuses: async () => ({ value: [state.chainStatus] }),
    ...options.connection,
  };
  let service = createDropService({ env, connection, now: () => state.time });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  const signed = async (action, payload, signer = host, domain = DOMAIN) => {
    const challenge = await service.challenge({ wallet: signer.publicKey.toBase58(), action, payload }, domain);
    return { challengeId: challenge.challengeId, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), signer.secretKey)) };
  };
  const act = async (action, payload, signer = host, domain = DOMAIN) => service[action](await signed(action, payload, signer, domain), domain);
  const create = (extra = {}) => act("create", { eventCode: "community-breakfast", title: "Community breakfast", cadPerToken: "0.25", ...extra });
  const approve = (dropId, recipients = [{ wallet: recipient.toBase58(), tier: "breakfast", cadAmount: "2" }]) => act("approve", { dropId, recipients });
  const prepared = async (extra = {}) => { const drop = await create(extra); await approve(drop.id); return act("prepare", { dropId: drop.id }); };
  const signTransaction = (intent, mutate = () => {}) => {
    const transaction = Transaction.from(Buffer.from(intent.transaction, "base64")); mutate(transaction); transaction.sign(host); return transaction.serialize().toString("base64");
  };
  const reopen = () => { service.close(); service = createDropService({ env, connection, now: () => state.time }); return service; };
  return { get service() { return service; }, state, host, otherHost, mint, recipient, env, connection, signed, act, create, approve, prepared, signTransaction, reopen };
}

test("token drops stay unavailable without configured hosts and never expose the RPC endpoint", async (t) => {
  const f = await fixture(t, { env: { REWARD_HOST_WALLETS: "", SOLANA_RPC_URL: "https://rpc.example/?key=private-value" } });
  assert.equal(f.service.config().ready, false);
  assert.equal(JSON.stringify(f.service.config()).includes("private-value"), false);
  await rejects(() => f.create(), (error) => [403, 503].includes(error.status));
  assert.deepEqual((await f.service.list()).drops, []);
});

test("drop approvals require a configured host's domain-bound one-use wallet signature", async (t) => {
  const f = await fixture(t);
  const outsider = Keypair.generate();
  await rejects(() => f.signed("create", { eventCode: "external-host", title: "Not a host", cadPerToken: "1" }, outsider), (e) => [403, 503].includes(e.status));
  const payload = { eventCode: "signed-gathering", title: "Approved gathering", cadPerToken: "0.25" };
  const proof = await f.signed("create", payload);
  await rejects(() => f.service.create({ ...proof, signature: bs58.encode(new Uint8Array(64)) }, DOMAIN), { status: 401 });
  const domainProof = await f.signed("create", payload);
  await rejects(() => f.service.create(domainProof, "other.example"), { status: 401 });
  const validProof = await f.signed("create", payload);
  const drop = await f.service.create(validProof, DOMAIN);
  assert.equal(drop.owner, f.host.publicKey.toBase58());
  await rejects(() => f.service.create(validProof, DOMAIN), { status: 401 });
  assert.equal(f.state.submissions, 0);
});

test("expired signatures cannot create drops and event codes cannot be duplicated", async (t) => {
  const f = await fixture(t);
  const proof = await f.signed("create", { eventCode: "late-event", title: "Late event", cadPerToken: "1" });
  f.state.time += 5 * 60_000 + 1;
  await rejects(() => f.service.create(proof, DOMAIN), { status: 401 });
  await f.create();
  await rejects(() => f.create(), { status: 409 });
});

test("host-entered price is explicit and actions use the signed server-stored payload", async (t) => {
  const f = await fixture(t);
  const proof = await f.signed("create", { eventCode: "bound-event", title: "Signed title", cadPerToken: "0.125" });
  const drop = await f.service.create({ ...proof, payload: { eventCode: "tampered", cadPerToken: "1000" } }, DOMAIN);
  assert.equal(drop.eventCode, "bound-event");
  assert.equal(drop.cadPerToken, "0.125");
  for (const cadPerToken of ["0", "-1", "1e3", "NaN", "0.1234567890123456789"]) {
    await rejects(() => f.create({ eventCode: "bad-price", cadPerToken }), { status: 400 });
  }
});

test("CAD reward caps are up to 2, 5 and 10; repeated tiers never stack", async (t) => {
  const f = await fixture(t); const drop = await f.create();
  for (const [tier, cadAmount] of [["breakfast", "2.01"], ["helping", "5.01"], ["builder", "10.01"], ["builder", "0"], ["builder", "1.001"], ["invented", "1"]]) {
    await rejects(() => f.approve(drop.id, [{ wallet: f.recipient.toBase58(), tier, cadAmount }]), { status: 400 });
  }
  await f.approve(drop.id);
  await f.approve(drop.id, [{ wallet: f.recipient.toBase58(), tier: "builder", cadAmount: "10" }]);
  const current = await f.approve(drop.id, [{ wallet: f.recipient.toBase58(), tier: "helping", cadAmount: "5" }]);
  assert.equal(current.recipients.length, 1);
  assert.equal(current.recipients[0].tier, "builder");
  assert.equal(Number(current.recipients[0].cadAmount), 10);
  assert.equal(f.state.submissions, 0);
});

test("another configured host cannot alter a gathering owned by the funding host", async (t) => {
  const f = await fixture(t); const drop = await f.create();
  await rejects(() => f.act("approve", { dropId: drop.id, recipients: [{ wallet: f.recipient.toBase58(), tier: "breakfast", cadAmount: "2" }] }, f.otherHost), { status: 403 });
  await rejects(() => f.approve(drop.id, [
    { wallet: f.recipient.toBase58(), tier: "breakfast", cadAmount: "1" },
    { wallet: f.recipient.toBase58(), tier: "helping", cadAmount: "2" },
  ]), { status: 400 });
});

test("drop conversion rounds down exact token base units instead of exceeding approved CAD value", async (t) => {
  const f = await fixture(t); const intent = await f.prepared({ cadPerToken: "0.3" });
  assert.equal(intent.recipients.length, 1);
  assert.equal(intent.recipients[0].tokenAmount, "6.666666");
  assert.equal(intent.recipients[0].tokenBaseUnits, "6666666");
  const transaction = Transaction.from(Buffer.from(intent.transaction, "base64"));
  const transfer = decodeTransferCheckedInstruction(transaction.instructions[1]);
  assert.equal(transfer.data.amount, 6666666n);
  assert.equal(transfer.keys.owner.pubkey.toBase58(), f.host.publicKey.toBase58());
  assert.equal(transfer.keys.mint.pubkey.toBase58(), f.mint.toBase58());
  assert.equal(f.state.submissions, 0);
});

test("tiny CAD-per-token prices preserve quantities beyond Number precision", async (t) => {
  const f = await fixture(t); const intent = await f.prepared({ cadPerToken: "0.0000000001" });
  assert.equal(intent.recipients[0].tokenBaseUnits, "20000000000000000");
  assert.equal(intent.recipients[0].tokenAmount, "20000000000");
});

test("invalid network, nonlegacy mint, frozen and insufficient funding prevent preparation", async (t) => {
  const f = await fixture(t); const drop = await f.create(); await f.approve(drop.id);
  f.state.genesis = "wrong-network";
  await rejects(() => f.act("prepare", { dropId: drop.id }), { status: 503 });
  f.state.genesis = GENESIS; f.state.mintProgram = TOKEN_2022_PROGRAM_ID;
  await rejects(() => f.act("prepare", { dropId: drop.id }), { status: 503 });
  f.state.mintProgram = TOKEN_PROGRAM_ID; f.state.frozen = true;
  await rejects(() => f.act("prepare", { dropId: drop.id }), { status: 409 });
  f.state.frozen = false; f.state.balance = 1n;
  await rejects(() => f.act("prepare", { dropId: drop.id }), { status: 400 });
  assert.equal(f.state.submissions, 0);
});

test("changed and unsigned drop transactions cannot be submitted", async (t) => {
  const f = await fixture(t); const intent = await f.prepared();
  await rejects(() => f.service.submit({ intentId: intent.intentId, transaction: intent.transaction }), { status: 400 });
  const changed = f.signTransaction(intent, (tx) => tx.add(SystemProgram.transfer({ fromPubkey: f.host.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })));
  await rejects(() => f.service.submit({ intentId: intent.intentId, transaction: changed }), { status: 400 });
  assert.equal(f.state.submissions, 0);
});

test("confirmed drop pays once and its receipt remains idempotent across a database restart", async (t) => {
  const f = await fixture(t); const intent = await f.prepared();
  const request = { intentId: intent.intentId, transaction: f.signTransaction(intent) };
  const result = await f.service.submit(request);
  assert.equal(result.status, "confirmed");
  assert.ok(result.signature);
  f.reopen();
  assert.deepEqual(await f.service.submit(request), result);
  await rejects(() => f.act("prepare", { dropId: result.dropId }), { status: 409 });
  assert.equal(f.state.submissions, 1);
});

test("uncertain broadcast retains its signature and blocks another payout even after restart", async (t) => {
  const f = await fixture(t); const intent = await f.prepared();
  const request = { intentId: intent.intentId, transaction: f.signTransaction(intent) };
  f.state.sendError = new Error("RPC submission timeout");
  let signature;
  await rejects(() => f.service.submit(request), (error) => { signature = error.signature; return error.status === 503 && Boolean(signature); });
  f.reopen();
  await rejects(() => f.service.submit(request), (error) => Boolean(error.signature) && error.signature === signature);
  await rejects(() => f.act("prepare", { dropId: intent.dropId }), { status: 409 });
  assert.equal(f.state.submissions, 1);
  f.state.blockHeight = 1_000_001;
  assert.equal((await f.service.status(intent.intentId)).status, "pending");
  assert.equal((await f.service.list()).drops[0].status, "submitted");
  f.state.chainStatus = { confirmationStatus: "confirmed", confirmations: 1, err: null };
  const reconciled = await f.service.status(intent.intentId);
  assert.equal(reconciled.status, "confirmed");
  assert.equal(reconciled.signature, signature);
  assert.equal(f.state.submissions, 1);
});

test("persisted prepared and pending receipts retain their original network after configuration changes", async (t) => {
  for (const pending of [false, true]) {
    const f = await fixture(t);
    const intent = await f.prepared();
    const request = { intentId: intent.intentId, transaction: f.signTransaction(intent) };
    let savedSignature = null;
    if (pending) {
      f.state.sendError = new Error("Submission confirmation unavailable");
      await rejects(() => f.service.submit(request), (error) => {
        savedSignature = error.signature;
        return error.status === 503 && Boolean(savedSignature);
      });
    }

    f.env.SOLANA_CLUSTER = "mainnet-beta";
    f.reopen();
    // A status from the newly configured chain must not settle the old drop.
    f.state.chainStatus = { confirmationStatus: "confirmed", confirmations: 1, err: null };
    const receipt = await f.service.status(intent.intentId);
    assert.equal(receipt.cluster, "devnet");
    assert.equal(receipt.status, pending ? "pending" : "prepared");
    assert.equal(receipt.signature, savedSignature);
    const drop = (await f.service.list()).drops[0];
    assert.equal(drop.cluster, "devnet");
    assert.equal(drop.status, pending ? "submitted" : "prepared");
    await rejects(() => f.service.submit(request), { status: 409 });
    await rejects(() => f.act("prepare", { dropId: intent.dropId }), { status: 409 });
    assert.equal(f.state.submissions, pending ? 1 : 0);
  }
});

test("on-chain errors never mark a reward drop paid", async (t) => {
  const f = await fixture(t); const intent = await f.prepared();
  f.state.confirmationError = { InstructionError: [1, "InsufficientFunds"] };
  await rejects(() => f.service.submit({ intentId: intent.intentId, transaction: f.signTransaction(intent) }), (error) => error.status === 422 && Boolean(error.signature));
  const current = await f.service.status(intent.intentId);
  assert.notEqual(current.status, "confirmed");
  assert.equal(f.state.submissions, 1);
});

test("expired unsubmitted drop transactions cannot broadcast", async (t) => {
  const f = await fixture(t); const intent = await f.prepared();
  f.state.time += 120_001;
  await rejects(() => f.service.submit({ intentId: intent.intentId, transaction: f.signTransaction(intent) }), { status: 410 });
  assert.equal(f.state.submissions, 0);
});


test("concurrent signed drop submissions cannot broadcast twice", async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { connection: { confirmTransaction: async () => { await wait; return { value: { err: null } }; } } });
  const intent = await f.prepared();
  const request = { intentId: intent.intentId, transaction: f.signTransaction(intent) };
  const first = f.service.submit(request);
  try { await rejects(() => f.service.submit(request), { status: 409 }); }
  finally { release(); }
  assert.equal((await first).status, "confirmed");
  assert.equal(f.state.submissions, 1);
});

test("prepared recipients cannot be edited and an action proof cannot authorize another action", async (t) => {
  const f = await fixture(t); const intent = await f.prepared();
  await rejects(() => f.approve(intent.dropId, [{ wallet: f.recipient.toBase58(), tier: "builder", cadAmount: "10" }]), { status: 409 });
  const proof = await f.signed("create", { eventCode: "different-action", title: "Not an approval", cadPerToken: "1" });
  await rejects(() => f.service.approve(proof, DOMAIN), { status: 401 });
  assert.equal(f.state.submissions, 0);
});

test("invalid or duplicate recipient wallets and oversized batches are rejected", async (t) => {
  const f = await fixture(t); const drop = await f.create();
  await rejects(() => f.approve(drop.id, [{ wallet: "not-a-wallet", tier: "breakfast", cadAmount: "2" }]), { status: 400 });
  await rejects(() => f.approve(drop.id, [{ wallet: f.host.publicKey.toBase58(), tier: "breakfast", cadAmount: "2" }]), { status: 400 });
  await rejects(() => f.approve(drop.id, Array.from({ length: 6 }, () => ({ wallet: Keypair.generate().publicKey.toBase58(), tier: "breakfast", cadAmount: "2" }))), { status: 400 });
  assert.equal(f.state.submissions, 0);
});


test("approved job drops expose exact tokens while retaining highest-tier CAD caps", async (t) => {
  const f = await fixture(t); const drop = await f.create({ kind: "job", eventCode: "helpful-job" });
  assert.equal(drop.kind, "job");
  const approved = await f.approve(drop.id);
  assert.equal(approved.recipients[0].tokenAmount, "8");
  assert.equal(approved.recipients[0].tokenBaseUnits, "8000000");
  await rejects(() => f.approve(drop.id, [{ wallet: f.recipient.toBase58(), tier: "builder", cadAmount: "10.01" }]), { status: 400 });
  assert.equal(f.state.submissions, 0);
});

test("an unsubmitted expired intent unlocks only after finalized blockhash expiry", async (t) => {
  const f = await fixture(t); const intent = await f.prepared();
  const signed = f.signTransaction(intent);
  f.state.time += 120_001;
  await f.service.status(intent.intentId);
  assert.equal((await f.service.list()).drops[0].status, "prepared");
  f.state.blockHeight = 1_000_001;
  const expired = await f.service.status(intent.intentId);
  assert.equal(expired.status, "expired");
  assert.equal((await f.service.list()).drops[0].status, "approved");
  const next = await f.act("prepare", { dropId: intent.dropId });
  assert.notEqual(next.intentId, intent.intentId);
  await rejects(() => f.service.submit({ intentId: intent.intentId, transaction: signed }), { status: 410 });
  assert.equal(f.state.submissions, 0);
});

test("two service instances sharing storage cannot prepare two active payouts for one gathering", { timeout: 15_000 }, async (t) => {
  let enteredResolve, release;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, { connection: { getLatestBlockhash: async () => {
    calls++;
    if (calls === 1) { enteredResolve(); await wait; }
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000_000 };
  } } });
  const drop = await f.create(); await f.approve(drop.id);
  const first = f.act("prepare", { dropId: drop.id }).then(value => ({ value }), error => ({ error }));
  await entered;
  const other = createDropService({ env: f.env, connection: f.connection, now: () => f.state.time });
  try {
    const challenge = await other.challenge({ wallet: f.host.publicKey.toBase58(), action: "prepare", payload: { dropId: drop.id } }, DOMAIN);
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), f.host.secretKey));
    const second = await Promise.resolve().then(() => other.prepare({ challengeId: challenge.challengeId, signature }, DOMAIN)).then(value => ({ value }), error => ({ error }));
    release();
    const results = [await first, second];
    assert.equal(results.filter(result => result.value).length, 1);
    assert.equal(f.state.submissions, 0);
  } finally { release(); await first; other.close(); }
});
