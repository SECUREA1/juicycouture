import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { MintLayout, MINT_SIZE, AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { createSwapService } from "../swaps.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
function fixture(options = {}) {
  const wallet = Keypair.generate();
  const customMint = Keypair.generate().publicKey;
  const state = { calls: [], submissions: 0, confirmations: 0, sol: 10000000000, balance: 18446744073709551615n, frozen: false, genesis: GENESIS, mintOwner: TOKEN_PROGRAM_ID, sendError: null, confirmationError: null, quoteChange: (value) => value, transactionChange: (value) => value, providerStatus: 200 };
  const connection = {
    getGenesisHash: async () => state.genesis,
    getBalance: async () => state.sol,
    getAccountInfo: async (address) => {
      if (address.toBase58() === USDC || address.equals(customMint)) {
        const data = Buffer.alloc(MINT_SIZE);
        MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 18446744073709551615n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
        return { owner: state.mintOwner, data };
      }
      const data = Buffer.alloc(ACCOUNT_SIZE);
      AccountLayout.encode({ mint: customMint, owner: wallet.publicKey, amount: state.balance, delegateOption: 0, delegate: PublicKey.default, state: state.frozen ? 2 : 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
      return { owner: TOKEN_PROGRAM_ID, data };
    },
    sendRawTransaction: async (raw, options) => {
      assert.equal(options.skipPreflight, false); assert.equal(options.maxRetries, 0);
      state.submissions++; if (state.sendError) throw state.sendError;
      return bs58.encode(Transaction.from(raw).signature);
    },
    confirmTransaction: async () => { state.confirmations++; return { value: { err: state.confirmationError } }; },
    ...options.connection,
  };
  function buildRoute(q) {
    const data = Buffer.alloc(35);
    Buffer.from("e517cb977ae3ad2a", "hex").copy(data);
    data.writeUInt32LE(1, 8);
    data[12] = 7; data[13] = 100; data[14] = 0; data[15] = 1;
    data.writeBigUInt64LE(BigInt(q.inAmount), 16);
    data.writeBigUInt64LE(BigInt(q.outAmount), 24);
    data.writeUInt16LE(q.slippageBps, 32);
    data[34] = 0;
    const input = getAssociatedTokenAddressSync(new PublicKey(q.inputMint), wallet.publicKey);
    const output = getAssociatedTokenAddressSync(new PublicKey(q.outputMint), wallet.publicKey);
    return new TransactionInstruction({ programId: JUPITER, data, keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: input, isSigner: false, isWritable: true },
      { pubkey: output, isSigner: false, isWritable: true },
      { pubkey: JUPITER, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.outputMint), isSigner: false, isWritable: false },
      { pubkey: JUPITER, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
      { pubkey: JUPITER, isSigner: false, isWritable: false },
    ] });
  }
  const fetchImpl = async (url, request) => {
    state.calls.push({ url, request });
    if (state.providerStatus !== 200) return new Response("secret provider detail", { status: state.providerStatus });
    if (url.includes("/quote?")) {
      const query = new URL(url).searchParams;
      const payload = state.quoteChange({ inputMint: query.get("inputMint"), outputMint: query.get("outputMint"), inAmount: query.get("amount"), outAmount: "2000000", otherAmountThreshold: "1990000", swapMode: "ExactIn", slippageBps: Number(query.get("slippageBps")), priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "Test pool" }, percent: 100 }], platformFee: null });
      return Response.json(payload);
    }
    const body = JSON.parse(request.body);
    assert.equal(body.userPublicKey, wallet.publicKey.toBase58());
    assert.equal(body.dynamicSlippage, false); assert.equal(body.asLegacyTransaction, true);
    assert.equal(body.prioritizationFeeLamports, 0); assert.equal(body.useSharedAccounts, false);
    assert.equal(body.feeAccount, undefined); assert.equal(body.destinationTokenAccount, undefined);
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }), buildRoute(body.quoteResponse));
    state.transactionChange(tx, body.quoteResponse);
    return Response.json({ swapTransaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), lastValidBlockHeight: 200000, prioritizationFeeLamports: 0 });
  };
  const service = createSwapService({ env: { JUPITER_API_KEY: "test-private-key", SOLANA_CLUSTER: "mainnet-beta", TOKEN_MINT: customMint.toBase58(), ...options.env }, connection, fetchImpl });
  const quote = (extra = {}) => service.quote({ wallet: wallet.publicKey.toBase58(), inputMint: SOL, outputMint: USDC, amount: "0.1", ...extra });
  const prepare = async (extra) => service.prepare({ quoteId: (await quote(extra)).quoteId });
  const sign = (intent, mutate = () => {}) => { const tx = Transaction.from(Buffer.from(intent.transaction, "base64")); mutate(tx); tx.sign(wallet); return tx.serialize().toString("base64"); };
  return { service, state, quote, prepare, sign, wallet, customMint };
}

test("swaps require mainnet and a configured API key; public settings contain no credentials", async () => {
  for (const env of [{ JUPITER_API_KEY: "" }, { SOLANA_CLUSTER: "devnet" }, { SOLANA_RPC_URL: "http://untrusted.invalid/?token=secret" }]) {
    const f = fixture({ env });
    assert.equal(f.service.settings().ready, false);
    assert.equal(JSON.stringify(f.service.settings()).includes("secret"), false);
    assert.equal(JSON.stringify(f.service.settings()).includes("test-private-key"), false);
    await assert.rejects(f.quote(), { status: 503 });
    assert.equal(f.state.calls.length, 0);
  }
});

test("exact quotes bind the wallet, token pair, decimals and slippage", async () => {
  const f = fixture();
  const q = await f.quote();
  assert.equal(q.wallet, f.wallet.publicKey.toBase58());
  assert.equal(q.amount, "0.1"); assert.equal(q.expectedOutput, "2"); assert.equal(q.minimumOutput, "1.99");
  assert.equal(q.inputDecimals, 9); assert.equal(q.outputDecimals, 6);
  const request = f.state.calls[0];
  assert.equal(request.request.headers["x-api-key"], "test-private-key");
  assert.ok(request.url.startsWith("https://api.jup.ag/swap/v1/quote?"));
  assert.equal(new URL(request.url).searchParams.get("instructionVersion"), "V1");
  assert.equal(new URL(request.url).searchParams.get("amount"), "100000000");
});

test("token quantities larger than Number precision remain exact", async () => {
  const f = fixture();
  const q = await f.quote({ inputMint: f.customMint.toBase58(), amount: "9007199254.740993" });
  assert.equal(q.amount, "9007199254.740993");
  assert.equal(new URL(f.state.calls[0].url).searchParams.get("amount"), "9007199254740993");
});

test("invalid amounts, wallet addresses, pairs and slippage are rejected before provider calls", async () => {
  const f = fixture();
  for (const change of [{ amount: "1e6" }, { wallet: "invalid" }, { outputMint: SOL }, { slippageBps: 101 }, { slippageBps: 0 }, { slippageBps: "50" }, { amount: "0" }, { amount: "0.0000000001" }]) {
    await assert.rejects(f.quote(change), { status: 400 });
  }
  assert.equal(f.state.calls.length, 0);
});

test("wrong network, insufficient funds, frozen and Token-2022 input mints fail closed", async () => {
  const f = fixture();
  f.state.genesis = "devnet"; await assert.rejects(f.quote(), { status: 503 });
  f.state.genesis = GENESIS; f.state.sol = 100; await assert.rejects(f.quote(), { status: 400 });
  f.state.sol = 10000000000; f.state.mintOwner = TOKEN_2022_PROGRAM_ID;
  await assert.rejects(f.quote({ inputMint: f.customMint.toBase58(), amount: "1" }), { status: 400 });
  f.state.mintOwner = TOKEN_PROGRAM_ID; f.state.frozen = true;
  await assert.rejects(f.quote({ inputMint: f.customMint.toBase58(), amount: "1" }), { status: 409 });
  assert.equal(f.state.calls.length, 0);
});

test("provider failures hide credentials and raw error bodies", async () => {
  const f = fixture(); f.state.providerStatus = 401;
  await assert.rejects(f.quote(), (error) => error.status === 503 && !error.message.includes("secret") && !error.message.includes("private-key"));
});

test("provider quotes cannot change tokens, amount, mode, slippage or fees", async () => {
  for (const change of [
    { inputMint: USDC }, { outputMint: SOL }, { inAmount: "1" }, { swapMode: "ExactOut" }, { slippageBps: 100 },
    { platformFee: { amount: "1", feeBps: 1 } }, { otherAmountThreshold: "1" }, { priceImpactPct: "21" }, { routePlan: [] },
  ]) {
    const f = fixture(); f.state.quoteChange = (quote) => ({ ...quote, ...change });
    await assert.rejects(f.quote(), { status: 503 });
  }
});

test("expired quote IDs cannot build transactions", async () => {
  const f = fixture(); const q = await f.quote();
  const realNow = Date.now;
  try { Date.now = () => q.expiresAt + 1; await assert.rejects(f.service.prepare({ quoteId: q.quoteId }), { status: 410 }); }
  finally { Date.now = realNow; }
  assert.equal(f.state.calls.length, 1);
});

test("preparation uses only the server-stored quote and returns one reusable intent", async () => {
  const f = fixture(); const q = await f.quote();
  const first = await f.service.prepare({ quoteId: q.quoteId, quoteResponse: { inAmount: "999" }, wallet: Keypair.generate().publicKey.toBase58() });
  assert.equal(first.wallet, f.wallet.publicKey.toBase58()); assert.equal(first.amount, "0.1");
  const second = await f.service.prepare({ quoteId: q.quoteId });
  assert.deepEqual(second, first); assert.equal(f.state.calls.length, 2);
  assert.equal(JSON.parse(f.state.calls[1].request.body).quoteResponse.inAmount, "100000000");
});

test("bad Jupiter amounts, destinations and extra arbitrary transfers are rejected", async () => {
  for (const mutate of [
    (tx) => { tx.instructions[1].data.writeBigUInt64LE(999n, 16); },
    (tx) => { tx.instructions[1].data.writeBigUInt64LE(1n, 24); },
    (tx) => { tx.instructions[1].data.writeUInt16LE(100, 32); },
    (tx) => { tx.instructions[1].data[34] = 1; },
    (tx) => { tx.instructions[1].keys[3].pubkey = Keypair.generate().publicKey; },
    (tx) => { tx.instructions[1].keys[5].pubkey = new PublicKey(SOL); },
    (tx) => { tx.instructions[1].data[0] = 0; },
    (tx) => { tx.instructions[1].data = Buffer.concat([tx.instructions[1].data, tx.instructions[1].data.subarray(-19)]); },
    (tx) => { tx.instructions[1].data[12] = 255; },
    (tx) => { tx.instructions[1].data.writeUInt32LE(0, 8); },
    (tx) => tx.add(SystemProgram.transfer({ fromPubkey: tx.feePayer, toPubkey: Keypair.generate().publicKey, lamports: 1 })),
    (tx) => tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000000 })),
    (tx) => tx.add(createApproveInstruction(Keypair.generate().publicKey, Keypair.generate().publicKey, tx.feePayer, 1n)),
  ]) {
    const f = fixture(); f.state.transactionChange = mutate;
    await assert.rejects(f.prepare(), { status: 503 });
    assert.equal(f.state.submissions, 0);
  }
});

test("a signed swap must exactly match the prepared transaction", async () => {
  const f = fixture(); const intent = await f.prepare();
  await assert.rejects(f.service.submit({ intentId: intent.intentId, transaction: intent.transaction }), { status: 400 });
  const changed = f.sign(intent, (tx) => tx.add(SystemProgram.transfer({ fromPubkey: f.wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })));
  await assert.rejects(f.service.submit({ intentId: intent.intentId, transaction: changed }), { status: 400 });
  assert.equal(f.state.submissions, 0);
});

test("a confirmed swap returns one receipt and cannot broadcast twice", async () => {
  const f = fixture(); const intent = await f.prepare();
  const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  const result = await f.service.submit(request);
  assert.equal(result.status, "confirmed"); assert.equal(result.cluster, "mainnet-beta");
  assert.deepEqual(await f.service.submit(request), result);
  assert.equal(f.state.submissions, 1); assert.equal(f.state.confirmations, 1);
});

test("uncertain broadcasts preserve a signature and never retry automatically", async () => {
  const f = fixture(); const intent = await f.prepare(); f.state.sendError = new Error("timeout with private provider detail");
  const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  let signature;
  await assert.rejects(f.service.submit(request), (error) => { signature = error.signature; return error.status === 503 && Boolean(signature) && !error.message.includes("private"); });
  await assert.rejects(f.service.submit(request), (error) => error.signature === signature);
  assert.equal(f.state.submissions, 1);
});

test("on-chain failures are never described as confirmed swaps", async () => {
  const f = fixture(); const intent = await f.prepare(); f.state.confirmationError = { InstructionError: [1, "Custom"] };
  await assert.rejects(f.service.submit({ intentId: intent.intentId, transaction: f.sign(intent) }), (error) => error.status === 422 && error.confirmationStatus === "failed" && Boolean(error.signature));
});

test("expired intents and parallel submissions cannot broadcast twice", async () => {
  const f = fixture(); const intent = await f.prepare(); const request = { intentId: intent.intentId, transaction: f.sign(intent) };
  const realNow = Date.now;
  try { Date.now = () => intent.expiresAt + 1; await assert.rejects(f.service.submit(request), { status: 410 }); }
  finally { Date.now = realNow; }
  const next = await f.prepare(); const nextRequest = { intentId: next.intentId, transaction: f.sign(next) };
  const first = f.service.submit(nextRequest);
  await assert.rejects(f.service.submit(nextRequest), { status: 409 });
  assert.equal((await first).status, "confirmed"); assert.equal(f.state.submissions, 1);
});


test("native SOL setup and cleanup are allowed only for the connected wallet's WSOL account", async () => {
  const f = fixture();
  f.state.transactionChange = (tx, q) => {
    const wallet = f.wallet.publicKey;
    const wrapped = getAssociatedTokenAddressSync(new PublicKey(SOL), wallet);
    const output = getAssociatedTokenAddressSync(new PublicKey(q.outputMint), wallet);
    const [budget, route] = tx.instructions;
    tx.instructions = [budget,
      createAssociatedTokenAccountIdempotentInstruction(wallet, wrapped, wallet, new PublicKey(SOL)),
      createAssociatedTokenAccountIdempotentInstruction(wallet, output, wallet, new PublicKey(q.outputMint)),
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wrapped, lamports: BigInt(q.inAmount) }),
      createSyncNativeInstruction(wrapped), route, createCloseAccountInstruction(wrapped, wallet, wallet)];
  };
  const intent = await f.prepare();
  assert.equal((await f.service.submit({ intentId: intent.intentId, transaction: f.sign(intent) })).status, "confirmed");
});

test("token-to-SOL routes unwrap output only to their connected owner", async () => {
  const f = fixture();
  f.state.transactionChange = (tx) => {
    const wallet = f.wallet.publicKey;
    const wrapped = getAssociatedTokenAddressSync(new PublicKey(SOL), wallet);
    tx.instructions.splice(1, 0, createAssociatedTokenAccountIdempotentInstruction(wallet, wrapped, wallet, new PublicKey(SOL)));
    tx.add(createCloseAccountInstruction(wrapped, wallet, wallet));
  };
  const intent = await f.prepare({ inputMint: f.customMint.toBase58(), outputMint: SOL, amount: "1" });
  assert.equal(intent.outputSymbol, "SOL");
  assert.equal((await f.service.submit({ intentId: intent.intentId, transaction: f.sign(intent) })).status, "confirmed");
});

test("Whirlpool V2's optional account metadata is parsed canonically", async () => {
  const good = fixture();
  good.state.transactionChange = (tx) => {
    const old = tx.instructions[1].data;
    tx.instructions[1].data = Buffer.concat([old.subarray(0, 12), Buffer.from([47, 1, 0, 100, 0, 1]), old.subarray(-19)]);
  };
  assert.ok((await good.prepare()).intentId);
  for (const payload of [[47, 2, 0, 100, 0, 1], [47, 1, 2, 100, 0, 1], [47, 1, 1, 65, 0, 0, 0, 100, 0, 1]]) {
    const bad = fixture();
    bad.state.transactionChange = (tx) => {
      const old = tx.instructions[1].data;
      tx.instructions[1].data = Buffer.concat([old.subarray(0, 12), Buffer.from(payload), old.subarray(-19)]);
    };
    await assert.rejects(bad.prepare(), { status: 503 });
  }
});
