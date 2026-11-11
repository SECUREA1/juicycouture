import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { MintLayout, MINT_SIZE, AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, decodeTransferCheckedInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { createTipsService, parseTokenAmount, formatTokenAmount } from "../tips.js";

function fixture(overrides = {}) {
  const sender = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  const env = {
    TOKEN_MINT: mint.toBase58(), STREAM_WALLET_ADDRESS: recipient.toBase58(), SOLANA_CLUSTER: "devnet",
    LIVEKIT_URL: "wss://example.livekit.cloud", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-secret",
    ...overrides.env,
  };
  const state = { active: true, owner: TOKEN_PROGRAM_ID, balance: 18446744073709551615n, solLamports: 1234567890, frozen: false, accountMissing: false, accountProgram: TOKEN_PROGRAM_ID, accountWallet: sender.publicKey, accountMint: mint, submissions: 0, confirmations: 0, confirmationError: null, sendError: null };
  const connection = {
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    getAccountInfo: async (address) => {
      if (address.equals(mint)) return { data, owner: state.owner };
      if (state.accountMissing) return null;
      const accountData = Buffer.alloc(ACCOUNT_SIZE);
      AccountLayout.encode({ mint: state.accountMint, owner: state.accountWallet, amount: state.balance, delegateOption: 0, delegate: PublicKey.default, state: state.frozen ? 2 : 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, accountData);
      return { data: accountData, owner: state.accountProgram };
    },
    getBalance: async () => state.solLamports,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 12345 }),
    sendRawTransaction: async (raw, options) => {
      assert.equal(options.skipPreflight, false);
      state.submissions++;
      if (state.sendError) throw state.sendError;
      return bs58.encode(Transaction.from(raw).signature);
    },
    confirmTransaction: async () => { state.confirmations++; return { value: { err: state.confirmationError } }; },
    ...overrides.connection,
  };
  const listParticipants = overrides.listParticipants || (async () => [{ state: 2, tracks: [{ type: 1, muted: !state.active }] }]);
  const service = createTipsService({ env, connection, listParticipants });
  const prepare = (amount = "1.000001") => service.prepare({ room: "test-stream", sender: sender.publicKey.toBase58(), amount });
  const sign = (intent, mutate = () => {}) => {
    const tx = Transaction.from(Buffer.from(intent.transaction, "base64"));
    mutate(tx);
    tx.sign(sender);
    return tx.serialize().toString("base64");
  };
  return { service, state, prepare, sign, sender, recipient, mint, env };
}

test("amounts use exact base units, including values beyond Number precision", () => {
  assert.equal(parseTokenAmount("9007199254.740993", 6), 9007199254740993n);
  assert.equal(parseTokenAmount("0.000001", 6), 1n);
  assert.equal(parseTokenAmount("18446744073709551615", 0), (1n << 64n) - 1n);
  for (const amount of ["0", "-1", "1e3", "NaN", "1.0000001", "01", ".1", "1.", "18446744073709551616"]) {
    assert.throws(() => parseTokenAmount(amount, 6));
  }
  assert.throws(() => parseTokenAmount(1, 6));
});

test("settings never expose the RPC URL and unconfigured payments fail closed", async () => {
  const f = fixture({ env: { STREAM_WALLET_ADDRESS: "", SOLANA_RPC_URL: "https://rpc.example/?key=private" } });
  assert.equal(f.service.settings().ready, false);
  assert.equal(JSON.stringify(f.service.settings()).includes("private"), false);
  assert.equal((await f.service.getStream("test-stream")).active, false);
  await assert.rejects(f.prepare(), { status: 503 });
});

test("only active participants with an unmuted video count as streaming", async () => {
  for (const participants of [[], [{ state: 2, tracks: [{ type: 0, muted: false }] }], [{ state: 2, tracks: [{ type: 1, muted: true }] }], [{ state: 3, tracks: [{ type: 1, muted: false }] }]]) {
    const f = fixture({ listParticipants: async () => participants });
    assert.equal((await f.service.getStream("test-stream")).active, false);
    await assert.rejects(f.prepare(), { status: 409 });
    assert.equal(f.state.submissions, 0);
  }
});

test("LiveKit lookup failures do not enable payments", async () => {
  const f = fixture({ listParticipants: async () => { throw new Error("unavailable"); } });
  await assert.rejects(f.prepare(), { status: 503 });
});

test("Token-2022 and other nonlegacy mints are rejected", async () => {
  const f = fixture();
  f.state.owner = TOKEN_2022_PROGRAM_ID;
  await assert.rejects(f.prepare(), { status: 503 });
});

test("preparation fixes the recipient, mint, sender and exact amount", async () => {
  const f = fixture();
  const intent = await f.prepare();
  assert.equal(intent.recipient, f.recipient.toBase58());
  assert.equal(intent.mint, f.mint.toBase58());
  assert.equal(intent.sender, f.sender.publicKey.toBase58());
  const tx = Transaction.from(Buffer.from(intent.transaction, "base64"));
  assert.equal(tx.instructions.length, 2);
  const transfer = decodeTransferCheckedInstruction(tx.instructions[1]);
  assert.equal(transfer.data.amount, 1000001n);
  assert.equal(transfer.data.decimals, 6);
  assert.equal(transfer.keys.mint.pubkey.toBase58(), f.mint.toBase58());
  assert.equal(transfer.keys.owner.pubkey.toBase58(), f.sender.publicKey.toBase58());
});

test("a changed signed transaction cannot be submitted", async () => {
  const f = fixture();
  const intent = await f.prepare();
  const transaction = f.sign(intent, (tx) => tx.add(SystemProgram.transfer({ fromPubkey: f.sender.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })));
  await assert.rejects(f.service.submit({ intentId: intent.intentId, transaction }), { status: 400 });
  assert.equal(f.state.submissions, 0);
});

test("unsigned requests and unknown intents are rejected", async () => {
  const f = fixture();
  const intent = await f.prepare();
  await assert.rejects(f.service.submit({ intentId: intent.intentId, transaction: intent.transaction }), { status: 400 });
  await assert.rejects(f.service.submit({ intentId: "missing", transaction: intent.transaction }), { status: 410 });
});

test("the stream must still be active before broadcast", async () => {
  const f = fixture();
  const intent = await f.prepare();
  f.state.active = false;
  await assert.rejects(f.service.submit({ intentId: intent.intentId, transaction: f.sign(intent) }), { status: 409 });
  assert.equal(f.state.submissions, 0);
});

test("a confirmed transfer succeeds once; retry returns its receipt", async () => {
  const f = fixture();
  const intent = await f.prepare();
  const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  const result = await f.service.submit(request);
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmationStatus, "confirmed");
  assert.equal(result.signature, bs58.encode(Transaction.from(Buffer.from(request.transaction, "base64")).signature));
  assert.deepEqual(await f.service.submit(request), result);
  assert.equal(f.state.submissions, 1);
});

test("a broadcast error retains the signature and does not retry automatically", async () => {
  const f = fixture();
  const intent = await f.prepare();
  f.state.sendError = new Error("timeout");
  const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  let signature;
  await assert.rejects(f.service.submit(request), (error) => {
    signature = error.signature;
    return error.status === 503 && error.confirmationStatus === "unknown" && Boolean(signature);
  });
  await assert.rejects(f.service.submit(request), (error) => error.status === 503 && error.signature === signature);
  assert.equal(f.state.submissions, 1);
});

test("a confirmed on-chain error is reported as failed, never successful", async () => {
  const f = fixture();
  const intent = await f.prepare();
  f.state.confirmationError = { InstructionError: [1, "InsufficientFunds"] };
  const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  await assert.rejects(f.service.submit(request), (error) => error.status === 422 && error.confirmationStatus === "failed" && Boolean(error.signature));
  await assert.rejects(f.service.submit(request), (error) => error.status === 422 && error.confirmationStatus === "failed");
  assert.equal(f.state.submissions, 1);
});

test("concurrent submissions cannot broadcast twice", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const f = fixture({ connection: { confirmTransaction: async () => { await wait; return { value: { err: null } }; } } });
  const intent = await f.prepare();
  const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  const first = f.service.submit(request);
  await assert.rejects(f.service.submit(request), { status: 409 });
  release();
  assert.equal((await first).status, "confirmed");
  assert.equal(f.state.submissions, 1);
});


test("RPC network mismatches and non-HTTPS RPC settings prevent payments", async () => {
  const mismatch = fixture({ connection: { getGenesisHash: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" } });
  await assert.rejects(mismatch.prepare(), (error) => error.status === 503 && error.message.includes("does not match"));
  assert.equal(mismatch.state.submissions, 0);
  const insecure = fixture({ env: { SOLANA_RPC_URL: "http://rpc.example" } });
  assert.equal(insecure.service.settings().ready, false);
});

test("expired intents cannot be broadcast", async () => {
  const f = fixture();
  const intent = await f.prepare();
  const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  const realNow = Date.now;
  Date.now = () => intent.expiresAt + 1;
  try {
    await assert.rejects(f.service.submit(request), { status: 410 });
    assert.equal(f.state.submissions, 0);
  } finally {
    Date.now = realNow;
  }
});

test("wallet reports exact token and SOL amounts without requiring a stream or recipient", async () => {
  const f = fixture({ env: { STREAM_WALLET_ADDRESS: "", LIVEKIT_URL: "", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "" } });
  f.state.balance = 9007199254740993n;
  const result = await f.service.getWallet(f.sender.publicKey.toBase58());
  assert.equal(result.tokenBalance, "9007199254.740993");
  assert.equal(result.tokenBalanceBaseUnits, "9007199254740993");
  assert.equal(result.solBalance, "1.23456789");
  assert.equal(result.address, f.sender.publicKey.toBase58());
  assert.equal(result.recipient, null);
  assert.equal(result.frozen, false);
  assert.equal(formatTokenAmount(1n, 9), "0.000000001");
  assert.equal(formatTokenAmount(1000000n, 6), "1");
  assert.equal(formatTokenAmount(0n, 6), "0");
  assert.equal(formatTokenAmount(100n, 0), "100");
});

test("a missing associated token account has a verified zero balance", async () => {
  const f = fixture();
  f.state.accountMissing = true;
  f.state.solLamports = 0;
  const result = await f.service.getWallet(f.sender.publicKey.toBase58());
  assert.equal(result.tokenBalance, "0");
  assert.equal(result.tokenBalanceBaseUnits, "0");
  assert.equal(result.solBalance, "0");
  await assert.rejects(f.prepare(), (error) => error.status === 400 && error.message.includes("enough"));
});

test("frozen and insufficient source token balances prevent preparation", async () => {
  const f = fixture();
  f.state.frozen = true;
  assert.equal((await f.service.getWallet(f.sender.publicKey.toBase58())).frozen, true);
  await assert.rejects(f.prepare(), (error) => error.status === 409 && error.message.includes("frozen"));
  f.state.frozen = false;
  f.state.balance = 1000000n;
  await assert.rejects(f.prepare(), (error) => error.status === 400 && error.message.includes("enough"));
  await f.prepare("1");
  assert.equal(f.state.submissions, 0);
});

test("wallet reads validate addresses, cluster, token owner and token mint", async () => {
  const f = fixture();
  await assert.rejects(f.service.getWallet("not-a-wallet"), { status: 400 });
  for (const mismatch of ["accountWallet", "accountMint"]) {
    const original = f.state[mismatch];
    f.state[mismatch] = Keypair.generate().publicKey;
    await assert.rejects(f.service.getWallet(f.sender.publicKey.toBase58()), { status: 503 });
    f.state[mismatch] = original;
  }
  f.state.accountProgram = TOKEN_2022_PROGRAM_ID;
  await assert.rejects(f.service.getWallet(f.sender.publicKey.toBase58()), { status: 503 });
  const wrongNetwork = fixture({ connection: { getGenesisHash: async () => "wrong-network" } });
  await assert.rejects(wrongNetwork.service.getWallet(wrongNetwork.sender.publicKey.toBase58()), { status: 503 });
});

test("RPC failures never fabricate a zero wallet balance or leak provider secrets", async () => {
  const f = fixture({ connection: { getBalance: async () => { throw new Error("https://rpc.example/?secret=private"); } } });
  await assert.rejects(f.service.getWallet(f.sender.publicKey.toBase58()), (error) => error.status === 503 && !error.message.includes("private"));
  const unsafe = fixture();
  unsafe.state.solLamports = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(unsafe.service.getWallet(unsafe.sender.publicKey.toBase58()), { status: 503 });
});
