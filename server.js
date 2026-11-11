import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { createTipsService } from "./tips.js";

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
const rateBuckets = new Map();
let marketCache = { expires: 0, value: null };
const tips = createTipsService({
  listParticipants: async (roomName) => {
    if (!livekitConfigured()) throw new Error("Live video is not configured.");
    const service = new RoomServiceClient(
      livekitHttpUrl(process.env.LIVEKIT_URL),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );
    return service.listParticipants(roomName);
  },
});

async function handleTipsRequest(req, res, operation) {
  try {
    return sendJson(res, 200, await operation());
  } catch (error) {
    return sendJson(res, error.status || 503, {
      error: error.status ? error.message : "Token payments are temporarily unavailable. Please try again later.",
      ...(error.signature ? { signature: error.signature } : {}),
    });
  }
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
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  };
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
  const prior = rateBuckets.get(ip);
  if (!prior || now - prior.started > 60_000) {
    rateBuckets.set(ip, { started: now, count: 1 });
    return true;
  }
  prior.count += 1;
  return prior.count <= 20;
}

function livekitConfigured() {
  return Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

function livekitHttpUrl(raw) {
  return String(raw).replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

async function ensureRoom(roomName) {
  const service = new RoomServiceClient(
    livekitHttpUrl(process.env.LIVEKIT_URL),
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  let rooms = await service.listRooms([roomName]);
  if (rooms.some((room) => room.name === roomName)) return;
  const configuredLimit = Number(process.env.MAX_ROOM_PARTICIPANTS || 8);
  const maxParticipants = Math.min(12, Math.max(2, Number.isFinite(configuredLimit) ? configuredLimit : 8));
  try {
    await service.createRoom({ name: roomName, maxParticipants, emptyTimeout: 600 });
  } catch (error) {
    rooms = await service.listRooms([roomName]).catch(() => []);
    if (!rooms.some((room) => room.name === roomName)) throw error;
  }
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
      videoReady: livekitConfigured(),
      tips: tips.settings(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/market") {
    return sendJson(res, 200, await marketData());
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/streams/")) {
    return handleTipsRequest(req, res, () => tips.getStream(url.pathname.slice("/api/streams/".length)));
  }

  if (req.method === "POST" && ["/api/tips/prepare", "/api/tips/submit"].includes(url.pathname)) {
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
      return url.pathname.endsWith("/prepare") ? tips.prepare(body) : tips.submit(body);
    });
  }

  if (req.method === "POST" && url.pathname === "/api/room-token") {
    if (!allowTokenRequest(req)) return sendJson(res, 429, { error: "Too many room requests. Please wait a minute and try again." });
    if (!livekitConfigured()) return sendJson(res, 503, { error: "Live video is not configured yet. Add LiveKit Cloud credentials in Render settings." });
    try {
      const body = await readJson(req);
      const room = cleanRoom(body.room);
      const name = String(body.name || "").trim().replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 28);
      if (!room) return sendJson(res, 400, { error: "Use a room code with 3–40 letters, numbers, or hyphens." });
      if (!name) return sendJson(res, 400, { error: "Add a display name before joining." });
      await ensureRoom(room);
      const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity: randomUUID(),
        name,
        ttl: "15m",
      });
      token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
      return sendJson(res, 200, { token: await token.toJwt(), livekitUrl: process.env.LIVEKIT_URL, room, name });
    } catch (error) {
      console.error("Room token request failed:", error?.message || "unknown error");
      return sendJson(res, 502, { error: "The video room could not be opened. Check the LiveKit settings and try again." });
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
      "cache-control": filePath.endsWith("app.js") ? "public, max-age=300" : "no-cache",
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

server.listen(PORT, "0.0.0.0", () => console.log(`Juicy Couture Coin live app listening on ${PORT}`));
