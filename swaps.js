import { randomUUID } from "node:crypto";
import { Connection, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, clusterApiUrl } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, unpackAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { parseTokenAmount, formatTokenAmount } from "./tips.js";
import { serverFetch } from "./network.js";

// API contract: jup-ag/jupiter-quote-api-node/swagger.yaml; instruction layout:
// jup-ag/jupiter-cpi/idl.json, ExactIn V1 route/sharedAccountsRoute instructions.
const API = "https://api.jup.ag/swap/v1";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_U64 = (1n << 64n) - 1n;
const QUOTE_TTL = 30_000;
const INTENT_TTL = 120_000;
const MAX_PENDING = 500;
const MAX_TRANSACTION_BYTES = 1232;

export class SwapError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; Object.assign(this, details); }
}
function key(value, label = "Token mint", onCurve = false) {
  try {
    if (typeof value !== "string") throw new Error();
    const pubkey = new PublicKey(value);
    if (pubkey.toBase58() !== value || (onCurve && !PublicKey.isOnCurve(pubkey.toBytes()))) throw new Error();
    return pubkey;
  } catch { throw new SwapError(400, `${label} must be a valid Solana address.`); }
}
function units(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) throw new Error("Invalid base units");
  const parsed = BigInt(value);
  if (parsed > MAX_U64) throw new Error("Amount exceeds u64");
  return parsed;
}
function same(a, b) { return a?.equals(b) === true; }
function invalidTransaction() { return new SwapError(503, "This swap route could not be verified. No transaction was submitted. Try another token pair."); }

// Canonical V1 Borsh RoutePlanStep sizes from the official CPI IDL. Parsing
// every step prevents trailing bytes from disguising the actual amount fields.
// Unknown newer AMM enum variants fail closed instead of guessing their layout.
// Newer V1 variants from @jup-ag/instruction-parser@6.0.28's bundled IDL.
const SWAP_EXTRA_BYTES = [0,0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1,1,1,0,0,1,0,1,1,0,0,1,1,16,0,0,0,4,0,0,0,0,0,1,0,4,3,10,5,5,0,-1,0,0,0,0,0,0,0,0,0,0,1,0,1,1];
function routeAmountOffset(data, shared, quote) {
  let offset = shared ? 9 : 8;
  if (data.length < offset + 4) throw invalidTransaction();
  const count = data.readUInt32LE(offset); offset += 4;
  if (count < 1 || count > 8 || count !== quote.payload.routePlan.length) throw invalidTransaction();
  let percent = 0;
  for (let index = 0; index < count; index++) {
    if (offset >= data.length) throw invalidTransaction();
    const variant = data[offset++];
    const extra = SWAP_EXTRA_BYTES[variant];
    if (extra === undefined) throw invalidTransaction();
    if (variant === 47) {
      if (offset + 2 > data.length || data[offset] > 1 || data[offset + 1] > 1) throw invalidTransaction();
      const hasRemainingAccounts = data[offset + 1]; offset += 2;
      if (hasRemainingAccounts) {
        if (offset + 4 > data.length) throw invalidTransaction();
        const slices = data.readUInt32LE(offset); offset += 4;
        if (slices > 64 || offset + slices * 2 > data.length) throw invalidTransaction();
        for (let slice = 0; slice < slices; slice++) {
          if (data[offset] > 1) throw invalidTransaction();
          offset += 2;
        }
      }
    } else {
      if (offset + extra + 3 > data.length || (extra === 1 && data[offset] > 1)) throw invalidTransaction();
      if (variant === 42 && (data[offset + 1] > 1 || data[offset + 2] > 1)) throw invalidTransaction();
      offset += extra;
    }
    if (offset + 3 > data.length) throw invalidTransaction();
    const share = data[offset++], inputIndex = data[offset++], outputIndex = data[offset++];
    if (share < 1 || share > 100 || inputIndex !== 0 || outputIndex !== 1) throw invalidTransaction();
    percent += share;
  }
  if (percent !== 100 || offset + 19 !== data.length) throw invalidTransaction();
  return offset;
}

// Limit the transaction envelope as well as the amounts: no external approvals,
// fees to third parties, authority changes, or custom signer destinations.
function validateBuiltTransaction(transaction, quote) {
  const wallet = key(quote.wallet, "Wallet", true);
  const inputMint = key(quote.inputMint), outputMint = key(quote.outputMint);
  const input = getAssociatedTokenAddressSync(inputMint, wallet);
  const output = getAssociatedTokenAddressSync(outputMint, wallet);
  const wrapped = getAssociatedTokenAddressSync(new PublicKey(SOL), wallet);
  if (!same(transaction.feePayer, wallet) || transaction.signatures.length !== 1 || !same(transaction.signatures[0].publicKey, wallet) || transaction.signatures[0].signature !== null) throw invalidTransaction();
  let routes = 0;
  let funded = 0n;
  for (const instruction of transaction.instructions) {
    const { programId, keys, data } = instruction;
    if (same(programId, JUPITER)) {
      routes++;
      const discriminator = data.subarray(0, 8).toString("hex");
      if (!["e517cb977ae3ad2a", "c1209b3341d69c81"].includes(discriminator)) throw invalidTransaction();
      const amountOffset = routeAmountOffset(data, discriminator === "c1209b3341d69c81", quote);
      if (data.readBigUInt64LE(amountOffset) !== quote.inUnits || data.readBigUInt64LE(amountOffset + 8) !== quote.outUnits || data.readUInt16LE(amountOffset + 16) !== quote.slippageBps || data[amountOffset + 18] !== 0) throw invalidTransaction();
      if (discriminator === "e517cb977ae3ad2a") {
        if (keys.length < 9 || !same(keys[0].pubkey, TOKEN_PROGRAM_ID) || !same(keys[1].pubkey, wallet) || !keys[1].isSigner || !same(keys[2].pubkey, input) || !same(keys[3].pubkey, output) || !same(keys[5].pubkey, outputMint) || !same(keys[8].pubkey, JUPITER)) throw invalidTransaction();
        if (!same(keys[4].pubkey, JUPITER) && !same(keys[4].pubkey, output)) throw invalidTransaction();
        if (!same(keys[6].pubkey, JUPITER)) throw invalidTransaction();
      } else if (discriminator === "c1209b3341d69c81") {
        if (keys.length < 13 || !same(keys[0].pubkey, TOKEN_PROGRAM_ID) || !same(keys[2].pubkey, wallet) || !keys[2].isSigner || !same(keys[3].pubkey, input) || !same(keys[6].pubkey, output) || !same(keys[7].pubkey, inputMint) || !same(keys[8].pubkey, outputMint) || !same(keys[9].pubkey, JUPITER) || !same(keys[12].pubkey, JUPITER)) throw invalidTransaction();
      } else throw invalidTransaction();
    } else if (same(programId, ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (![0, 1].includes(data.length) || (data.length === 1 && data[0] !== 1) || keys.length < 6 || keys.length > 7 || !same(keys[0].pubkey, wallet) || !same(keys[2].pubkey, wallet) || (!same(keys[3].pubkey, inputMint) && !same(keys[3].pubkey, outputMint)) || !same(keys[1].pubkey, getAssociatedTokenAddressSync(keys[3].pubkey, wallet)) || !same(keys[4].pubkey, SystemProgram.programId) || !same(keys[5].pubkey, TOKEN_PROGRAM_ID) || (keys[6] && !same(keys[6].pubkey, SYSVAR_RENT_PUBKEY))) throw invalidTransaction();
    } else if (same(programId, SystemProgram.programId)) {
      if (data.length !== 12 || data.readUInt32LE(0) !== 2 || keys.length !== 2 || quote.inputMint !== SOL || !same(keys[0].pubkey, wallet) || !same(keys[1].pubkey, wrapped)) throw invalidTransaction();
      funded += data.readBigUInt64LE(4);
      if (funded > quote.inUnits) throw invalidTransaction();
    } else if (same(programId, TOKEN_PROGRAM_ID)) {
      const isSolPair = quote.inputMint === SOL || quote.outputMint === SOL;
      if (data.length !== 1 || !isSolPair || !same(keys[0]?.pubkey, wrapped)) throw invalidTransaction();
      if (data[0] === 17 && keys.length === 1) continue; // SyncNative
      if (data[0] === 9 && keys.length === 3 && same(keys[1].pubkey, wallet) && same(keys[2].pubkey, wallet)) continue; // CloseAccount back to its owner
      throw invalidTransaction();
    } else if (same(programId, ComputeBudgetProgram.programId)) {
      if (keys.length !== 0) throw invalidTransaction();
      if (data[0] === 2 && data.length === 5 && data.readUInt32LE(1) > 0 && data.readUInt32LE(1) <= 1_400_000) continue;
      if (data[0] === 3 && data.length === 9 && data.readBigUInt64LE(1) === 0n) continue;
      throw invalidTransaction();
    } else throw invalidTransaction();
  }
  if (routes !== 1) throw invalidTransaction();
}

export function createSwapService({ env = process.env, connection, fetchImpl = serverFetch } = {}) {
  const cluster = env.SOLANA_CLUSTER || "mainnet-beta";
  const apiKey = String(env.JUPITER_API_KEY || "");
  const tokens = [{ mint: SOL, symbol: "SOL", decimals: 9 }, { mint: USDC, symbol: "USDC", decimals: 6 }];
  try {
    const mint = key(String(env.TOKEN_MINT || "").trim()).toBase58();
    if (!tokens.some((token) => token.mint === mint)) tokens.push({ mint, symbol: String(env.COIN_SYMBOL || "JCQ").replace(/^\$/, "") });
  } catch { /* An unconfigured project mint does not prevent SOL/USDC swaps. */ }
  let rpc = connection;
  let configError = "";
  try {
    const endpoint = env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
    if (new URL(endpoint).protocol !== "https:") throw new Error();
    rpc ||= new Connection(endpoint, { commitment: "confirmed", fetch: fetchImpl });
  } catch { configError = "The Solana RPC settings need attention before swaps are available."; }
  const quotes = new Map(), intents = new Map();
  function settings() {
    const ready = Boolean(cluster === "mainnet-beta" && apiKey && !configError);
    return { ready, cluster, tokens, message: configError || (cluster !== "mainnet-beta" ? "Token swaps are available on Solana mainnet only." : !apiKey ? "Token swaps need Jupiter service setup by the app owner." : "Swap tokens in your connected wallet. Review the quote and approve in your wallet.") };
  }
  function requireReady() { if (!settings().ready) throw new SwapError(503, settings().message); }
  function prune() {
    const now = Date.now();
    for (const [id, value] of quotes) if (value.expiresAt <= now && !value.preparing) quotes.delete(id);
    for (const [id, value] of intents) if (value.expiresAt <= now && !value.submitting) intents.delete(id);
  }
  async function verifyNetwork() {
    let genesis;
    try { genesis = await rpc.getGenesisHash(); }
    catch { throw new SwapError(503, "The Solana network could not be verified. Please try again later."); }
    if (genesis !== MAINNET_GENESIS) throw new SwapError(503, "The RPC network does not match Solana mainnet. No swap was submitted.");
  }
  async function tokenInfo(mintText) {
    const mint = key(mintText);
    if (mintText === SOL) return { mint: mintText, symbol: "SOL", decimals: 9 };
    let token;
    try { token = await getMint(rpc, mint, "confirmed", TOKEN_PROGRAM_ID); }
    catch { throw new SwapError(400, "This token mint could not be verified as a standard Solana SPL token."); }
    if (!token.isInitialized) throw new SwapError(400, "This token mint is not initialized.");
    return { mint: mintText, symbol: tokens.find((entry) => entry.mint === mintText)?.symbol || "SPL token", decimals: token.decimals };
  }
  async function checkBalance(wallet, input, amount) {
    try {
      if (input.mint === SOL) {
        const lamports = await rpc.getBalance(wallet, "confirmed");
        if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error();
        if (amount >= BigInt(lamports)) throw new SwapError(400, "Your wallet needs enough SOL for the swap and network fees.");
      } else {
        const ata = getAssociatedTokenAddressSync(key(input.mint), wallet);
        const info = await rpc.getAccountInfo(ata, "confirmed");
        if (!info) throw new SwapError(400, "Your wallet does not hold enough of the input token.");
        const account = unpackAccount(ata, info, TOKEN_PROGRAM_ID);
        if (!account.isInitialized || !same(account.owner, wallet) || !same(account.mint, key(input.mint))) throw new Error();
        if (account.isFrozen) throw new SwapError(409, "The input token account is frozen and cannot swap.");
        if (amount > account.amount) throw new SwapError(400, "Your wallet does not hold enough of the input token.");
      }
    } catch (error) {
      if (error instanceof SwapError) throw error;
      throw new SwapError(503, "Your wallet balance could not be verified. Please try again later.");
    }
  }
  async function provider(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(API + path, {
        ...options, headers: { accept: "application/json", "x-api-key": apiKey, ...(options.body ? { "content-type": "application/json" } : {}) },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = []; let length = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 2_000_000) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value)); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { throw new SwapError(503, "The swap provider is unavailable or has no supported route. Please try again later."); }
  }
  function display(quote) {
    return {
      quoteId: quote.id, wallet: quote.wallet, cluster: "mainnet-beta", inputMint: quote.inputMint, outputMint: quote.outputMint,
      inputSymbol: quote.input.symbol, outputSymbol: quote.output.symbol, inputDecimals: quote.input.decimals, outputDecimals: quote.output.decimals,
      amount: formatTokenAmount(quote.inUnits, quote.input.decimals), expectedOutput: formatTokenAmount(quote.outUnits, quote.output.decimals),
      minimumOutput: formatTokenAmount(quote.minimumUnits, quote.output.decimals), slippageBps: quote.slippageBps, priceImpactPct: quote.priceImpactPct,
      expiresAt: quote.expiresAt,
    };
  }
  async function quote({ wallet: rawWallet, inputMint, outputMint, amount, slippageBps = 50 } = {}) {
    requireReady();
    const wallet = key(rawWallet, "Wallet", true);
    key(inputMint); key(outputMint);
    if (inputMint === outputMint) throw new SwapError(400, "Choose two different tokens to swap.");
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100) throw new SwapError(400, "Slippage must be between 1 and 100 basis points (up to 1%).");
    prune(); if (quotes.size >= MAX_PENDING) throw new SwapError(429, "There are too many pending quotes. Please wait and try again.");
    await verifyNetwork();
    const [input, output] = await Promise.all([tokenInfo(inputMint), tokenInfo(outputMint)]);
    let inUnits;
    try { inUnits = parseTokenAmount(amount, input.decimals); }
    catch (error) { throw new SwapError(400, error.message); }
    await checkBalance(wallet, input, inUnits);
    const params = new URLSearchParams({ inputMint, outputMint, amount: inUnits.toString(), slippageBps: String(slippageBps), swapMode: "ExactIn", asLegacyTransaction: "true", instructionVersion: "V1", onlyDirectRoutes: "true", restrictIntermediateTokens: "true", platformFeeBps: "0", maxAccounts: "32", dexes: "Raydium,Orca V2,Meteora DLMM,Raydium CP,Raydium CLMM,Whirlpool" });
    const payload = await provider(`/quote?${params}`);
    let outUnits, minimumUnits;
    try {
      outUnits = units(payload.outAmount);
      const threshold = units(payload.otherAmountThreshold);
      minimumUnits = outUnits * BigInt(10_000 - slippageBps) / 10_000n;
      if (minimumUnits <= 0n || threshold < minimumUnits || threshold > outUnits || payload.inputMint !== inputMint || payload.outputMint !== outputMint || payload.inAmount !== inUnits.toString() || payload.swapMode !== "ExactIn" || payload.slippageBps !== slippageBps || !Array.isArray(payload.routePlan) || !payload.routePlan.length || payload.routePlan.length > 8 || (payload.platformFee && (Number(payload.platformFee.feeBps) !== 0 || BigInt(payload.platformFee.amount || 0) !== 0n)) || (payload.instructionVersion && payload.instructionVersion !== "V1")) throw new Error();
      const impact = Number(payload.priceImpactPct);
      if (typeof payload.priceImpactPct !== "string" || !Number.isFinite(impact) || impact < 0 || impact > 20) throw new Error();
    } catch { throw new SwapError(503, "The swap quote did not match the requested amounts or safety limits. No swap was prepared."); }
    prune(); if (quotes.size >= MAX_PENDING) throw new SwapError(429, "There are too many pending quotes. Please wait and try again.");
    const stored = { id: randomUUID(), wallet: wallet.toBase58(), inputMint, outputMint, input, output, inUnits, outUnits, minimumUnits, slippageBps, priceImpactPct: payload.priceImpactPct, payload, expiresAt: Date.now() + QUOTE_TTL, preparing: false };
    quotes.set(stored.id, stored);
    return display(stored);
  }
  async function prepare({ quoteId } = {}) {
    requireReady(); prune();
    const stored = quotes.get(quoteId);
    if (!stored) throw new SwapError(410, "This swap quote expired. Get a fresh quote and review it again.");
    if (stored.intentId) { const existing = intents.get(stored.intentId); if (existing) return existing.display; throw new SwapError(410, "This swap request expired. Get a fresh quote."); }
    if (stored.preparing) throw new SwapError(409, "This quote is already being prepared. Please wait.");
    if (intents.size >= MAX_PENDING) throw new SwapError(429, "There are too many pending swaps. Please wait and try again.");
    stored.preparing = true;
    try {
      await verifyNetwork();
      await checkBalance(key(stored.wallet, "Wallet", true), stored.input, stored.inUnits);
      const payload = await provider("/swap", { method: "POST", body: JSON.stringify({ quoteResponse: stored.payload, userPublicKey: stored.wallet, payer: stored.wallet, wrapAndUnwrapSol: true, useSharedAccounts: false, asLegacyTransaction: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: 0 }) });
      let transaction, raw;
      try {
        if (typeof payload.swapTransaction !== "string" || payload.swapTransaction.length > 1700 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.swapTransaction) || !Number.isSafeInteger(payload.lastValidBlockHeight) || payload.lastValidBlockHeight <= 0 || (payload.prioritizationFeeLamports !== undefined && payload.prioritizationFeeLamports !== 0) || payload.simulationError) throw new Error();
        raw = Buffer.from(payload.swapTransaction, "base64");
        if (raw.length > MAX_TRANSACTION_BYTES) throw new Error();
        transaction = Transaction.from(raw);
        validateBuiltTransaction(transaction, stored);
      } catch { throw invalidTransaction(); }
      if (stored.expiresAt <= Date.now()) throw new SwapError(410, "The quote expired while preparing. Get a fresh quote and review it again.");
      prune(); if (intents.size >= MAX_PENDING) throw new SwapError(429, "There are too many pending swaps. Please wait and try again.");
      const intentId = randomUUID();
      const expiresAt = Date.now() + INTENT_TTL;
      const prepared = { ...display(stored), intentId, transaction: raw.toString("base64"), expiresAt, blockhash: transaction.recentBlockhash, lastValidBlockHeight: payload.lastValidBlockHeight };
      intents.set(intentId, { message: transaction.serializeMessage(), latest: { blockhash: transaction.recentBlockhash, lastValidBlockHeight: payload.lastValidBlockHeight }, expiresAt, submitting: false, display: prepared });
      stored.intentId = intentId;
      return prepared;
    } finally { stored.preparing = false; }
  }
  async function submit({ intentId, transaction: encoded } = {}) {
    requireReady(); prune();
    const intent = intents.get(intentId);
    if (!intent) throw new SwapError(410, "This swap request expired. Get a fresh quote before trying again.");
    if (intent.result) return intent.result;
    if (intent.failure) throw intent.failure;
    if (intent.submitting || intent.attempted) throw new SwapError(409, "This swap was already submitted. Check its transaction before starting another swap.", { signature: intent.signature });
    let transaction, raw;
    try {
      if (typeof encoded !== "string" || encoded.length > 1700 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
      raw = Buffer.from(encoded, "base64"); if (raw.length > MAX_TRANSACTION_BYTES) throw new Error();
      transaction = Transaction.from(raw);
      if (!transaction.serializeMessage().equals(intent.message) || !transaction.verifySignatures()) throw new Error();
    } catch { throw new SwapError(400, "The signed transaction does not match the reviewed swap."); }
    intent.submitting = true;
    try {
      await verifyNetwork();
      if (intent.expiresAt <= Date.now()) throw new SwapError(410, "This swap request expired. No swap was submitted.");
      intent.signature = bs58.encode(transaction.signature);
      intent.attempted = true;
      try {
        const signature = await rpc.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
        if (signature !== intent.signature) throw new Error();
        const confirmation = await rpc.confirmTransaction({ signature, ...intent.latest }, "confirmed");
        if (confirmation.value.err) throw new SwapError(422, "The swap failed on Solana. Network fees may still apply.", { signature, confirmationStatus: "failed" });
        intent.result = { status: "confirmed", confirmationStatus: "confirmed", signature, cluster: "mainnet-beta" };
        return intent.result;
      } catch (error) {
        intent.failure = error instanceof SwapError ? error : new SwapError(503, "Swap confirmation is unavailable. Check the transaction before swapping again.", { signature: intent.signature, confirmationStatus: "unknown" });
        throw intent.failure;
      }
    } finally { intent.submitting = false; }
  }
  return { settings, quote, prepare, submit };
}
