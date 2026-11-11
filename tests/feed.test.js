import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import sharp from "sharp";
import { createFeedService } from "../feed.js";

test("permanent image feed verifies wallet authors and persists sanitized image posts", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "jcq-feed-"));
  let currentTime = Date.now();
  let service = createFeedService({ env: { MEDIA_DATA_DIR: path }, now: () => currentTime });
  const server = http.createServer(async (req, res) => {
    if (!await service.handle(req, res, new URL(req.url, `http://${req.headers.host}`))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.close();
    await rm(path, { recursive: true, force: true });
  });
  const request = (url, options) => fetch(base + url, { ...options, signal: AbortSignal.timeout(5000) });
  const json = (data, extra = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra.headers }, body: JSON.stringify(data), ...extra });
  const author = Keypair.generate();
  const other = Keypair.generate();
  let cookie;
  let secondCookie;
  let post;
  const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#a20f4e" } }).jpeg().toBuffer();
  async function login(pair) {
    const response = await request("/api/feed/challenge", json({ wallet: pair.publicKey.toBase58() }));
    assert.equal(response.status, 200);
    const challenge = await response.json();
    const signature = bs58.encode(nacl.sign.detached(Buffer.from(challenge.message), pair.secretKey));
    const signed = await request("/api/feed/session", json({ challengeId: challenge.challengeId, signature }));
    assert.equal(signed.status, 200);
    assert.match(signed.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    return { cookie: signed.headers.get("set-cookie").split(";")[0], challenge, signature };
  }
  function upload(headers = {}, raw = image) {
    return request("/api/feed/posts", { method: "POST", headers: { "content-type": "image/jpeg", "x-post-wallet": author.publicKey.toBase58(), "x-post-caption": encodeURIComponent('<script>alert("xss")</script> Community breakfast ♡'), ...headers }, body: raw });
  }

  await t.test("public feed starts empty; uploading without a wallet session is rejected", async () => {
    const response = await request("/api/feed");
    assert.deepEqual(await response.json(), { posts: [], nextCursor: null });
    assert.equal((await upload()).status, 401);
  });
  await t.test("wallet proof uses one-use domain-bound nonce and rejects spoofed signatures", async () => {
    const raw = await request("/api/feed/challenge", json({ wallet: author.publicKey.toBase58() }));
    const challenge = await raw.json();
    assert.match(challenge.message, /Domain: 127\.0\.0\.1:/);
    assert.match(challenge.message, /does not authorize a token transfer/);
    const forged = bs58.encode(nacl.sign.detached(Buffer.from(challenge.message), other.secretKey));
    assert.equal((await request("/api/feed/session", json({ challengeId: challenge.challengeId, signature: forged }))).status, 401);
    const signed = await login(author);
    cookie = signed.cookie;
    assert.equal((await request("/api/feed/session", json({ challengeId: signed.challenge.challengeId, signature: signed.signature }))).status, 401);
    const session = await request("/api/feed/session", { headers: { cookie } });
    assert.deepEqual(await session.json(), { wallet: author.publicKey.toBase58() });
  });
  await t.test("posting wallet must match the session even when another tab changes its cookie", async () => {
    assert.equal((await upload({ cookie, "x-post-wallet": other.publicKey.toBase58() })).status, 409);
    assert.equal((await upload({ cookie, "x-post-wallet": "invalid" })).status, 400);
  });
  await t.test("cross-origin mutations and SVG uploads are rejected", async () => {
    assert.equal((await upload({ cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await upload({ cookie, "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await upload({ cookie, "content-type": "image/svg+xml" }, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415);
    assert.equal((await upload({ cookie }, Buffer.from("not a JPEG"))).status, 415);
  });
  await t.test("oversized uploads and captions are rejected", async () => {
    assert.equal((await upload({ cookie }, Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await upload({ cookie, "x-post-caption": encodeURIComponent("x".repeat(501)) })).status, 400);
  });
  await t.test("uploaded image is re-encoded and author identity comes from the signed session", async () => {
    const response = await upload({ cookie });
    assert.equal(response.status, 201);
    post = await response.json();
    assert.equal(post.author, author.publicKey.toBase58());
    assert.match(post.caption, /^<script>/);
    assert.match(post.imageUrl, /^\/api\/feed\/images\/[0-9a-f-]+\.webp$/);
    const publicImage = await request(post.imageUrl);
    assert.equal(publicImage.status, 200);
    assert.equal(publicImage.headers.get("content-type"), "image/webp");
    assert.equal(publicImage.headers.get("x-content-type-options"), "nosniff");
    const metadata = await sharp(Buffer.from(await publicImage.arrayBuffer())).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.exif, undefined);
  });
  await t.test("feed survives reopening its database and old sessions must sign in again", async () => {
    service.close();
    service = createFeedService({ env: { MEDIA_DATA_DIR: path }, now: () => currentTime });
    const response = await request("/api/feed");
    assert.deepEqual((await response.json()).posts, [post]);
    assert.equal((await request(post.imageUrl)).status, 200);
    assert.equal((await upload({ cookie })).status, 401);
    cookie = (await login(author)).cookie;
  });
  await t.test("only the signed author can delete an image post", async () => {
    secondCookie = (await login(other)).cookie;
    assert.equal((await request(`/api/feed/posts/${post.id}`, { method: "DELETE", headers: { cookie: secondCookie, "x-post-wallet": other.publicKey.toBase58() } })).status, 403);
    assert.equal((await request(`/api/feed/posts/${post.id}`, { method: "DELETE", headers: { cookie, "x-post-wallet": author.publicKey.toBase58() } })).status, 200);
    assert.equal((await request(post.imageUrl)).status, 404);
    assert.deepEqual((await (await request("/api/feed")).json()).posts, []);
  });
  await t.test("deleting posts cannot bypass the ten uploads per hour limit", async () => {
    for (let index = 0; index < 9; index++) {
      const response = await upload({ cookie });
      assert.equal(response.status, 201);
      const row = await response.json();
      assert.equal((await request(`/api/feed/posts/${row.id}`, { method: "DELETE", headers: { cookie, "x-post-wallet": author.publicKey.toBase58() } })).status, 200);
    }
    assert.equal((await upload({ cookie })).status, 429);
  });
  await t.test("expired challenges and sessions cannot authorize a post", async () => {
    const response = await request("/api/feed/challenge", json({ wallet: author.publicKey.toBase58() }));
    const challenge = await response.json();
    currentTime += 6 * 60 * 1000;
    const signature = bs58.encode(nacl.sign.detached(Buffer.from(challenge.message), author.secretKey));
    assert.equal((await request("/api/feed/session", json({ challengeId: challenge.challengeId, signature }))).status, 401);
    currentTime += 24 * 60 * 60 * 1000;
    assert.equal((await upload({ cookie })).status, 401);
  });
});
