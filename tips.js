import { randomUUID } from "node:crypto";
import { Connection, PublicKey, Transaction, clusterApiUrl } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import bs58 from "bs58";

const INTENT_TTL_MS = 120_000;
const MAX_INTENTS = 500;
const MAX_TRANSACTION_BYTES = 1232;
const U64_MAX = (1n << 64n) - 1n;
// Full genesis hashes from anza-xyz/solana-sdk cluster-type/src/lib.rs.
const GENESIS_HASHES = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

export class TipError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}

export function parseTokenAmount(amount, decimals) {
  if (typeof amount !== "string" || amount.length > 80 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(amount)) {
    throw new TipError(400, "Enter a token amount using digits and a decimal point.");
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) throw new TipError(400, `This token allows at most ${decimals} decimal places.`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units <= 0n || units > U64_MAX) throw new TipError(400, "The token amount must be positive and within the token transfer limit.");
  return units;
}

function roomName(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(value)) {
    throw new TipError(400, "Use a valid room code.");
  }
  return value;
}

function walletAddress(value, label) {
  try {
    if (typeof value !== "string") throw new Error();
    const key = new PublicKey(value);
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw new Error();
    return key;
  } catch {
    throw new TipError(400, `${label} must be a valid Solana wallet address.`);
  }
}

export function createTipsService({ env = process.env, listParticipants, connection } = {}) {
  const cluster = env.SOLANA_CLUSTER || "mainnet-beta";
  const mintText = String(env.TOKEN_MINT || "").trim();
  const recipientText = String(env.STREAM_WALLET_ADDRESS || "").trim();
  const symbol = String(env.COIN_SYMBOL || "JCQ").replace(/^\$/, "");
  const videoReady = Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
  let mint;
  let recipient;
  let rpc = connection;
  let configurationError = "";
  try {
    if (!["mainnet-beta", "devnet"].includes(cluster)) throw new Error("cluster");
    if (mintText) mint = new PublicKey(mintText);
    if (recipientText) recipient = walletAddress(recipientText, "Receiving wallet");
    const endpoint = env.SOLANA_RPC_URL || clusterApiUrl(cluster);
    if (new URL(endpoint).protocol !== "https:") throw new Error("RPC must use HTTPS");
    rpc ||= new Connection(endpoint, "confirmed");
  } catch {
    configurationError = "Token payments have invalid Solana settings. Ask the app owner to check them.";
  }
  const intents = new Map();

  function settings() {
    const ready = Boolean(!configurationError && mint && recipient && videoReady && typeof listParticipants === "function");
    return {
      ready,
      mint: mint?.toBase58() || null,
      recipient: recipient?.toBase58() || null,
      cluster,
      symbol,
      message: configurationError || (ready ? "Token tips go directly to the configured streaming wallet." : "Token payments need a token mint, receiving wallet, and LiveKit setup."),
    };
  }

  async function getStream(rawRoom) {
    const room = roomName(rawRoom);
    const config = settings();
    if (!config.ready) return { ...config, room, active: false };
    let participants;
    try {
      participants = await listParticipants(room);
    } catch {
      throw new TipError(503, "Could not verify that the stream is live. Please try again later.");
    }
    // LiveKit's VIDEO enum is 1. Presence in a room alone does not make it live.
    const active = participants.some((participant) => participant.state === 2 && participant.tracks?.some((track) => track.type === 1 && track.muted === false));
    return { ...config, room, active, message: active ? config.message : "Token tips are available while a camera or screen stream is live." };
  }

  function prune() {
    const now = Date.now();
    for (const [id, intent] of intents) {
      if (intent.expiresAt <= now && !intent.submitting) intents.delete(id);
    }
  }

  async function requireActive(room) {
    const stream = await getStream(room);
    if (!stream.ready) throw new TipError(503, stream.message);
    if (!stream.active) throw new TipError(409, "This stream is offline. No payment was submitted.");
    return stream;
  }

  async function prepare({ room: rawRoom, sender: rawSender, amount } = {}) {
    const room = roomName(rawRoom);
    const sender = walletAddress(rawSender, "Sending wallet");
    await requireActive(room);
    if (sender.equals(recipient)) throw new TipError(400, "Connect a wallet different from the receiving wallet.");
    prune();
    if (intents.size >= MAX_INTENTS) throw new TipError(429, "There are too many pending payments. Please wait and try again.");
    let genesisHash;
    try {
      genesisHash = await rpc.getGenesisHash();
    } catch {
      throw new TipError(503, "Could not verify the Solana network. No payment was prepared.");
    }
    if (genesisHash !== GENESIS_HASHES[cluster]) {
      throw new TipError(503, "The Solana RPC does not match the configured network. No payment was prepared.");
    }
    let token;
    try {
      // getMint verifies the program owner and account layout. Token-2022 is not accepted.
      token = await getMint(rpc, mint, "confirmed", TOKEN_PROGRAM_ID);
    } catch {
      throw new TipError(503, "Could not verify the configured SPL token mint. Ask the app owner to check its address and network.");
    }
    if (!token.isInitialized) throw new TipError(503, "The configured token mint is not initialized.");
    const units = parseTokenAmount(amount, token.decimals);
    let latest;
    try {
      latest = await rpc.getLatestBlockhash("confirmed");
    } catch {
      throw new TipError(503, "The Solana network is unavailable. No payment was prepared.");
    }
    const source = getAssociatedTokenAddressSync(mint, sender);
    const destination = getAssociatedTokenAddressSync(mint, recipient);
    const transaction = new Transaction({ feePayer: sender, ...latest }).add(
      createAssociatedTokenAccountIdempotentInstruction(sender, destination, recipient, mint),
      createTransferCheckedInstruction(source, mint, destination, sender, units, token.decimals),
    );
    const message = transaction.serializeMessage();
    prune();
    // Another preparation may have completed while RPC calls were in progress.
    if (intents.size >= MAX_INTENTS) throw new TipError(429, "There are too many pending payments. Please wait and try again.");
    const intentId = randomUUID();
    intents.set(intentId, { room, message, latest, expiresAt: Date.now() + INTENT_TTL_MS, submitting: false });
    return {
      intentId,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      sender: sender.toBase58(),
      recipient: recipient.toBase58(),
      mint: mint.toBase58(),
      cluster,
      symbol,
      amount,
      decimals: token.decimals,
      expiresAt: intents.get(intentId).expiresAt,
      ...latest,
    };
  }

  async function submit({ intentId, transaction: encoded } = {}) {
    prune();
    const intent = intents.get(intentId);
    if (!intent) throw new TipError(410, "This payment request expired. Review the amount and prepare it again.");
    if (intent.result) return intent.result;
    if (intent.failure) throw intent.failure;
    if (intent.submitting || intent.attempted) {
      throw new TipError(409, "This payment has already been submitted. Check its transaction before starting another payment.", { signature: intent.signature, confirmationStatus: "unknown" });
    }
    let transaction;
    let raw;
    try {
      if (typeof encoded !== "string" || encoded.length > 1700 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
      raw = Buffer.from(encoded, "base64");
      if (raw.length > MAX_TRANSACTION_BYTES) throw new Error();
      transaction = Transaction.from(raw);
      if (!transaction.serializeMessage().equals(intent.message) || !transaction.verifySignatures()) throw new Error();
    } catch {
      throw new TipError(400, "The signed transaction does not match the reviewed payment request.");
    }
    // Lock before the network checks so two requests cannot broadcast independently.
    intent.submitting = true;
    try {
      await requireActive(intent.room);
      if (intent.expiresAt <= Date.now()) throw new TipError(410, "This payment request expired. No payment was submitted.");
      intent.signature = bs58.encode(transaction.signature);
      intent.attempted = true;
      try {
        const signature = await rpc.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
        if (signature !== intent.signature) throw new Error("Unexpected transaction signature");
        const confirmation = await rpc.confirmTransaction({ signature, ...intent.latest }, "confirmed");
        if (confirmation.value.err) {
          throw new TipError(422, "The transaction failed on Solana. No token transfer completed; network fees may still apply.", { signature, confirmationStatus: "failed" });
        }
        intent.result = { signature, status: "confirmed", confirmationStatus: "confirmed", cluster };
        return intent.result;
      } catch (error) {
        intent.failure = error instanceof TipError ? error : new TipError(503, "Payment confirmation is unavailable. Check the transaction before sending again.", { signature: intent.signature, confirmationStatus: "unknown" });
        throw intent.failure;
      }
    } finally {
      intent.submitting = false;
    }
  }

  return { settings, getStream, prepare, submit };
}
