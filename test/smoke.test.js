import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openRoomSocket } from "../scripts/room-socket.js";
import { Keypair } from "@solana/web3.js";

test("built app and rooms work without media-service credentials", { timeout: 30_000 }, async (t) => {
  const child = spawn(process.execPath, ["server.js"], { env: {
    ...process.env, PORT: "0", TOKEN_MINT: "", MAX_ROOM_PARTICIPANTS: "2", ICE_SERVERS: "[]",
  }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  });
  const output = await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => { throw new Error("Server exited before startup"); }),
  ]);
  const port = output[0].toString().match(/listening on (\d+)/)[1];
  const base = `http://127.0.0.1:${port}`;
  async function client(t) {
    const socket = await openRoomSocket(base);
    t.after(() => socket.close());
    return socket;
  }
  async function join(socket, room, name) {
    socket.send({ type: "join", room, name });
    return socket.next("joined");
  }

  await t.test("serves the page, assets and enabled room configuration", async () => {
    for (const [path, type, content] of [
      ["/", "text/html", 'id="coin-name"'],
      ["/styles.css", "text/css", "body"],
      ["/app.js", "text/javascript", "coin-name"],
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").includes(type));
      assert.equal(response.headers.get("cache-control"), "no-cache");
      const text = await response.text();
      assert.ok(text.includes(content));
      assert.ok(!text.includes("Video setup needed"));
    }
    const get = async (path) => (await fetch(base + path)).json();
    assert.deepEqual(await get("/healthz"), { ok: true });
    const config = await get("/api/config");
    assert.equal(config.videoReady, true);
    assert.equal(config.videoMode, "peer-to-peer");
    assert.equal(config.signalingPath, "/api/room");
    assert.deepEqual(config.iceServers, []);
    assert.equal((await get("/api/market")).status, "pending");
    assert.equal((await fetch(base + "/server.js")).status, 404);
  });

  await t.test("rejects WebSocket connections from other sites", async () => {
    await assert.rejects(openRoomSocket(base, { origin: "https://another.example" }), /403/);
  });

  await t.test("serves all original and new graphics from the built application", async () => {
    for (const [name, type] of [["coin-medallion.jpeg", "image/jpeg"], ["juicy-banner.jpeg", "image/jpeg"], ["love-crown.png", "image/png"], ["heart.svg", "image/svg+xml"]]) {
      const response = await fetch(`${base}/graphics/${name}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").includes(type));
      assert.ok((await response.arrayBuffer()).byteLength > 100);
    }
  });

  await t.test("validates joins and handles malformed JSON without crashing", async (t) => {
    const socket = await client(t);
    socket.socket.send("{");
    assert.equal((await socket.next("error")).code, "INVALID_JSON");
    socket.send({ type: "chat", text: "not joined" });
    assert.equal((await socket.next("error")).code, "NOT_JOINED");
    socket.send({ type: "join", room: "bad room", name: "" });
    assert.equal((await socket.next("error")).code, "INVALID_JOIN");
    const joined = await join(socket, "VALID-ROOM", " Alice ");
    assert.equal(joined.room, "valid-room");
    assert.equal(joined.self.name, "Alice");
    socket.send({ type: "join", room: "another-room", name: "Alice" });
    assert.equal((await socket.next("error")).code, "ALREADY_JOINED");
  });

  await t.test("routes offers and ICE only to peers in the same room", async (t) => {
    const alice = await client(t), bob = await client(t), outsider = await client(t);
    const a = await join(alice, "shared-room", "Alice");
    const b = await join(bob, "shared-room", "Bob");
    const c = await join(outsider, "private-room", "Outsider");
    assert.equal((await alice.next("peer-joined")).peer.id, b.self.id);
    assert.equal(b.peers[0].id, a.self.id);
    alice.send({ type: "signal", to: b.self.id, from: "spoofed", description: { type: "offer", sdp: "test-offer" } });
    const offer = await bob.next("signal");
    assert.equal(offer.from, a.self.id);
    assert.equal(offer.description.sdp, "test-offer");
    bob.send({ type: "signal", to: a.self.id, candidate: { candidate: "test-candidate", sdpMid: "0", sdpMLineIndex: 0 } });
    assert.equal((await alice.next("signal")).candidate.candidate, "test-candidate");
    alice.send({ type: "signal", to: c.self.id, description: { type: "offer", sdp: "must-not-leak" } });
    assert.equal((await alice.next("error")).code, "UNKNOWN_PEER");
    await assert.rejects(outsider.next("signal", 100), /Timed out/);
    alice.send({ type: "media", camera: false, microphone: true });
    assert.equal((await bob.next("peer-media")).peer.camera, false);
  });

  await t.test("chat uses server-assigned identities and stays inside its room", async (t) => {
    const alice = await client(t), bob = await client(t), outsider = await client(t);
    const a = await join(alice, "chat-room", "Alice");
    await join(bob, "chat-room", "Bob");
    await join(outsider, "other-chat", "Outsider");
    alice.send({ type: "chat", name: "Impersonator", from: "fake", text: "Hello" });
    const message = await bob.next("chat");
    assert.equal(message.name, "Alice");
    assert.equal(message.from, a.self.id);
    assert.equal(message.text, "Hello");
    assert.equal((await alice.next("chat")).text, "Hello");
    await assert.rejects(outsider.next("chat", 100), /Timed out/);
    alice.send({ type: "chat", text: " " });
    assert.equal((await alice.next("error")).code, "EMPTY_CHAT");
  });

  await t.test("enforces capacity and releases slots on disconnect", async (t) => {
    const first = await client(t), second = await client(t), third = await client(t);
    const a = await join(first, "limited-room", "First");
    await join(second, "limited-room", "Second");
    third.send({ type: "join", room: "limited-room", name: "Third" });
    assert.equal((await third.next("error")).code, "ROOM_FULL");
    await first.close();
    assert.equal((await second.next("peer-left")).id, a.self.id);
    const c = await join(third, "limited-room", "Third");
    assert.equal(c.peers.length, 1);
    assert.equal(c.maxParticipants, 2);
  });

  await t.test("built-in media relay forwards bytes only between authorized room peers", async (t) => {
    const alice = await client(t), bob = await client(t), outsider = await client(t);
    const a = await join(alice, "media-room", "Alice");
    const b = await join(bob, "media-room", "Bob");
    const c = await join(outsider, "other-media", "Outsider");
    const video = Buffer.alloc(38);
    video[0] = 1;
    video.write(b.self.id, 1, 36, "ascii");
    video[37] = 123;
    alice.socket.send(video);
    await assert.rejects(bob.next("media", 100), /Timed out/);
    alice.send({ type: "relay-request", to: c.self.id });
    assert.equal((await alice.next("error")).code, "UNKNOWN_PEER");
    alice.send({ type: "relay-request", to: b.self.id });
    assert.equal((await alice.next("relay-ready")).id, b.self.id);
    assert.equal((await bob.next("relay-ready")).id, a.self.id);
    alice.socket.send(video);
    const frame = (await bob.next("media")).data;
    assert.equal(frame.toString("ascii", 1, 37), a.self.id);
    assert.equal(frame[37], 123);
    const audio = Buffer.alloc(45);
    audio[0] = 2;
    audio.write(a.self.id, 1, 36, "ascii");
    audio.writeUInt32LE(16000, 37);
    audio.writeInt16LE(32767, 41);
    bob.socket.send(audio);
    const samples = (await alice.next("media")).data;
    assert.equal(samples.toString("ascii", 1, 37), b.self.id);
    assert.equal(samples.readInt16LE(41), 32767);
    await assert.rejects(outsider.next("media", 100), /Timed out/);
  });

  await t.test("host payout controls are private, guest-proof and resumable", async (t) => {
    const host = await client(t), guest = await client(t);
    host.send({ type: "join", room: "hosted-room", name: "Host", hosting: true });
    const started = await host.next("joined");
    assert.equal(started.self.isHost, true);
    assert.ok(started.hostKey);
    guest.send({ type: "join", room: "hosted-room", name: "Impostor", hosting: true });
    assert.equal((await guest.next("error")).code, "HOST_TAKEN");
    const visitor = await join(guest, "hosted-room", "Guest");
    assert.equal(visitor.hostKey, undefined);
    assert.equal(visitor.self.isHost, false);
    const wallet = Keypair.generate().publicKey.toBase58();
    guest.send({ type: "host-wallet", wallet });
    assert.equal((await guest.next("error")).code, "HOST_ONLY");
    host.send({ type: "host-wallet", wallet: "0x123" });
    assert.equal((await host.next("error")).code, "INVALID_WALLET");
    host.send({ type: "host-wallet", wallet });
    assert.equal((await host.next("host-updated")).host.wallet, wallet);
    assert.equal((await guest.next("host-updated")).host.wallet, wallet);
    guest.send({ type: "tip-receipt", recipient: wallet, asset: "SOL", signature: "not-a-real-signature" });
    assert.equal((await guest.next("error")).code, "TIP_UNVERIFIED");
    await host.close();
    assert.equal((await guest.next("host-updated")).host.online, false);
    const returning = await client(t);
    returning.send({ type: "join", room: "hosted-room", name: "Host returned", hosting: true, hostKey: started.hostKey });
    const resumed = await returning.next("joined");
    assert.equal(resumed.self.isHost, true);
    assert.equal(resumed.host.wallet, wallet);
    assert.equal(resumed.hostKey, started.hostKey);
  });
});
