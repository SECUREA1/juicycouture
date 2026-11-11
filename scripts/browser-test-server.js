import { spawn } from "node:child_process";
import { startRpcFixture } from "../test-fixtures/solana-rpc.js";

if (process.env.NODE_ENV === "production") throw new Error("Test RPC fixtures cannot run in production.");
const rpc = await startRpcFixture();
const app = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "3100", ICE_SERVERS: "[]",
  TOKEN_MINT: "", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: rpc.url }, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => app.kill(signal));
app.on("exit", async (code) => { await rpc.close(); process.exit(code || 0); });
