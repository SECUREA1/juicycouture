import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { attachRoomServer } from "./rooms.js";
import { createPayments } from "./payments.js";
import { walletAddress } from "./transactions.js";
import { createTipsService } from "./tips.js";
import { createSwapService } from "./swaps.js";
import { createFeedService } from "./feed.js";
import { createDropService } from "./drops.js";
import { createProgramService } from "./program.js";
import { serverFetch } from "./network.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = resolve("public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const configuredLimit = Number(process.env.MAX_ROOM_PARTICIPANTS || 8);
const maxParticipants = Math.min(12, Math.max(2, Number.isFinite(configuredLimit) ? Math.trunc(configuredLimit) : 8));
const iceServers = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [];
if (!Array.isArray(iceServers)) throw new Error("ICE_SERVERS must be a JSON array of WebRTC ICE servers.");
let marketCache = { expires: 0, value: null };
const cluster = process.env.SOLANA_CLUSTER || "mainnet-beta";
if (!["mainnet-beta", "devnet"].includes(cluster)) throw new Error("SOLANA_CLUSTER must be mainnet-beta or devnet.");
const payments = createPayments({
  cluster, mint: String(process.env.TOKEN_MINT || "").trim(),
  rpcUrl: process.env.SOLANA_RPC_URL || (cluster === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com"),
});
const rpcRates = new Map();

const swaps = createSwapService();
let program;
try {
  program = createProgramService();
} catch {
  console.error("Contribution recognition storage could not be opened. Check MEDIA_DATA_DIR and disk permissions.");
}
let drops;
try {
  drops = createDropService();
} catch {
  console.error("Reward storage could not be opened. Check MEDIA_DATA_DIR and disk permissions.");
}
let feed;
try {
  feed = createFeedService();
} catch {
  console.error("Community storage could not be opened. Check MEDIA_DATA_DIR and disk permissions.");
}
let roomServer;
const rateBuckets = new Map();
const tips = createTipsService({ videoReady: true, listParticipants: async (name) => roomServer?.listParticipants(name) || [] });

async function handleTipsRequest(req, res, operation) {
  try {
    return sendJson(res, 200, await operation());
  } catch (error) {
    return sendJson(res, error.status || 503, {
      error: error.status ? error.message : "Token payments are temporarily unavailable. Please try again later.",
      ...(error.signature ? { signature: error.signature } : {}),
      ...(error.intentId ? { intentId: error.intentId } : {}),
      ...(error.confirmationStatus ? { confirmationStatus: error.confirmationStatus } : {}),
    });
  }
}


function readJson(req, maxBytes = 4096) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cleanRoom(value) {
  const room = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(room)) return null;
  return room;
}

function allowTokenRequest(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = String(forwarded || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  if (rateBuckets.size >= 10_000) {
    for (const [address, bucket] of rateBuckets) if (now - bucket.started > 60_000) rateBuckets.delete(address);
    if (!rateBuckets.has(ip) && rateBuckets.size >= 10_000) return false;
  }
  const prior = rateBuckets.get(ip);
  if (!prior || now - prior.started > 60_000) {
    rateBuckets.set(ip, { started: now, count: 1 });
    return true;
  }
  prior.count += 1;
  return prior.count <= 60;
}


function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  res.end(body);
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(self), microphone=(self), geolocation=()",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  };
}

async function marketData() {
  const mint = String(process.env.TOKEN_MINT || "").trim();
  if (!mint) return { status: "pending", message: "The official Solana mint address has not been published yet." };
  if (marketCache.expires > Date.now() && marketCache.value) return marketCache.value;

  try {
    const response = await serverFetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`Market data returned ${response.status}`);
    const payload = await response.json();
    const pair = (payload.pairs || []).find((candidate) => candidate.chainId === "solana");
    if (!pair) return { status: "pending", message: "No Solana market data is available for this mint yet." };
    const pairUrl = String(pair.url || "");
    const value = {
      status: "live",
      mint,
      priceUsd: pair.priceUsd || null,
      fdv: Number.isFinite(Number(pair.fdv)) ? Number(pair.fdv) : null,
      liquidityUsd: Number.isFinite(Number(pair.liquidity?.usd)) ? Number(pair.liquidity.usd) : null,
      volume24h: Number.isFinite(Number(pair.volume?.h24)) ? Number(pair.volume.h24) : null,
      change24h: Number.isFinite(Number(pair.priceChange?.h24)) ? Number(pair.priceChange.h24) : null,
      marketUrl: pairUrl.startsWith("https://dexscreener.com/solana/") ? pairUrl : null,
      updatedAt: new Date().toISOString(),
    };
    marketCache = { expires: Date.now() + 30_000, value };
    return value;
  } catch {
    return { status: "unavailable", message: "Market data is temporarily unavailable. Try again shortly." };
  }
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/program" || url.pathname.startsWith("/api/program/")) {
    if (!program) return sendJson(res, 503, { error: "Contribution recognition is temporarily unavailable." });
    if (await program.handle(req, res, url)) return;
  }
  if (url.pathname === "/api/feed" || url.pathname.startsWith("/api/feed/")) {
    if (req.method !== "GET" && !allowTokenRequest(req)) return sendJson(res, 429, { error: "Too many feed requests. Please wait a minute and try again." });
    if (!feed) return sendJson(res, 503, { error: "Community storage is unavailable. Please try again later." });
    if (await feed.handle(req, res, url)) return;
  }
  if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true });

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, {
      coinName: process.env.COIN_NAME || "Juicy Couture Coin",
      coinSymbol: (process.env.COIN_SYMBOL || "JCQ").replace(/^\$/, ""),
      network: process.env.COIN_NETWORK || "Solana",
      mint: String(process.env.TOKEN_MINT || "").trim() || null,
      communityUrl: process.env.COMMUNITY_URL || null,
      videoReady: true,
      videoMode: "peer-to-peer",
      signalingPath: "/api/room",
      iceServers,
      maxParticipants,
      payments: payments.config,
      defaultRoom: cleanRoom(process.env.DEFAULT_LIVE_ROOM) || "juicy-live",
      tips: tips.settings(), swaps: swaps.settings(), feedReady: Boolean(feed),
      drops: drops?.config() || { ready: false, message: "Reward storage is unavailable." },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/market") {
    return sendJson(res, 200, await marketData());
  }

  if (req.method === "POST" && url.pathname === "/api/solana") {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    for (const [key, value] of rpcRates) if (now - value.started > 60_000) rpcRates.delete(key);
    const rate = rpcRates.get(ip) || { started: now, count: 0 };
    rpcRates.set(ip, rate);
    if (++rate.count > 180) return sendJson(res, 429, { error: "Please wait before making more wallet requests." });
    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 32_768) return sendJson(res, 413, { error: "Wallet request too large." });
      }
      const body = JSON.parse(raw);
      const result = await payments.proxy(body);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 400, { error: error.message || "Wallet request failed. Please try again." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/swaps/config") return sendJson(res, 200, swaps.settings());
  if (req.method === "GET" && (url.pathname === "/api/drops" || url.pathname === "/api/drops/config" || url.pathname.startsWith("/api/drops/status/"))) {
    if (!drops) return sendJson(res, 503, { error: "Reward storage is unavailable. Please try again later." });
    return handleTipsRequest(req, res, () => url.pathname === "/api/drops" ? drops.list() : url.pathname === "/api/drops/config" ? drops.config() : drops.status(url.pathname.slice("/api/drops/status/".length)));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/wallet/")) {
    if (!allowTokenRequest(req)) return sendJson(res, 429, { error: "Too many wallet requests. Please wait a minute and refresh." });
    return handleTipsRequest(req, res, () => tips.getWallet(url.pathname.slice("/api/wallet/".length)));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/streams/")) {
    return handleTipsRequest(req, res, () => tips.getStream(url.pathname.slice("/api/streams/".length)));
  }

  if (req.method === "POST" && ["/api/tips/prepare", "/api/tips/submit", "/api/swaps/quote", "/api/swaps/prepare", "/api/swaps/submit", "/api/drops/challenge", "/api/drops/create", "/api/drops/approve", "/api/drops/prepare", "/api/drops/submit"].includes(url.pathname)) {
    // Wallet signing never needs a cross-origin request to this application.
    const origin = req.headers.origin;
    if (origin) {
      let originHost;
      try { originHost = new URL(origin).host; } catch {}
      if (originHost !== req.headers.host) return sendJson(res, 403, { error: "Open the payment form on this app to send tokens." });
    }
    if (!allowTokenRequest(req)) return sendJson(res, 429, { error: "Too many payment requests. Please wait a minute and try again." });
    return handleTipsRequest(req, res, async () => {
      let body;
      try {
        body = await readJson(req, 12_000);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      } catch {
        throw Object.assign(new Error("Invalid payment request."), { status: 400 });
      }
      if (url.pathname === "/api/swaps/quote") return swaps.quote(body);
      if (url.pathname === "/api/swaps/prepare") return swaps.prepare(body);
      if (url.pathname === "/api/swaps/submit") return swaps.submit(body);
      if (url.pathname.startsWith("/api/drops/")) {
        if (!drops) throw Object.assign(new Error("Reward storage is unavailable."), { status: 503 });
        return drops[url.pathname.slice("/api/drops/".length)](body, req.headers.host);
      }
      return url.pathname.endsWith("/prepare") ? tips.prepare(body) : tips.submit(body);
    });
  }


  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });

  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== resolve(PUBLIC_DIR, "index.html")) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "content-length": data.length,
      "cache-control": "no-cache",
      ...securityHeaders(),
    });
    return res.end(data);
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("Request failed:", error?.message || "unknown error");
    if (!res.headersSent) sendJson(res, 500, { error: "Unexpected server error" });
    else res.end();
  });
});

roomServer = attachRoomServer(server, { maxParticipants, validateWallet: walletAddress, verifyTip: payments.verifyTip });
server.listen(PORT, "0.0.0.0", () => console.log(`Juicy Couture Coin live app listening on ${server.address().port}`));
