import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PublicKey } from "@solana/web3.js";
import sharp from "sharp";
import nacl from "tweetnacl";
import bs58 from "bs58";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_STORAGE_BYTES = 1024 * 1024 * 1024;
const MAX_POSTS = 10_000;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const COOKIE = "jcq_feed_session";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

class FeedError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}

async function body(req, maximum) {
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    req.resume();
    throw new FeedError(413, "The upload is too large. Images must be 5 MB or smaller.");
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    const timeout = setTimeout(() => {
      failed = true;
      chunks.length = 0;
      reject(new FeedError(408, "The image upload timed out. Please try again."));
    }, 20_000);
    timeout.unref?.();
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maximum) {
        failed = true;
        clearTimeout(timeout);
        chunks.length = 0;
        reject(new FeedError(413, "The upload is too large. Images must be 5 MB or smaller."));
      } else chunks.push(chunk);
    });
    req.on("end", () => { clearTimeout(timeout); if (!failed) resolveBody(Buffer.concat(chunks)); });
    req.on("error", (error) => { clearTimeout(timeout); if (!failed) reject(error); });
    req.on("aborted", () => { clearTimeout(timeout); if (!failed) reject(new FeedError(400, "The image upload was interrupted.")); });
  });
}

async function readJson(req) {
  const raw = await body(req, 4096);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch { throw new FeedError(400, "Use a valid feed request."); }
}

function walletAddress(value) {
  try {
    if (typeof value !== "string" || value.length > 44) throw new Error();
    const wallet = new PublicKey(value);
    if (wallet.toBase58() !== value || !PublicKey.isOnCurve(wallet.toBytes())) throw new Error();
    return wallet;
  } catch { throw new FeedError(400, "Connect a valid Solana wallet."); }
}

function sameOrigin(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") throw new FeedError(403, "Open the community feed on this app to post.");
  if (req.headers.origin) {
    let host;
    try { host = new URL(req.headers.origin).host; } catch {}
    if (host !== req.headers.host) throw new FeedError(403, "Open the community feed on this app to post.");
  }
}

export function createFeedService({ env = process.env, now = Date.now } = {}) {
  const directory = resolve(env.MEDIA_DATA_DIR || ".data/community");
  const images = resolve(directory, "images");
  mkdirSync(images, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, "feed.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, caption TEXT NOT NULL, image TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS posts_wallet_time ON posts(wallet, created_at); CREATE TABLE IF NOT EXISTS post_events (wallet TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS events_wallet_time ON post_events(wallet, created_at)");
  const challenges = new Map();
  const sessions = new Map();
  const rates = new Map();
  const pendingAuthors = new Map();
  let reservedBytes = 0;
  let reservedPosts = 0;
  let processingUploads = 0;

  function prune() {
    const time = now();
    for (const [id, item] of challenges) if (item.expires <= time) challenges.delete(id);
    for (const [id, item] of sessions) if (item.expires <= time) sessions.delete(id);
    for (const [id, item] of rates) if (item.expires <= time) rates.delete(id);
    db.prepare("DELETE FROM post_events WHERE created_at <= ?").run(time - 3_600_000);
  }

  function rate(req) {
    const ip = req.socket.remoteAddress || "unknown";
    const previous = rates.get(ip);
    if (previous && previous.count >= 60) throw new FeedError(429, "Too many feed requests. Please wait a minute.");
    if (previous) previous.count++;
    else {
      if (rates.size >= 10_000) throw new FeedError(503, "The community feed is busy. Please try again shortly.");
      rates.set(ip, { count: 1, expires: now() + 60_000 });
    }
  }

  function session(req) {
    const match = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    return match ? sessions.get(match.slice(COOKIE.length + 1)) : null;
  }

  function requireSession(req) {
    const active = session(req);
    if (!active) throw new FeedError(401, "Sign in with your wallet to post or manage images.");
    return active;
  }

  function postingSession(req) {
    const active = requireSession(req);
    const expected = walletAddress(req.headers["x-post-wallet"]).toBase58();
    if (expected !== active.wallet) throw new FeedError(409, "Your signed-in wallet changed. Sign in again with the wallet you want to use.");
    return active;
  }

  function cookie(req, token, expiry = SESSION_TTL / 1000) {
    const secure = req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" || env.NODE_ENV === "production";
    return `${COOKIE}=${token}; Path=/api/feed; HttpOnly; SameSite=Strict; Max-Age=${expiry}${secure ? "; Secure" : ""}`;
  }

  function post(row) {
    return { id: Number(row.id), author: row.wallet, caption: row.caption, imageUrl: `/api/feed/images/${row.image}`, createdAt: new Date(Number(row.created_at)).toISOString() };
  }

  async function routes(req, res, url) {
    prune();
    if (!["GET", "HEAD"].includes(req.method)) { sameOrigin(req); rate(req); }
    if (req.method === "GET" && url.pathname === "/api/feed") {
      const cursor = url.searchParams.get("before");
      if (cursor !== null && (!/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new FeedError(400, "Use a valid feed page.");
      const rows = cursor ? db.prepare("SELECT * FROM posts WHERE id < ? ORDER BY id DESC LIMIT 21").all(Number(cursor)) : db.prepare("SELECT * FROM posts ORDER BY id DESC LIMIT 21").all();
      const selected = rows.slice(0, 20);
      return json(res, 200, { posts: selected.map(post), nextCursor: rows.length > 20 ? Number(selected.at(-1).id) : null });
    }
    if (req.method === "GET" && url.pathname === "/api/feed/session") return json(res, 200, { wallet: session(req)?.wallet || null });
    if (req.method === "POST" && url.pathname === "/api/feed/challenge") {
      const { wallet: rawWallet } = await readJson(req);
      const wallet = walletAddress(rawWallet).toBase58();
      if (challenges.size >= 500) throw new FeedError(429, "Too many pending sign-ins. Please try again in a few minutes.");
      const challengeId = randomUUID();
      const host = req.headers.host;
      if (!host || host.length > 255 || /[\r\n]/.test(host)) throw new FeedError(400, "Use the app's community feed address.");
      const expires = now() + CHALLENGE_TTL;
      const message = `Sign in to Juicy Couture Coin community feed.\nDomain: ${host}\nWallet: ${wallet}\nPurpose: Publish and manage your community image posts.\nNonce: ${randomBytes(24).toString("hex")}\nExpires: ${new Date(expires).toISOString()}\nThis message does not authorize a token transfer.`;
      challenges.set(challengeId, { wallet, host, expires, message });
      return json(res, 200, { challengeId, message });
    }
    if (req.method === "POST" && url.pathname === "/api/feed/session") {
      const { challengeId, signature } = await readJson(req);
      const challenge = challenges.get(challengeId);
      if (challenge) challenges.delete(challengeId);
      if (!challenge || challenge.host !== req.headers.host) throw new FeedError(401, "Your wallet sign-in expired. Please sign in again.");
      let valid = false;
      try {
        const signed = typeof signature === "string" && signature.length <= 100 ? bs58.decode(signature) : new Uint8Array();
        valid = signed.length === 64 && nacl.sign.detached.verify(Buffer.from(challenge.message), signed, walletAddress(challenge.wallet).toBytes());
      } catch {}
      if (!valid) throw new FeedError(401, "The wallet signature could not be verified.");
      if (sessions.size >= 2000) throw new FeedError(503, "The community feed is busy. Please try signing in later.");
      const token = randomBytes(32).toString("hex");
      sessions.set(token, { wallet: challenge.wallet, expires: now() + SESSION_TTL });
      return json(res, 200, { wallet: challenge.wallet }, { "set-cookie": cookie(req, token) });
    }
    if (req.method === "DELETE" && url.pathname === "/api/feed/session") {
      const match = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
      if (match) sessions.delete(match.slice(COOKIE.length + 1));
      return json(res, 200, { wallet: null }, { "set-cookie": cookie(req, "", 0) });
    }
    if (req.method === "POST" && url.pathname === "/api/feed/posts") {
      const active = postingSession(req);
      const type = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
      if (!IMAGE_TYPES.has(type)) { req.resume(); throw new FeedError(415, "Choose a JPEG, PNG, or WebP image. SVG images are not supported."); }
      let caption;
      try { caption = decodeURIComponent(req.headers["x-post-caption"] || "").trim(); }
      catch { throw new FeedError(400, "The image caption is invalid."); }
      if (caption.length > 500) throw new FeedError(400, "Keep image captions to 500 characters or fewer.");
      const pending = pendingAuthors.get(active.wallet) || 0;
      const count = db.prepare("SELECT COUNT(*) AS count FROM post_events WHERE wallet = ? AND created_at > ?").get(active.wallet, now() - 3_600_000).count;
      if (Number(count) + pending >= 10) { req.resume(); throw new FeedError(429, "You can share up to 10 images per hour. Please try again later."); }
      if (processingUploads >= 4) { req.resume(); throw new FeedError(429, "Image uploads are busy. Please try again shortly."); }
      processingUploads++;
      pendingAuthors.set(active.wallet, pending + 1);
      let filename;
      let temporary;
      let reserved = 0;
      try {
        const raw = await body(req, MAX_IMAGE_BYTES);
        let encoded;
        try {
          const image = sharp(raw, { limitInputPixels: 20_000_000, animated: false, failOn: "error" });
          const metadata = await image.metadata();
          if (!["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error();
          encoded = await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
        } catch { throw new FeedError(415, "That image could not be read. Choose a valid JPEG, PNG, or WebP image under 20 megapixels."); }
        const used = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM posts").get();
        if (Number(used.count) + reservedPosts >= MAX_POSTS || Number(used.bytes) + reservedBytes + encoded.length > MAX_STORAGE_BYTES) throw new FeedError(507, "The community image storage is full. Please try again after space is available.");
        reserved = encoded.length;
        reservedBytes += reserved;
        reservedPosts++;
        filename = `${randomUUID()}.webp`;
        temporary = resolve(images, `${filename}.tmp`);
        await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
        await rename(temporary, resolve(images, filename));
        const time = now();
        let result;
        db.exec("BEGIN IMMEDIATE");
        try {
          result = db.prepare("INSERT INTO posts(wallet, caption, image, created_at, bytes) VALUES (?, ?, ?, ?, ?)").run(active.wallet, caption, filename, time, encoded.length);
          db.prepare("INSERT INTO post_events(wallet, created_at) VALUES (?, ?)").run(active.wallet, time);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        const item = { id: Number(result.lastInsertRowid), author: active.wallet, caption, imageUrl: `/api/feed/images/${filename}`, createdAt: new Date(time).toISOString() };
        filename = null;
        return json(res, 201, item);
      } finally {
        processingUploads--;
        if (reserved) { reservedBytes -= reserved; reservedPosts--; }
        const remaining = (pendingAuthors.get(active.wallet) || 1) - 1;
        if (remaining) pendingAuthors.set(active.wallet, remaining); else pendingAuthors.delete(active.wallet);
        if (temporary) await unlink(temporary).catch(() => {});
        if (filename) await unlink(resolve(images, filename)).catch(() => {});
      }
    }
    if (req.method === "DELETE" && /^\/api\/feed\/posts\/[1-9]\d{0,15}$/.test(url.pathname)) {
      const active = postingSession(req);
      const id = Number(url.pathname.split("/").at(-1));
      const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
      if (!row) throw new FeedError(404, "This image post was not found.");
      if (row.wallet !== active.wallet) throw new FeedError(403, "You can only delete your own image posts.");
      db.prepare("DELETE FROM posts WHERE id = ?").run(id);
      await unlink(resolve(images, row.image)).catch(() => {});
      return json(res, 200, { deleted: true });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/feed/images/")) {
      const filename = url.pathname.slice("/api/feed/images/".length);
      if (!IMAGE_FILE.test(filename) || !db.prepare("SELECT id FROM posts WHERE image = ?").get(filename)) throw new FeedError(404, "This image was not found.");
      let data;
      try { data = await readFile(resolve(images, filename)); }
      catch { throw new FeedError(404, "This image was not found."); }
      res.writeHead(200, { "content-type": "image/webp", "content-length": data.length, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin" });
      res.end(data);
      return;
    }
    throw new FeedError(404, "This community feed action was not found.");
  }

  return {
    async handle(req, res, url) {
      if (url.pathname !== "/api/feed" && !url.pathname.startsWith("/api/feed/")) return false;
      try { await routes(req, res, url); }
      catch (error) {
        if (!req.complete) req.resume();
        if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "The community feed is temporarily unavailable. Please try again later." });
        else if (!res.writableEnded) res.end();
      }
      return true;
    },
    close() { db.close(); },
  };
}
