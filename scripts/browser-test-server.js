import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRpcFixture } from "../test-fixtures/solana-rpc.js";

if (process.env.NODE_ENV === "production") throw new Error("Test RPC fixtures cannot run in production.");
const rpc = await startRpcFixture();
const data = await mkdtemp(join(tmpdir(), "jcq-browser-"));
const app = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "3100", ICE_SERVERS: "[]",
  MEDIA_DATA_DIR: data, TOKEN_MINT: "", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: rpc.url }, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => app.kill(signal));
app.on("exit", async (code) => { await rpc.close(); await rm(data, { recursive: true, force: true }); process.exit(code || 0); });
