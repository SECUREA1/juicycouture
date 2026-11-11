import { initWalletUI } from "./wallet-ui.js";

const $ = (selector) => document.querySelector(selector);
const els = {
  coinName: $("#coin-name"), chatSection: $("#live-room"), room: $("#room-code"), displayName: $("#display-name"),
  join: $("#join-room"), hostStart: $("#host-room"), roomStatus: $("#room-status"), roomTitle: $("#room-title"),
  participants: $("#participants"), videos: $("#video-grid"), mic: $("#toggle-mic"), camera: $("#toggle-camera"),
  leave: $("#leave-room"), copy: $("#copy-invite"), love: $("#send-love"), chatForm: $("#chat-form"),
  chatInput: $("#chat-input"), chatMessages: $("#chat-messages"), communityLink: $("#community-link"),
};
let config = null;
let room = null;
let walletUI = null;
let micOn = false;
let cameraOn = false;

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}
function roomFromUrl() {
  return new URLSearchParams(location.search).get("room") || `juicy-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
function normalizeRoom(raw) {
  return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}
function makeInvite(roomName) {
  const invite = new URL(location.href);
  invite.searchParams.set("room", roomName);
  return invite.toString();
}
function savedHostKey(roomName) {
  try { return sessionStorage.getItem(`jcq-host:${roomName}`); } catch { return null; }
}
function markHostTiles() {
  for (const tile of els.videos.children) {
    const isHost = tile.dataset.identity === room?.host?.id;
    tile.classList.toggle("host-tile", isHost);
    tile.style.order = isHost ? "-1" : "0";
    tile.querySelector(".host-crown")?.remove();
    if (isHost) {
      const crown = document.createElement("span"); crown.className = "host-crown"; crown.textContent = "HOST ♛"; tile.append(crown);
    }
  }
}
function hearts(count = 6) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = $("#hearts-layer");
  for (let i = 0; i < count && layer.children.length < 36; i++) {
    const heart = document.createElement("span"); heart.className = "floating-heart"; heart.textContent = i % 4 === 0 ? "✧" : "♡";
    heart.style.setProperty("--left", `${15 + Math.random() * 70}%`);
    heart.style.setProperty("--drift", `${Math.random() * 100 - 50}px`);
    heart.style.animationDelay = `${i * 0.08}s`; layer.append(heart); heart.addEventListener("animationend", () => heart.remove());
  }
}
async function loadConfig() {
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the lounge settings. Refresh to try again.");
  config = await response.json();
  els.coinName.textContent = config.coinName;
  if (config.communityUrl) {
    try { const url = new URL(config.communityUrl); if (url.protocol === "https:") { els.communityLink.href = url; els.communityLink.hidden = false; } } catch {}
  }
  walletUI = initWalletUI({ config, getRoom: () => room, send: (message) => room ? sendRoom(room, message) : false, onTip: () => hearts(15) });
  els.join.disabled = false;
  els.hostStart.disabled = false;
}

function addChatLine(name, message, mine = false) {
  const row = document.createElement("li");
  row.className = mine ? "chat-line mine" : "chat-line";
  const sender = document.createElement("strong");
  sender.textContent = name;
  const body = document.createElement("span");
  body.textContent = message;
  row.append(sender, body);
  els.chatMessages.append(row);
  if (els.chatMessages.children.length > 100) els.chatMessages.firstElementChild.remove();
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function updateParticipants() {
  if (!room) return;
  const total = room.peers.size + 1;
  els.participants.textContent = `${total} ${total === 1 ? "person" : "people"} here`;
}

function addVideoTile(identity, label, stream, local = false) {
  let tile = els.videos.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
  if (!tile) {
    tile = document.createElement("article");
    tile.className = `video-tile${local ? " self" : ""}`;
    tile.dataset.identity = identity;
    const labelEl = document.createElement("div");
    labelEl.className = "video-name";
    labelEl.textContent = local ? `${label} · you` : label;
    tile.append(labelEl);
    els.videos.append(tile);
  }
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = local;
  video.setAttribute("aria-label", `${label} camera`);
  tile.querySelector("video")?.remove();
  tile.prepend(video);
  video.srcObject = stream;
  video.play().catch(() => { video.controls = true; });
  markHostTiles();
}

function removeTile(identity) {
  els.videos.querySelector(`[data-identity="${CSS.escape(identity)}"]`)?.remove();
}

function sendRoom(session, message) {
  if (session.socket?.readyState !== WebSocket.OPEN) return false;
  session.socket.send(JSON.stringify(message));
  return true;
}

function updateMedia(peer) {
  const tile = els.videos.querySelector(`[data-identity="${CSS.escape(peer.id)}"]`);
  if (!tile) return;
  tile.querySelector("video").hidden = !peer.camera;
  tile.querySelector(".video-name").textContent = `${peer.name}${peer.id === room?.id ? " · you" : ""}${peer.camera ? "" : " · camera off"}${peer.microphone ? "" : " · muted"}`;
}

function requestRelay(session, peer) {
  if (!session.closed && !peer.relay) sendRoom(session, { type: "relay-request", to: peer.id });
}

function sendMedia(session, kind, bytes) {
  if (session.closed || session.socket?.readyState !== WebSocket.OPEN) return;
  const headerSize = kind === 2 ? 41 : 37;
  for (const peer of session.peers.values()) {
    if (!peer.relay || session.socket.bufferedAmount > 256 * 1024) continue;
    const packet = new Uint8Array(headerSize + bytes.byteLength);
    packet[0] = kind;
    packet.set(new TextEncoder().encode(peer.id), 1);
    if (kind === 2) new DataView(packet.buffer).setUint32(37, session.audioContext.sampleRate, true);
    packet.set(new Uint8Array(bytes), headerSize);
    session.socket.send(packet);
  }
}

async function startRelayCapture(session) {
  if (session.captureStarted) return;
  session.captureStarted = true;
  const video = session.captureVideo = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = session.stream;
  await video.play();
  if (session.closed) return;
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 270;
  const context = canvas.getContext("2d");
  let drawing = false;
  session.videoTimer = setInterval(async () => {
    if (session.closed || !cameraOn || drawing || !video.videoWidth || session.socket.bufferedAmount > 256 * 1024) return;
    drawing = true;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.55));
      if (blob && blob.size < 60_000) sendMedia(session, 1, await blob.arrayBuffer());
    } finally { drawing = false; }
  }, 125);
  await session.audioContext.audioWorklet.addModule("/audio-worklet.js");
  if (session.closed) return;
  session.audioSource = session.audioContext.createMediaStreamSource(session.stream);
  session.captureNode = new AudioWorkletNode(session.audioContext, "room-audio-capture");
  session.captureNode.port.onmessage = ({ data }) => { if (micOn) sendMedia(session, 2, data); };
  session.audioSource.connect(session.captureNode).connect(session.audioContext.destination);
}

function enableRelay(session, id) {
  const peer = session.peers.get(id);
  if (!peer || peer.relay || session.closed) return;
  peer.relay = true;
  stopPeerConnection(peer);
  peer.canvas = document.createElement("canvas");
  peer.canvas.width = 480;
  peer.canvas.height = 270;
  peer.audioSink = session.audioContext.createMediaStreamDestination();
  peer.relayStream = peer.canvas.captureStream(10);
  peer.relayStream.addTrack(peer.audioSink.stream.getAudioTracks()[0]);
  addVideoTile(peer.id, peer.name, peer.relayStream);
  updateMedia(peer);
  startRelayCapture(session).catch(() => {
    if (!session.closed) setStatus(els.roomStatus, "Could not start the room media. Try leaving and rejoining.", "error");
  });
}

async function receiveMedia(session, packet) {
  if (session.closed || packet.byteLength < 38) return;
  const bytes = new Uint8Array(packet);
  const id = new TextDecoder().decode(bytes.subarray(1, 37));
  const peer = session.peers.get(id);
  if (!peer?.relay) return;
  if (bytes[0] === 1 && !peer.drawing) {
    peer.drawing = true;
    try {
      const frame = await createImageBitmap(new Blob([bytes.subarray(37)], { type: "image/jpeg" }));
      if (!session.closed && session.peers.has(id)) peer.canvas.getContext("2d").drawImage(frame, 0, 0, 480, 270);
      frame.close();
    } finally { peer.drawing = false; }
  } else if (bytes[0] === 2 && packet.byteLength >= 43) {
    const samples = new Int16Array(packet.slice(41));
    const sampleRate = new DataView(packet).getUint32(37, true);
    const buffer = session.audioContext.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = session.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(peer.audioSink);
    const now = session.audioContext.currentTime;
    if (!peer.playAt || peer.playAt < now || peer.playAt > now + 0.5) peer.playAt = now + 0.12;
    source.start(peer.playAt);
    peer.playAt += buffer.duration;
    source.onended = () => source.disconnect();
  }
}

function addPeer(session, participant) {
  if (session.peers.has(participant.id)) return session.peers.get(participant.id);
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  const peer = { ...participant, pc, stream: new MediaStream(), candidates: [],
    makingOffer: false, ignoreOffer: false, settingAnswer: false, retries: 0 };
  session.peers.set(peer.id, peer);
  for (const track of session.stream.getTracks()) pc.addTrack(track, session.stream);
  pc.ontrack = ({ track }) => {
    peer.stream.addTrack(track);
    if (!els.videos.querySelector(`[data-identity="${CSS.escape(peer.id)}"]`)) {
      addVideoTile(peer.id, peer.name, peer.stream);
    }
    updateMedia(peer);
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendRoom(session, { type: "signal", to: peer.id, candidate: candidate.toJSON() });
  };
  // Perfect negotiation handles simultaneous offers and ICE restarts safely.
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendRoom(session, { type: "signal", to: peer.id, description: pc.localDescription });
    } catch {
      if (!session.closed && pc.signalingState !== "closed") setStatus(els.roomStatus, `Could not connect video to ${peer.name}. Try leaving and rejoining.`, "error");
    } finally { peer.makingOffer = false; }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      requestRelay(session, peer);
    } else if (pc.connectionState === "disconnected") {
      clearTimeout(peer.relayTimer);
      peer.relayTimer = setTimeout(() => requestRelay(session, peer), 5000);
    }
  };
  peer.relayTimer = setTimeout(() => {
    if (pc.connectionState !== "connected") requestRelay(session, peer);
  }, 5000);
  return peer;
}

async function receiveSignal(session, message) {
  const peer = session.peers.get(message.from);
  if (!peer || peer.relay) return; // A person can leave while signals are in flight.
  const pc = peer.pc;
  if (message.description) {
    const description = message.description;
    const readyForOffer = !peer.makingOffer && (pc.signalingState === "stable" || peer.settingAnswer);
    const collision = description.type === "offer" && !readyForOffer;
    const polite = session.id > peer.id;
    peer.ignoreOffer = !polite && collision;
    if (peer.ignoreOffer) return;
    peer.settingAnswer = description.type === "answer";
    try { await pc.setRemoteDescription(description); } finally { peer.settingAnswer = false; }
    for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
    if (description.type === "offer") {
      await pc.setLocalDescription();
      sendRoom(session, { type: "signal", to: peer.id, description: pc.localDescription });
    }
  } else if (message.candidate && !peer.ignoreOffer) {
    if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
    else if (peer.candidates.length < 128) peer.candidates.push(message.candidate);
  }
}

function stopPeerConnection(peer) {
  clearTimeout(peer.relayTimer);
  peer.pc.onconnectionstatechange = null;
  peer.pc.ontrack = null;
  peer.pc.onicecandidate = null;
  peer.pc.onnegotiationneeded = null;
  peer.pc.close();
}

function removePeer(session, id) {
  const peer = session.peers.get(id);
  if (!peer) return;
  stopPeerConnection(peer);
  peer.relayStream?.getTracks().forEach((track) => track.stop());
  session.peers.delete(id);
  removeTile(id);
}

function disposeRoom(session) {
  session.closed = true;
  session.cancelJoin?.();
  session.socket?.close();
  clearInterval(session.videoTimer);
  session.captureNode?.disconnect();
  session.audioSource?.disconnect();
  session.audioContext?.close().catch(() => {});
  if (session.captureVideo) session.captureVideo.srcObject = null;
  session.stream?.getTracks().forEach((track) => track.stop());
  for (const id of session.peers.keys()) removePeer(session, id);
  if (room !== session) return;
  room = null;
  els.videos.replaceChildren();
  els.chatSection.classList.remove("connected");
  for (const button of [els.leave, els.mic, els.camera, els.copy, els.love, els.chatInput, els.chatForm.querySelector("button")]) button.disabled = true;
  els.displayName.disabled = false;
  els.room.disabled = false;
  els.join.disabled = !config;
  els.hostStart.disabled = !config;
  walletUI?.update();
  micOn = false;
  cameraOn = false;
  els.participants.textContent = "Not connected";
  els.roomTitle.textContent = "Your lounge is waiting";
}

function connectRoom(session, name, roomName) {
  const url = new URL(config.signalingPath, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = session.socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let messages = Promise.resolve();
  return new Promise((resolveJoin, rejectJoin) => {
    const timer = setTimeout(() => rejectJoin(new Error("The room connection timed out. Please try joining again.")), 15_000);
    const reject = (error) => { clearTimeout(timer); rejectJoin(error); };
    session.cancelJoin = () => reject(new Error("Joining cancelled."));
    socket.onopen = () => sendRoom(session, { type: "join", name, room: roomName, hosting: session.hosting, hostKey: savedHostKey(roomName) });
    socket.onerror = () => reject(new Error("Could not connect to the room. Please try again."));
    socket.onclose = () => {
      reject(new Error("The room connection closed. Please try joining again."));
      if (!session.closed) {
        disposeRoom(session);
        setStatus(els.roomStatus, "Your room connection closed. Rejoin to continue.", "pending");
      }
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        receiveMedia(session, event.data).catch(() => {});
        return;
      }
      messages = messages.then(async () => {
        if (session.closed) return;
        const message = JSON.parse(event.data);
        if (message.type === "joined") {
          session.id = message.self.id;
          session.name = message.self.name;
          session.isHost = message.self.isHost;
          session.host = message.host;
          if (message.hostKey) { try { sessionStorage.setItem(`jcq-host:${roomName}`, message.hostKey); } catch {} }
          walletUI?.update();
          for (const peer of message.peers) addPeer(session, peer);
          clearTimeout(timer);
          resolveJoin();
        } else if (message.type === "peer-joined") {
          addPeer(session, message.peer);
          updateParticipants();
        } else if (message.type === "peer-left") {
          removePeer(session, message.id);
          updateParticipants();
        } else if (message.type === "peer-media") {
          const peer = session.peers.get(message.peer.id);
          if (peer) { Object.assign(peer, message.peer); updateMedia(peer); }
        } else if (message.type === "host-updated") {
          session.host = message.host;
          markHostTiles(); walletUI?.update();
        } else if (message.type === "tip-confirmed") {
          walletUI?.confirmed(message);
        } else if (message.type === "reaction") {
          hearts();
        } else if (message.type === "relay-ready") {
          enableRelay(session, message.id);
        } else if (message.type === "signal") await receiveSignal(session, message);
        else if (message.type === "chat") addChatLine(message.name, message.text, message.from === session.id);
        else if (message.type === "error") {
          if (!session.id) reject(new Error(message.message));
          else if (["HOST_ONLY", "INVALID_WALLET"].includes(message.code)) walletUI?.error(message.message);
          else if (message.code.startsWith("TIP_") || message.code === "INVALID_RECIPIENT") walletUI?.error(message.message, "tip");
          else if (message.code !== "UNKNOWN_PEER") setStatus(els.roomStatus, message.message, "error");
        }
      }).catch(() => {
        if (!session.closed) setStatus(els.roomStatus, "A video connection was interrupted. Try leaving and rejoining; room chat is still available.", "pending");
      });
    };
  });
}

async function joinRoom(hosting = false) {
  if (room || !config) return;
  const name = els.displayName.value.trim().slice(0, 28);
  const roomName = normalizeRoom(els.room.value);
  if (!name) return setStatus(els.roomStatus, "Add a display name first.", "error");
  if (!roomName || roomName.length < 3) return setStatus(els.roomStatus, "Use a room code with at least 3 letters or numbers.", "error");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return setStatus(els.roomStatus, "Open this page over HTTPS (or localhost) to use your camera and microphone.", "error");
  }
  if (!window.RTCPeerConnection) return setStatus(els.roomStatus, "Use a current browser with video calling support.", "error");
  const session = { peers: new Map(), closed: false, hosting, code: roomName };
  room = session;
  els.join.disabled = true;
  els.hostStart.disabled = true;
  els.displayName.disabled = true;
  els.room.disabled = true;
  els.leave.disabled = false;
  els.room.value = roomName;
  els.chatMessages.replaceChildren();
  setStatus(els.roomStatus, "Opening your room…", "pending");

  try {
    session.audioContext = new AudioContext({ sampleRate: 16000 });
    await session.audioContext.resume();
    session.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (session.closed) { session.stream.getTracks().forEach((track) => track.stop()); return; }
    await connectRoom(session, name, roomName);
    if (session.closed) return;
    micOn = true;
    cameraOn = true;
    els.mic.textContent = "Mic on";
    els.camera.textContent = "Camera on";
    els.mic.setAttribute("aria-pressed", "true");
    els.camera.setAttribute("aria-pressed", "true");
    addVideoTile(session.id, session.name, session.stream, true);
    els.roomTitle.textContent = `Live lounge · ${roomName}`;
    els.chatSection.classList.add("connected");
    els.leave.disabled = false;
    els.mic.disabled = false;
    els.camera.disabled = false;
    els.copy.disabled = false;
    els.love.disabled = false;
    walletUI?.update();
    els.chatInput.disabled = false;
    els.chatForm.querySelector("button").disabled = false;
    setStatus(els.roomStatus, "You’re live. Say hello and enjoy the room.", "success");
    updateParticipants();
    history.replaceState(null, "", makeInvite(roomName));
  } catch (error) {
    if (room === session) {
      disposeRoom(session);
      const message = error.name === "NotAllowedError" ? "Allow camera and microphone access in your browser, then join again."
        : error.name === "NotFoundError" ? "No camera or microphone was found. Connect a device and try again."
        : error.message || "Could not start video. Check camera permissions and try again.";
      setStatus(els.roomStatus, message, "error");
    }
  }
}

function leaveRoom() {
  if (room) disposeRoom(room);
  setStatus(els.roomStatus, "You left the live lounge.", "pending");
}

els.join.addEventListener("click", () => joinRoom(false));
els.hostStart.addEventListener("click", () => joinRoom(true));
$("#hero-host").addEventListener("click", () => setTimeout(() => els.displayName.focus(), 250));
els.love.addEventListener("click", () => { if (room) sendRoom(room, { type: "reaction" }); });
els.leave.addEventListener("click", leaveRoom);
els.mic.addEventListener("click", () => {
  if (!room) return;
  micOn = !micOn;
  room.stream.getAudioTracks().forEach((track) => { track.enabled = micOn; });
  els.mic.textContent = micOn ? "Mic on" : "Mic muted";
  els.mic.setAttribute("aria-pressed", String(micOn));
  updateMedia({ id: room.id, name: room.name, camera: cameraOn, microphone: micOn });
  sendRoom(room, { type: "media", camera: cameraOn, microphone: micOn });
});
els.camera.addEventListener("click", () => {
  if (!room) return;
  cameraOn = !cameraOn;
  room.stream.getVideoTracks().forEach((track) => { track.enabled = cameraOn; });
  els.camera.textContent = cameraOn ? "Camera on" : "Camera off";
  els.camera.setAttribute("aria-pressed", String(cameraOn));
  updateMedia({ id: room.id, name: room.name, camera: cameraOn, microphone: micOn });
  sendRoom(room, { type: "media", camera: cameraOn, microphone: micOn });
});
els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(makeInvite(els.room.value));
    setStatus(els.roomStatus, "Invite link copied. Share it with the people you want in the room.", "success");
  } catch {
    setStatus(els.roomStatus, `Room code: ${els.room.value}. Copy it and share it privately.`, "pending");
  }
});
els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!room) return;
  const text = els.chatInput.value.trim().slice(0, 400);
  if (!text) return;
  if (!sendRoom(room, { type: "chat", text })) return;
  els.chatInput.value = "";
});
window.addEventListener("pagehide", () => { if (room) disposeRoom(room); });

els.room.value = roomFromUrl();
loadConfig().catch((error) => setStatus(els.roomStatus, error.message, "error"));
