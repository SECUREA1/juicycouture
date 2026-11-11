import assert from "node:assert/strict";
import { openRoomSocket } from "./room-socket.js";

const base = process.env.BASE_URL || "http://127.0.0.1:3000";
for (const path of ["/", "/styles.css", "/app.js", "/healthz"]) {
  assert.equal((await fetch(base + path)).status, 200, path);
}
const config = await (await fetch(base + "/api/config")).json();
assert.equal(config.videoReady, true);
assert.equal(config.videoMode, "peer-to-peer");
const clients = [];
try {
  const room = `smoke-${Date.now()}`;
  for (const name of ["First tester", "Second tester"]) {
    const client = await openRoomSocket(base);
    clients.push(client);
    client.send({ type: "join", room, name });
    await client.next("joined");
  }
  clients[0].send({ type: "chat", text: "Built-in room chat works" });
  assert.equal((await clients[1].next("chat")).text, "Built-in room chat works");
  await clients[1].close();
  await clients[0].next("peer-left");
  console.log("App assets, credential-free room join, shared chat and leave: PASS");
} finally {
  await Promise.all(clients.map((client) => client.close()));
}
