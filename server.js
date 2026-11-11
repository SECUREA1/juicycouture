import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { attachRoomServer } from "./rooms.js";
import { createPayments } from "./payments.js";
import { walletAddress } from "./transactions.js";

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
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  };
}

async function marketData() {
  const mint = String(process.env.TOKEN_MINT || "").trim();
  if (!mint) return { status: "pending", message: "The official Solana mint address has not been published yet." };
  if (marketCache.expires > Date.now() && marketCache.value) return marketCache.value;

  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
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

attachRoomServer(server, { maxParticipants, validateWallet: walletAddress, verifyTip: payments.verifyTip });
server.listen(PORT, "0.0.0.0", () => console.log(`Juicy Couture Coin live app listening on ${server.address().port}`));
