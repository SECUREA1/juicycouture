import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

// Run `npm run build` first: these checks exercise the actual generated assets.
test("HTTP app serves its build and rejects unavailable token payments", async (t) => {
  const mediaDirectory = await mkdtemp(join(tmpdir(), "jcq-http-feed-"));
  t.after(() => rm(mediaDirectory, { recursive: true, force: true }));
  const port = await freePort();
  const server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      TOKEN_MINT: "",
      STREAM_WALLET_ADDRESS: "",
      LIVEKIT_URL: "",
      LIVEKIT_API_KEY: "",
      LIVEKIT_API_SECRET: "",
      SOLANA_CLUSTER: "devnet",
      SOLANA_RPC_URL: "",
      JUPITER_API_KEY: "",
      MEDIA_DATA_DIR: mediaDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const closed = once(server, "close");
    server.kill("SIGTERM");
    await closed;
  });

  let output = "";
  server.stderr.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    function finish(error) {
      clearTimeout(timeout);
      server.off("error", onError);
      server.off("exit", onExit);
      error ? reject(error) : resolve();
    }
    function onError(error) { finish(error); }
    function onExit(code) { finish(new Error(`Server exited with ${code}: ${output}`)); }
    server.once("error", onError);
    server.once("exit", onExit);
    server.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4000);
      if (output.includes(`listening on ${port}`)) finish();
    });
  });
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    signal: AbortSignal.timeout(5000),
  });

  await t.test("health endpoint responds successfully", async () => {
    const response = await request("/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  for (const [path, type] of [["/", "text/html"], ["/styles.css", "text/css"], ["/app.js", "text/javascript"]]) {
    await t.test(`generated ${path} is served with its content type`, async () => {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").startsWith(type));
      assert.ok((await response.text()).length > 100);
    });
  }

  await t.test("config reports token payments as unconfigured", async () => {
    const response = await request("/api/config");
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.equal(config.videoReady, false);
    assert.equal(config.tips.ready, false);
    assert.equal(config.tips.recipient, null);
    assert.equal(config.swaps.ready, false);
    assert.equal(config.feedReady, true);
  });

  await t.test("public feed is available and signed-wallet login is required to post", async () => {
    const response = await request("/api/feed");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).posts, []);
    const upload = await request("/api/feed/posts", { method: "POST", headers: { "content-type": "image/png" }, body: "not-an-image" });
    assert.equal(upload.status, 401);
  });

  await t.test("unconfigured swaps fail closed and never expose API credentials", async () => {
    const response = await request("/api/swaps/config");
    assert.equal(response.status, 200);
    const settings = await response.json();
    assert.equal(settings.ready, false);
    assert.equal(settings.apiKey, undefined);
    const quote = await request("/api/swaps/quote", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(quote.status, 503);
  });

  await t.test("unconfigured streams stay inactive", async () => {
    const response = await request("/api/streams/test-stream");
    assert.equal(response.status, 200);
    const stream = await response.json();
    assert.equal(stream.ready, false);
    assert.equal(stream.active, false);
    assert.equal(stream.room, "test-stream");
  });

  await t.test("invalid room names are rejected", async () => {
    const response = await request("/api/streams/!");
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /room code/i);
  });

  await t.test("wallet balances require a configured mint and are never cached", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const response = await request(`/api/wallet/${wallet}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.equal(result.tokenBalance, undefined);
  });

  await t.test("invalid wallet addresses are rejected", async () => {
    const response = await request("/api/wallet/not-a-wallet");
    assert.equal(response.status, 400);
  });

  await t.test("malformed payment JSON is rejected", async () => {
    const response = await request("/api/tips/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /invalid payment request/i);
  });

  await t.test("unconfigured payments cannot be prepared for a valid sender", async () => {
    const response = await request("/api/tips/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: "test-stream", sender: Keypair.generate().publicKey.toBase58(), amount: "1" }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /token mint, receiving wallet, and LiveKit/i);
  });

  await t.test("cross-origin payment requests are forbidden", async () => {
    for (const path of ["/api/tips/prepare", "/api/tips/submit"]) {
      const response = await request(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.invalid" },
        body: "{}",
      });
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /open the payment form on this app/i);
    }
  });
});
