import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Connection,
  PublicKey,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getMint,
  unpackAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { formatTokenAmount } from "./tips.js";
import { serverFetch } from "./network.js";

const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};
const TIERS = [
  { id: "breakfast", name: "Breakfast Bloom", maxCad: "2" },
  { id: "helping", name: "Helping Hands / Good Vibes", maxCad: "5" },
  { id: "builder", name: "Community Builder", maxCad: "10" },
];
const RANK = { breakfast: 1, helping: 2, builder: 3 };
const CAPS = { breakfast: 200n, helping: 500n, builder: 1000n };
const U64 = (1n << 64n) - 1n;
const INTENT_TTL = 120_000;
export class DropError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    Object.assign(this, details);
    this.status = status;
  }
}
function walletKey(value) {
  try {
    if (typeof value !== "string" || value.length > 44) throw new Error();
    const key = new PublicKey(value);
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes()))
      throw new Error();
    return key;
  } catch {
    throw new DropError(400, "Use a valid Solana wallet address.");
  }
}
function decimal(value, decimals, name) {
  if (
    typeof value !== "string" ||
    value.length > 60 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)
  )
    throw new DropError(400, `Enter a valid ${name}.`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new DropError(
      400,
      `${name} supports up to ${decimals} decimal places.`,
    );
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units <= 0n)
    throw new DropError(400, `${name} must be greater than zero.`);
  return units;
}
export function rewardBaseUnits(cadAmount, cadPerToken, decimals) {
  const cents = decimal(cadAmount, 2, "CAD reward");
  const price = decimal(cadPerToken, 18, "CAD price per token");
  const amount =
    (cents * 10n ** 18n * 10n ** BigInt(decimals)) / (price * 100n);
  if (amount <= 0n || amount > U64)
    throw new DropError(
      400,
      "The reward amount cannot be represented by this token. Check the price and reward amount.",
    );
  return amount;
}

export function createDropService({
  env = process.env,
  connection,
  now = Date.now,
} = {}) {
  const directory = resolve(env.MEDIA_DATA_DIR || ".data/community");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, "drops.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reward_drops(id TEXT PRIMARY KEY,event_code TEXT UNIQUE NOT NULL,title TEXT NOT NULL,owner TEXT NOT NULL,price TEXT NOT NULL,mint TEXT NOT NULL,cluster TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,intent_id TEXT,kind TEXT NOT NULL DEFAULT 'gathering',decimals INTEGER);
    CREATE TABLE IF NOT EXISTS reward_grants(drop_id TEXT NOT NULL,wallet TEXT NOT NULL,tier TEXT NOT NULL,cad_cents INTEGER NOT NULL,PRIMARY KEY(drop_id,wallet));
    CREATE TABLE IF NOT EXISTS reward_intents(id TEXT PRIMARY KEY,drop_id TEXT NOT NULL,message TEXT NOT NULL,prepared TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,signature TEXT,result TEXT,error TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS reward_one_active_intent ON reward_intents(drop_id) WHERE status <> 'expired';
    UPDATE reward_drops SET status='approved' WHERE status='preparing';`);
  const columns = db
    .prepare("PRAGMA table_info(reward_drops)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("kind"))
    db.exec(
      "ALTER TABLE reward_drops ADD COLUMN kind TEXT NOT NULL DEFAULT 'gathering'",
    );
  if (!columns.includes("decimals"))
    db.exec("ALTER TABLE reward_drops ADD COLUMN decimals INTEGER");
  const cluster = env.SOLANA_CLUSTER || "mainnet-beta";
  let mint,
    rpc = connection,
    hosts = [],
    configurationError = "";
  try {
    if (!GENESIS[cluster]) throw new Error();
    if (env.TOKEN_MINT) {
      mint = new PublicKey(String(env.TOKEN_MINT).trim());
      if (mint.toBase58() !== String(env.TOKEN_MINT).trim()) throw new Error();
    }
    hosts = [
      ...new Set(
        String(env.REWARD_HOST_WALLETS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    for (const host of hosts) walletKey(host);
    const endpoint = env.SOLANA_RPC_URL || clusterApiUrl(cluster);
    if (new URL(endpoint).protocol !== "https:") throw new Error();
    rpc ||= new Connection(endpoint, {
      commitment: "confirmed",
      fetch: serverFetch,
    });
  } catch {
    configurationError =
      "Reward drops have invalid wallet, mint, or network settings. Ask the app owner to check them.";
  }
  const challenges = new Map();
  const working = new Set();
  function config() {
    const ready = Boolean(!configurationError && mint && hosts.length);
    return {
      ready,
      hosts,
      mint: mint?.toBase58() || null,
      cluster,
      tiers: TIERS,
      maxRecipients: 5,
      approvalMode: "host-approved",
      message:
        configurationError ||
        (ready
          ? "Hosts verify participation and approve wallet-funded token drops. Tiers do not stack."
          : "Reward drops need a token mint and approved host wallets before payouts are available."),
    };
  }
  function ready() {
    if (!config().ready) throw new DropError(503, config().message);
  }
  function owner(row, wallet) {
    if (!row) throw new DropError(404, "This reward drop was not found.");
    if (row.owner !== wallet)
      throw new DropError(
        403,
        "Only this gathering's host can manage its reward drop.",
      );
    if (row.mint !== mint?.toBase58() || row.cluster !== cluster)
      throw new DropError(
        409,
        "This drop belongs to different token or network settings.",
      );
  }
  function row(id) {
    return typeof id === "string"
      ? db.prepare("SELECT * FROM reward_drops WHERE id=?").get(id)
      : null;
  }
  function publicDrop(item) {
    const intent = item.intent_id
      ? db
          .prepare(
            "SELECT status,signature,prepared FROM reward_intents WHERE id=?",
          )
          .get(item.intent_id)
      : null;
    const prepared = intent ? JSON.parse(intent.prepared) : null;
    return {
      id: item.id,
      kind: item.kind,
      eventCode: item.event_code,
      title: item.title,
      owner: item.owner,
      cadPerToken: item.price,
      mint: item.mint,
      cluster: item.cluster,
      status: item.status,
      createdAt: new Date(item.created_at).toISOString(),
      intentId: item.intent_id || null,
      signature: intent?.signature || null,
      recipients: db
        .prepare("SELECT * FROM reward_grants WHERE drop_id=? ORDER BY wallet")
        .all(item.id)
        .map((g) => ({
          wallet: g.wallet,
          tier: g.tier,
          cadAmount: formatTokenAmount(BigInt(g.cad_cents), 2),
          ...(item.decimals !== null
            ? {
                tokenBaseUnits: rewardBaseUnits(
                  formatTokenAmount(BigInt(g.cad_cents), 2),
                  item.price,
                  item.decimals,
                ).toString(),
                tokenAmount: formatTokenAmount(
                  rewardBaseUnits(
                    formatTokenAmount(BigInt(g.cad_cents), 2),
                    item.price,
                    item.decimals,
                  ),
                  item.decimals,
                ),
              }
            : {}),
          ...(prepared?.recipients.find((r) => r.wallet === g.wallet) || {}),
        })),
    };
  }
  function list() {
    return {
      drops: db
        .prepare("SELECT * FROM reward_drops ORDER BY created_at DESC LIMIT 50")
        .all()
        .map(publicDrop),
    };
  }
  function normalize(action, payload, wallet) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new DropError(400, "Use a valid reward drop request.");
    if (action === "create") {
      const eventCode = String(payload.eventCode || "")
        .trim()
        .toLowerCase();
      const title =
        typeof payload.title === "string" ? payload.title.trim() : "";
      if (
        !/^[a-z0-9][a-z0-9-]{2,39}$/.test(eventCode) ||
        !title ||
        title.length > 100
      )
        throw new DropError(
          400,
          "Add a gathering code (3–40 letters, numbers or hyphens) and title (up to 100 characters).",
        );
      const price = decimal(payload.cadPerToken, 18, "CAD price per token");
      const kind = payload.kind || "gathering";
      if (!["job", "gathering"].includes(kind))
        throw new DropError(400, "Choose a gathering or approved job drop.");
      return {
        eventCode,
        title,
        kind,
        cadPerToken: formatTokenAmount(price, 18),
      };
    }
    if (
      !["approve", "prepare"].includes(action) ||
      typeof payload.dropId !== "string"
    )
      throw new DropError(400, "Use a valid reward drop action.");
    owner(row(payload.dropId), wallet);
    if (action === "prepare") return { dropId: payload.dropId };
    if (
      !Array.isArray(payload.recipients) ||
      payload.recipients.length < 1 ||
      payload.recipients.length > 5
    )
      throw new DropError(
        400,
        "Approve between one and five recipients per gathering.",
      );
    const seen = new Set();
    const recipients = payload.recipients
      .map((entry) => {
        if (!entry || !CAPS[entry.tier])
          throw new DropError(400, "Choose a valid reward tier.");
        const recipient = walletKey(entry.wallet).toBase58();
        if (recipient === wallet || seen.has(recipient))
          throw new DropError(
            400,
            "Choose unique recipient wallets different from the funding host.",
          );
        seen.add(recipient);
        const cents = decimal(entry.cadAmount, 2, "CAD reward");
        if (cents > CAPS[entry.tier])
          throw new DropError(
            400,
            "This reward exceeds the selected tier's CAD limit.",
          );
        return {
          wallet: recipient,
          tier: entry.tier,
          cadAmount: formatTokenAmount(cents, 2),
        };
      })
      .sort((a, b) => a.wallet.localeCompare(b.wallet));
    return { dropId: payload.dropId, recipients };
  }
  function challenge({ wallet: rawWallet, action, payload } = {}, host) {
    ready();
    const wallet = walletKey(rawWallet).toBase58();
    if (!hosts.includes(wallet))
      throw new DropError(403, "This wallet is not an approved reward host.");
    if (
      typeof host !== "string" ||
      !host ||
      host.length > 255 ||
      /[\r\n]/.test(host)
    )
      throw new DropError(400, "Open the reward drop on this app's address.");
    for (const [id, value] of challenges)
      if (value.expiresAt <= now()) challenges.delete(id);
    if (challenges.size >= 500)
      throw new DropError(
        429,
        "Too many reward approvals are pending. Please wait and try again.",
      );
    const approved = normalize(action, payload, wallet),
      digest = createHash("sha256")
        .update(JSON.stringify(approved))
        .digest("hex");
    const expiresAt = now() + 300_000,
      challengeId = randomUUID();
    const summary =
      action === "create"
        ? `${approved.kind === "job" ? "Approved job" : "Gathering"}: ${approved.title} (${approved.eventCode})\nHost-entered CAD per token: ${approved.cadPerToken}`
        : `${row(approved.dropId).kind === "job" ? "Approved job" : "Gathering"}: ${row(approved.dropId).title} (${row(approved.dropId).event_code})\n${action === "approve" ? approved.recipients.map((r) => `${r.wallet}: ${r.tier}, up to CAD ${r.cadAmount}`).join("\n") : "Prepare the approved recipients for a separate wallet-signed token payment."}`;
    const message = `Juicy Couture Coin reward host approval\nDomain: ${host}\nHost wallet: ${wallet}\nAction: ${action}\n${summary}\nPayload SHA-256: ${digest}\nNonce: ${randomBytes(24).toString("hex")}\nExpires: ${new Date(expiresAt).toISOString()}\nThis message does not transfer tokens. Every payout requires a separate transaction approval in your wallet.`;
    challenges.set(challengeId, {
      wallet,
      action,
      payload: approved,
      host,
      message,
      expiresAt,
    });
    return { challengeId, message, expiresAt };
  }
  function authorized(request, action, host) {
    ready();
    const value = challenges.get(request?.challengeId);
    if (value) challenges.delete(request.challengeId);
    if (
      !value ||
      value.expiresAt <= now() ||
      value.action !== action ||
      value.host !== host
    )
      throw new DropError(
        401,
        "Your host approval expired. Review and sign the action again.",
      );
    if (!hosts.includes(value.wallet))
      throw new DropError(403, "This wallet is not an approved reward host.");
    let verified = false;
    try {
      const signature =
        typeof request.signature === "string" && request.signature.length <= 100
          ? bs58.decode(request.signature)
          : [];
      verified =
        signature.length === 64 &&
        nacl.sign.detached.verify(
          Buffer.from(value.message),
          signature,
          walletKey(value.wallet).toBytes(),
        );
    } catch {}
    if (!verified)
      throw new DropError(
        401,
        "The host wallet signature could not be verified.",
      );
    return value;
  }
  function create(request, host) {
    const auth = authorized(request, "create", host),
      p = auth.payload;
    if (
      db
        .prepare("SELECT id FROM reward_drops WHERE event_code=?")
        .get(p.eventCode)
    )
      throw new DropError(
        409,
        "A reward drop already exists for that gathering code. Manage the existing drop instead.",
      );
    if (
      db.prepare("SELECT COUNT(*) AS count FROM reward_drops").get().count >=
      10000
    )
      throw new DropError(507, "Reward drop storage is full.");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO reward_drops(id,event_code,title,owner,price,mint,cluster,status,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      p.eventCode,
      p.title,
      auth.wallet,
      p.cadPerToken,
      mint.toBase58(),
      cluster,
      "draft",
      now(),
      p.kind,
    );
    return publicDrop(row(id));
  }
  async function approve(request, host) {
    const auth = authorized(request, "approve", host),
      p = auth.payload,
      drop = row(p.dropId);
    owner(drop, auth.wallet);
    if (!["draft", "approved"].includes(drop.status))
      throw new DropError(
        409,
        "This drop is locked for a prepared or completed payout. It cannot be approved again.",
      );
    const token = await verifiedToken();
    const latest = row(drop.id);
    if (!["draft", "approved"].includes(latest.status))
      throw new DropError(409, "This drop is locked for payment.");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!["draft", "approved"].includes(row(drop.id).status))
        throw new DropError(409, "This drop is locked for payment.");
      const current = new Map(
        db
          .prepare("SELECT * FROM reward_grants WHERE drop_id=?")
          .all(drop.id)
          .map((g) => [g.wallet, g]),
      );
      for (const grant of p.recipients) {
        const prior = current.get(grant.wallet),
          cents = Number(decimal(grant.cadAmount, 2, "CAD reward"));
        if (
          !prior ||
          RANK[grant.tier] > RANK[prior.tier] ||
          (grant.tier === prior.tier && cents > prior.cad_cents)
        )
          current.set(grant.wallet, {
            wallet: grant.wallet,
            tier: grant.tier,
            cad_cents: cents,
          });
      }
      if (current.size > 5)
        throw new DropError(
          400,
          "A gathering can include up to five recipient wallets in its token drop.",
        );
      for (const g of current.values())
        rewardBaseUnits(
          formatTokenAmount(BigInt(g.cad_cents), 2),
          drop.price,
          token.decimals,
        );
      const put = db.prepare(
        "INSERT INTO reward_grants(drop_id,wallet,tier,cad_cents) VALUES(?,?,?,?) ON CONFLICT(drop_id,wallet) DO UPDATE SET tier=excluded.tier,cad_cents=excluded.cad_cents",
      );
      for (const g of current.values())
        put.run(drop.id, g.wallet, g.tier, g.cad_cents);
      db.prepare(
        "UPDATE reward_drops SET status='approved',decimals=? WHERE id=?",
      ).run(token.decimals, drop.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return publicDrop(row(drop.id));
  }
  async function verifiedToken() {
    let hash;
    try {
      hash = await rpc.getGenesisHash();
    } catch {
      throw new DropError(
        503,
        "The Solana network could not be verified. No token drop was prepared.",
      );
    }
    if (hash !== GENESIS[cluster])
      throw new DropError(
        503,
        "The Solana RPC does not match the configured reward network.",
      );
    let token;
    try {
      token = await getMint(rpc, mint, "confirmed", TOKEN_PROGRAM_ID);
    } catch {
      throw new DropError(
        503,
        "The reward mint could not be verified as a standard SPL token.",
      );
    }
    if (!token.isInitialized)
      throw new DropError(503, "The reward token mint is not initialized.");
    return token;
  }
  async function prepare(request, host) {
    const auth = authorized(request, "prepare", host);
    let drop = row(auth.payload.dropId);
    owner(drop, auth.wallet);
    if (working.has(drop.id))
      throw new DropError(409, "This token drop is already being prepared.");
    if (drop.status === "prepared") {
      const existing = db
        .prepare("SELECT * FROM reward_intents WHERE id=?")
        .get(drop.intent_id);
      if (
        existing &&
        existing.status === "prepared" &&
        existing.expires_at > now()
      )
        return JSON.parse(existing.prepared);
      if (existing) await status(existing.id);
      drop = row(drop.id);
      if (drop.status !== "approved")
        throw new DropError(
          409,
          "This prepared payment has expired, but its blockhash is not yet verified expired. Wait and check its status before trying again.",
        );
    }
    if (working.has(drop.id))
      throw new DropError(409, "This token drop is already being prepared.");
    if (drop.status !== "approved")
      throw new DropError(
        409,
        "Approve recipients first. Pending, paid, or failed drops cannot be paid again.",
      );
    working.add(drop.id);
    const reserved = db
      .prepare(
        "UPDATE reward_drops SET status='preparing' WHERE id=? AND status='approved'",
      )
      .run(drop.id);
    if (!reserved.changes) {
      working.delete(drop.id);
      throw new DropError(409, "This drop is already locked for payment.");
    }
    let prepared = false;
    try {
      const token = await verifiedToken(),
        recipients = db
          .prepare(
            "SELECT * FROM reward_grants WHERE drop_id=? ORDER BY wallet",
          )
          .all(drop.id)
          .map((g) => ({
            wallet: g.wallet,
            tier: g.tier,
            cadAmount: formatTokenAmount(BigInt(g.cad_cents), 2),
          }));
      if (!recipients.length || recipients.length > 5)
        throw new DropError(
          400,
          "Approve between one and five recipients before preparing a token drop.",
        );
      let total = 0n;
      for (const r of recipients) {
        const amount = rewardBaseUnits(r.cadAmount, drop.price, token.decimals);
        r.tokenBaseUnits = amount.toString();
        r.tokenAmount = formatTokenAmount(amount, token.decimals);
        total += amount;
      }
      if (total > U64)
        throw new DropError(
          400,
          "The total reward drop exceeds this token's transfer limit.",
        );
      const sender = walletKey(auth.wallet),
        source = getAssociatedTokenAddressSync(mint, sender);
      let account;
      try {
        account = unpackAccount(
          source,
          await rpc.getAccountInfo(source, "confirmed"),
          TOKEN_PROGRAM_ID,
        );
        if (
          !account.isInitialized ||
          !account.mint.equals(mint) ||
          !account.owner.equals(sender)
        )
          throw new Error();
      } catch {
        throw new DropError(
          503,
          "The host's reward token account could not be verified.",
        );
      }
      if (account.isFrozen)
        throw new DropError(409, "The host's reward token account is frozen.");
      if (account.amount < total)
        throw new DropError(
          400,
          "The host wallet does not have enough reward tokens for this drop.",
        );
      let latest;
      try {
        latest = await rpc.getLatestBlockhash("confirmed");
      } catch {
        throw new DropError(
          503,
          "The Solana network is unavailable. No payment was prepared.",
        );
      }
      const tx = new Transaction({ feePayer: sender, ...latest });
      for (const recipient of recipients) {
        const wallet = walletKey(recipient.wallet),
          destination = getAssociatedTokenAddressSync(mint, wallet);
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            sender,
            destination,
            wallet,
            mint,
          ),
          createTransferCheckedInstruction(
            source,
            mint,
            destination,
            sender,
            BigInt(recipient.tokenBaseUnits),
            token.decimals,
          ),
        );
      }
      let raw;
      try {
        raw = tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
        if (raw.length > 1232) throw new Error();
      } catch {
        throw new DropError(
          400,
          "This recipient batch is too large for one payment. Use fewer recipients before preparing.",
        );
      }
      const intentId = randomUUID(),
        expiresAt = now() + INTENT_TTL;
      const result = {
        intentId,
        dropId: drop.id,
        transaction: raw.toString("base64"),
        sender: auth.wallet,
        mint: mint.toBase58(),
        cluster,
        decimals: token.decimals,
        recipients,
        totalTokens: formatTokenAmount(total, token.decimals),
        totalBaseUnits: total.toString(),
        cadPerToken: drop.price,
        expiresAt,
        ...latest,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO reward_intents(id,drop_id,message,prepared,expires_at,status) VALUES(?,?,?,?,?,'prepared')",
        ).run(
          intentId,
          drop.id,
          tx.serializeMessage().toString("base64"),
          JSON.stringify(result),
          expiresAt,
        );
        const locked = db
          .prepare(
            "UPDATE reward_drops SET status='prepared',intent_id=? WHERE id=? AND status='preparing'",
          )
          .run(intentId, drop.id);
        if (!locked.changes)
          throw new DropError(
            409,
            "The reward drop changed while preparing. Review it again.",
          );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      prepared = true;
      return result;
    } finally {
      working.delete(drop.id);
      if (!prepared)
        db.prepare(
          "UPDATE reward_drops SET status='approved' WHERE id=? AND status='preparing'",
        ).run(drop.id);
    }
  }
  function receipt(item) {
    if (item.result) return JSON.parse(item.result);
    return {
      intentId: item.id,
      dropId: item.drop_id,
      status:
        item.status === "submitted"
          ? "pending"
          : item.status === "prepared" && item.expires_at <= now()
            ? "expired"
            : item.status,
      signature: item.signature || null,
      cluster: JSON.parse(item.prepared).cluster,
    };
  }
  function finish(item, error) {
    const result = {
      intentId: item.id,
      dropId: item.drop_id,
      status: error ? "failed" : "confirmed",
      signature: item.signature,
      cluster,
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db
        .prepare("SELECT * FROM reward_intents WHERE id=?")
        .get(item.id);
      if (current.status !== "submitted") {
        db.exec("COMMIT");
        return receipt(current);
      }
      db.prepare("UPDATE reward_intents SET status=?,result=? WHERE id=?").run(
        error ? "failed" : "confirmed",
        JSON.stringify(result),
        item.id,
      );
      db.prepare("UPDATE reward_drops SET status=? WHERE id=?").run(
        error ? "failed" : "paid",
        item.drop_id,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return result;
  }
  async function status(intentId) {
    const item =
      typeof intentId === "string"
        ? db.prepare("SELECT * FROM reward_intents WHERE id=?").get(intentId)
        : null;
    if (!item) throw new DropError(404, "This reward payment was not found.");
    if (item.status === "prepared" && item.expires_at <= now()) {
      // Only a request that this server never broadcast can be released. Wait
      // until the original blockhash is finalized-expired before making a new
      // transaction available; a merely expired UI timer is not sufficient.
      try {
        const prepared = JSON.parse(item.prepared);
        if (
          prepared.cluster === cluster &&
          prepared.mint === mint?.toBase58()
        ) {
          await verifiedToken();
          const height = await rpc.getBlockHeight("finalized");
          if (
            Number.isSafeInteger(height) &&
            height > prepared.lastValidBlockHeight
          ) {
            db.exec("BEGIN IMMEDIATE");
            try {
              const update = db
                .prepare(
                  "UPDATE reward_intents SET status='expired' WHERE id=? AND status='prepared' AND signature IS NULL",
                )
                .run(item.id);
              if (update.changes)
                db.prepare(
                  "UPDATE reward_drops SET status='approved',intent_id=NULL WHERE id=? AND intent_id=? AND status='prepared'",
                ).run(item.drop_id, item.id);
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          }
        }
      } catch {}
      return receipt(
        db.prepare("SELECT * FROM reward_intents WHERE id=?").get(item.id),
      );
    }
    if (item.status !== "submitted") return receipt(item);
    try {
      const prepared = JSON.parse(item.prepared);
      if (prepared.cluster !== cluster || prepared.mint !== mint?.toBase58())
        return receipt(item);
      await verifiedToken();
      const response = await rpc.getSignatureStatuses([item.signature], {
          searchTransactionHistory: true,
        }),
        value = response.value[0];
      if (value?.err) return finish(item, value.err);
      if (
        value &&
        (value.confirmationStatus === "confirmed" ||
          value.confirmationStatus === "finalized" ||
          value.confirmations === null)
      )
        return finish(item, null);
    } catch {}
    return receipt(item);
  }
  async function submit({ intentId, transaction: encoded } = {}) {
    ready();
    let item =
      typeof intentId === "string"
        ? db.prepare("SELECT * FROM reward_intents WHERE id=?").get(intentId)
        : null;
    if (!item)
      throw new DropError(
        410,
        "This reward payment request was not found. Prepare the approved drop first.",
      );
    if (item.result) {
      const result = receipt(item);
      if (result.status === "failed")
        throw new DropError(
          422,
          "This reward transaction failed on Solana; it is not marked paid.",
          result,
        );
      return result;
    }
    if (item.status === "expired")
      throw new DropError(
        410,
        "This reward payment expired. Prepare and review a fresh transaction.",
      );
    if (item.status !== "prepared")
      throw new DropError(
        409,
        "This reward payment is already pending. Check its signature before another payout.",
        receipt(item),
      );
    if (item.expires_at <= now())
      throw new DropError(
        410,
        "This reward payment request expired. No payment was submitted.",
      );
    const settings = JSON.parse(item.prepared);
    if (
      settings.cluster !== cluster ||
      settings.mint !== mint?.toBase58() ||
      !hosts.includes(settings.sender)
    )
      throw new DropError(
        409,
        "The reward host, token, or network settings changed. This payment cannot be submitted.",
      );
    let tx, raw;
    try {
      if (
        typeof encoded !== "string" ||
        encoded.length > 1700 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      )
        throw new Error();
      raw = Buffer.from(encoded, "base64");
      if (raw.length > 1232) throw new Error();
      tx = Transaction.from(raw);
      if (
        tx.serializeMessage().toString("base64") !== item.message ||
        !tx.verifySignatures()
      )
        throw new Error();
    } catch {
      throw new DropError(
        400,
        "The signed transaction does not match the reviewed reward drop.",
      );
    }
    const signature = bs58.encode(tx.signature),
      prepared = JSON.parse(item.prepared);
    // Commit the signature before any asynchronous work or broadcast. A restart
    // cannot lose the pending marker and issue the same approved rewards twice.
    const changed = db
      .prepare(
        "UPDATE reward_intents SET status='submitted',signature=? WHERE id=? AND status='prepared'",
      )
      .run(signature, item.id);
    if (!changed.changes)
      throw new DropError(409, "This reward payment is already pending.", {
        signature,
      });
    db.prepare("UPDATE reward_drops SET status='submitted' WHERE id=?").run(
      item.drop_id,
    );
    item = { ...item, status: "submitted", signature };
    try {
      await verifiedToken();
      if (item.expires_at <= now()) throw new Error("expired");
      const returned = await rpc.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 0,
      });
      if (returned !== signature) throw new Error();
      const confirmation = await rpc.confirmTransaction(
        {
          signature,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (confirmation.value.err) {
        const failed = finish(item, confirmation.value.err);
        throw new DropError(
          422,
          "The reward transaction failed on Solana. No reward is marked paid; network fees may apply.",
          failed,
        );
      }
      return finish(item, null);
    } catch (error) {
      if (error instanceof DropError && error.status === 422) throw error;
      throw new DropError(
        503,
        "Reward payment confirmation is unavailable. Check this signature before sending another payout.",
        {
          signature,
          intentId: item.id,
          dropId: item.drop_id,
          status: "pending",
          cluster,
        },
      );
    }
  }
  return {
    config,
    list,
    challenge,
    create,
    approve,
    prepare,
    submit,
    status,
    close: () => db.close(),
  };
}
