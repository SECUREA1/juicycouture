import { WebSocket } from "ws";

// Smoke-check listeners attach before connecting so broadcasts cannot be missed.
export async function openRoomSocket(base, options = {}) {
  const url = new URL("/api/room", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, { origin: new URL(base).origin, ...options });
  const queue = [];
  const waiters = new Set();
  socket.on("message", (raw, binary) => {
    const message = binary ? { type: "media", data: raw } : JSON.parse(raw.toString());
    const waiter = Array.from(waiters).find((item) => item.type === message.type);
    if (waiter) waiter.resolve(message);
    else queue.push(message);
  });
  socket.on("close", () => {
    for (const waiter of waiters) waiter.reject(new Error("Room socket closed"));
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    next(type, timeout = 5000) {
      const index = queue.findIndex((message) => message.type === type);
      if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => waiter.reject(new Error(`Timed out waiting for ${type}`)), timeout);
        const finish = (callback, value) => { clearTimeout(timer); waiters.delete(waiter); callback(value); };
        const waiter = { type, resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) };
        waiters.add(waiter);
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => { socket.once("close", resolve); socket.close(); });
    },
  };
}
