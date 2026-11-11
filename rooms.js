import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

// Direct media is preferred; the existing socket can also relay media when a
// browser or firewall cannot establish a direct route. No media is stored.
export function attachRoomServer(server, { maxParticipants, validateWallet, verifyTip }) {
  const rooms = new Map();
  const seenTips = new Set();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  function send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) return socket.terminate();
    socket.send(Buffer.isBuffer(message) ? message : JSON.stringify(message));
  }

  function broadcast(members, message, except) {
    for (const member of members.values()) {
      if (member.id !== except) send(member.socket, message);
    }
  }

  const publicMember = ({ id, name, camera, microphone, isHost }) => ({ id, name, camera, microphone, isHost: Boolean(isHost) });
  const publicHost = (state) => state.hostKey ? {
    id: state.hostId, name: state.hostName, online: Boolean(state.hostId),
    wallet: state.wallet || null, revision: state.walletRevision,
  } : null;

  server.on("upgrade", (request, socket, head) => {
    let status = 403;
    try {
      const url = new URL(request.url, "http://localhost");
      const origin = new URL(request.headers.origin);
      if (url.pathname !== "/api/room") status = 404;
      else if (["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host) {
        if (sockets.clients.size < 256) {
          sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
          return;
        }
        status = 503;
      }
    } catch {}
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });

  sockets.on("connection", (socket) => {
    let member = null;
    let windowStarted = Date.now();
    let messageCount = 0;
    let chatCount = 0;
    let mediaBytes = 0;
    let tipCount = 0;
    let reactionCount = 0;
    socket.alive = true;
    socket.on("pong", () => { socket.alive = true; });
    socket.on("error", () => socket.terminate());
    const joinTimeout = setTimeout(() => socket.close(1008, "Join a room first"), 10_000).unref();
    const error = (code, message) => send(socket, { type: "error", code, message });

    function leave() {
      clearTimeout(joinTimeout);
      if (!member) return;
      const state = rooms.get(member.room);
      const members = state.members;
      members.delete(member.id);
      for (const peer of members.values()) peer.relayPeers.delete(member.id);
      broadcast(members, { type: "peer-left", id: member.id });
      if (state.hostId === member.id) {
        state.hostId = null;
        broadcast(members, { type: "host-updated", host: publicHost(state) });
      }
      if (!members.size) rooms.delete(member.room);
      member = null;
    }
    socket.on("close", leave);

    socket.on("message", (raw, binary) => {
      if (Date.now() - windowStarted > 10_000) {
        windowStarted = Date.now();
        messageCount = 0;
        chatCount = 0;
        mediaBytes = 0;
        tipCount = 0;
        reactionCount = 0;
      }
      if (binary) {
        if (!member || raw.length < 38 || ![1, 2].includes(raw[0])) return socket.close(1008, "Invalid media packet");
        mediaBytes += raw.length;
        if (mediaBytes > 16 * 1024 * 1024) return socket.close(1008, "Media rate exceeded");
        const target = rooms.get(member.room).members.get(raw.toString("ascii", 1, 37));
        if (!target || !member.relayPeers.has(target.id)) return;
        if (raw[0] === 2 && (raw.length < 43 || (raw.length - 41) % 2 !== 0
          || raw.readUInt32LE(37) < 8000 || raw.readUInt32LE(37) > 48000)) return;
        const forwarded = Buffer.from(raw);
        forwarded.write(member.id, 1, 36, "ascii");
        send(target.socket, forwarded);
        return;
      }
      if (++messageCount > 300) return socket.close(1008, "Too many messages");
      let message;
      try { message = JSON.parse(raw.toString()); } catch {
        return error("INVALID_JSON", "Send a valid JSON message.");
      }
      if (!message || typeof message !== "object") return error("INVALID_MESSAGE", "Send a room message.");

      if (message.type === "join") {
        if (member) return error("ALREADY_JOINED", "Leave before joining another room.");
        const room = typeof message.room === "string" ? message.room.trim().toLowerCase() : "";
        const name = typeof message.name === "string"
          ? message.name.trim().replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 28) : "";
        if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(room) || !name) {
          return error("INVALID_JOIN", "Add a name and a room code with 3–40 letters, numbers, or hyphens.");
        }
        const state = rooms.get(room) || { members: new Map(), hostKey: null, hostId: null, wallet: null,
          walletRevision: 0, wallets: new Set(), pendingTips: new Set(), createdAt: Date.now() };
        const members = state.members;
        if (members.size >= maxParticipants) return error("ROOM_FULL", `This room is full (${maxParticipants} people).`);
        const hosting = message.hosting === true;
        if (hosting && state.hostKey && (message.hostKey !== state.hostKey || state.hostId)) {
          return error("HOST_TAKEN", "This room already has a host. Join as a guest or start a new room.");
        }
        const peers = Array.from(members.values(), publicMember);
        member = { id: randomUUID(), name, room, socket, camera: true, microphone: true, isHost: hosting, relayPeers: new Set() };
        if (hosting) {
          state.hostKey ||= randomUUID();
          state.hostId = member.id;
          state.hostName = name;
        }
        members.set(member.id, member);
        rooms.set(room, state);
        clearTimeout(joinTimeout);
        send(socket, { type: "joined", self: publicMember(member), room, peers, maxParticipants,
          host: publicHost(state), ...(hosting ? { hostKey: state.hostKey } : {}) });
        broadcast(members, { type: "peer-joined", peer: publicMember(member) }, member.id);
        if (hosting) broadcast(members, { type: "host-updated", host: publicHost(state) }, member.id);
        return;
      }

      if (!member) return error("NOT_JOINED", "Join a room first.");
      const state = rooms.get(member.room);
      const members = state.members;
      if (message.type === "signal") {
        const target = members.get(message.to);
        if (!target || target.id === member.id) return error("UNKNOWN_PEER", "That person is no longer in this room.");
        const description = message.description;
        const candidate = message.candidate;
        if (description && !candidate && ["offer", "answer"].includes(description.type)
          && typeof description.sdp === "string" && description.sdp.length < 32_768) {
          send(target.socket, { type: "signal", from: member.id, description: { type: description.type, sdp: description.sdp } });
        } else if (!description && candidate && typeof candidate.candidate === "string" && candidate.candidate.length < 4096) {
          send(target.socket, { type: "signal", from: member.id, candidate: {
            candidate: candidate.candidate, sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment,
          } });
        } else error("INVALID_SIGNAL", "Invalid video connection message.");
      } else if (message.type === "relay-request") {
        const target = members.get(message.to);
        if (!target || target.id === member.id) return error("UNKNOWN_PEER", "That person is no longer in this room.");
        if (!member.relayPeers.has(target.id)) {
          member.relayPeers.add(target.id);
          target.relayPeers.add(member.id);
          send(socket, { type: "relay-ready", id: target.id });
          send(target.socket, { type: "relay-ready", id: member.id });
        }
      } else if (message.type === "host-wallet") {
        if (state.hostId !== member.id) return error("HOST_ONLY", "Only the host can designate the receiving wallet.");
        try { state.wallet = validateWallet(message.wallet); } catch (cause) { return error("INVALID_WALLET", cause.message); }
        state.walletRevision++;
        state.wallets.add(state.wallet);
        if (state.wallets.size > 8) state.wallets.delete(state.wallets.values().next().value);
        broadcast(members, { type: "host-updated", host: publicHost(state) });
      } else if (message.type === "tip-receipt") {
        if (++tipCount > 4) return error("TIP_LIMIT", "Please wait before verifying another tip.");
        if (!state.wallets.has(message.recipient)) return error("INVALID_RECIPIENT", "This is not a designated host wallet.");
        if (seenTips.has(message.signature) || state.pendingTips.has(message.signature)) return error("TIP_DUPLICATE", "This tip has already been announced.");
        if (typeof message.signature !== "string" || message.signature.length > 100) return error("INVALID_TIP", "Invalid transaction receipt.");
        state.pendingTips.add(message.signature);
        verifyTip({ signature: message.signature, recipient: message.recipient, asset: message.asset, notBefore: state.createdAt })
          .then((receipt) => {
            if (seenTips.has(receipt.signature)) return;
            seenTips.add(receipt.signature);
            if (seenTips.size > 5000) seenTips.delete(seenTips.values().next().value);
            broadcast(members, { type: "tip-confirmed", ...receipt, hostName: state.hostName });
          }).catch((cause) => error("TIP_UNVERIFIED", `${cause.message} Your transaction receipt remains available in the explorer.`))
          .finally(() => state.pendingTips.delete(message.signature));
      } else if (message.type === "reaction") {
        if (++reactionCount <= 12) broadcast(members, { type: "reaction", from: member.id });
      } else if (message.type === "chat") {
        const text = typeof message.text === "string" ? message.text.trim().slice(0, 400) : "";
        if (!text) return error("EMPTY_CHAT", "Write a message first.");
        if (++chatCount > 20) return error("CHAT_LIMIT", "Please wait a few seconds before sending more messages.");
        broadcast(members, { type: "chat", from: member.id, name: member.name, text });
      } else if (message.type === "media") {
        if (typeof message.camera !== "boolean" || typeof message.microphone !== "boolean") return;
        member.camera = message.camera;
        member.microphone = message.microphone;
        broadcast(members, { type: "peer-media", peer: publicMember(member) }, member.id);
      } else if (message.type === "leave") {
        leave();
        socket.close(1000, "Left room");
      } else error("INVALID_MESSAGE", "Unknown room message.");
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive) socket.terminate();
      else {
        socket.alive = false;
        socket.ping();
      }
    }
  }, 30_000).unref();
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  });
}
