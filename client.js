import { Room, RoomEvent, Track } from "livekit-client";

const $ = (selector) => document.querySelector(selector);
const els = {
  coinName: $("#coin-name"), symbol: $("#coin-symbol"), network: $("#network"), mint: $("#mint-address"),
  status: $("#launch-status"), marketStatus: $("#market-status"), price: $("#price"), fdv: $("#fdv"),
  liquidity: $("#liquidity"), volume: $("#volume"), change: $("#change"), marketLink: $("#market-link"),
  chatSection: $("#live-room"), room: $("#room-code"), displayName: $("#display-name"), join: $("#join-room"),
  roomStatus: $("#room-status"), roomTitle: $("#room-title"), participants: $("#participants"), videos: $("#video-grid"),
  mic: $("#toggle-mic"), camera: $("#toggle-camera"), leave: $("#leave-room"), copy: $("#copy-invite"),
  chatForm: $("#chat-form"), chatInput: $("#chat-input"), chatMessages: $("#chat-messages"), communityLink: $("#community-link"),
};
let config = null;
let room = null;
let micOn = false;
let cameraOn = false;

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}

function formatUsd(value, compact = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const amount = Number(value);
  if (compact && Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(8)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(amount);
}

function roomFromUrl() {
  const query = new URLSearchParams(window.location.search);
  return query.get("room") || `juicy-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRoom(raw) {
  return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function makeInvite(roomName) {
  const invite = new URL(window.location.href);
  invite.searchParams.set("room", roomName);
  return invite.toString();
}

async function loadConfig() {
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load coin settings.");
  config = await response.json();
  els.coinName.textContent = config.coinName;
  els.symbol.textContent = `$${config.coinSymbol}`;
  els.network.textContent = config.network;
  els.mint.textContent = config.mint || "Pending official mint";
  els.mint.title = config.mint || "The token has not been deployed yet.";
  els.status.textContent = config.mint ? "Mint configured · market data loading" : "Launch prep · mint not published";
  if (config.communityUrl) {
    try {
      const community = new URL(config.communityUrl);
      if (["https:", "http:"].includes(community.protocol)) {
        els.communityLink.href = community.toString();
        els.communityLink.hidden = false;
      }
    } catch {}
  }
  if (!config.videoReady) {
    els.join.disabled = true;
    setStatus(els.roomStatus, "Video setup needed: add your LiveKit Cloud URL and API credentials in Render.", "pending");
  }
  await loadMarket();
}

async function loadMarket() {
  try {
    const response = await fetch("/api/market", { cache: "no-store" });
    const data = await response.json();
    if (data.status !== "live") {
      els.marketStatus.textContent = data.message || "Waiting for a verified live market.";
      els.price.textContent = "—";
      els.fdv.textContent = "—";
      els.liquidity.textContent = "—";
      els.volume.textContent = "—";
      els.change.textContent = "—";
      els.marketLink.hidden = true;
      return;
    }
    els.marketStatus.textContent = `Data refreshed ${new Date(data.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · market data by DexScreener`;
    els.price.textContent = data.priceUsd ? formatUsd(data.priceUsd) : "—";
    els.fdv.textContent = formatUsd(data.fdv, true);
    els.liquidity.textContent = formatUsd(data.liquidityUsd, true);
    els.volume.textContent = formatUsd(data.volume24h, true);
    els.change.textContent = data.change24h === null ? "—" : `${data.change24h > 0 ? "+" : ""}${data.change24h.toFixed(2)}%`;
    els.change.className = `metric-value ${data.change24h > 0 ? "positive" : data.change24h < 0 ? "negative" : ""}`;
    if (data.marketUrl) {
      els.marketLink.href = data.marketUrl;
      els.marketLink.hidden = false;
    } else els.marketLink.hidden = true;
    els.status.textContent = "Solana mint configured · live market data";
  } catch {
    els.marketStatus.textContent = "Market data is temporarily unavailable.";
  }
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
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function updateParticipants() {
  if (!room) return;
  const total = room.remoteParticipants.size + 1;
  els.participants.textContent = `${total} ${total === 1 ? "person" : "people"} here`;
}

function addVideoTile(identity, label, track, local = false) {
  let tile = document.querySelector(`[data-identity="${CSS.escape(identity)}"]`);
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
  track.attach(video);
}

function removeTile(identity) {
  document.querySelector(`[data-identity="${CSS.escape(identity)}"]`)?.remove();
}

async function joinRoom() {
  const name = els.displayName.value.trim().slice(0, 28);
  const roomName = normalizeRoom(els.room.value);
  if (!name) return setStatus(els.roomStatus, "Add a display name first.", "error");
  if (!roomName || roomName.length < 3) return setStatus(els.roomStatus, "Use a room code with at least 3 letters or numbers.", "error");
  els.join.disabled = true;
  els.room.value = roomName;
  setStatus(els.roomStatus, "Opening your room…", "pending");

  try {
    const response = await fetch("/api/room-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: roomName, name }),
    });
    const auth = await response.json();
    if (!response.ok) throw new Error(auth.error || "Unable to join the room.");

    room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === Track.Kind.Video) addVideoTile(participant.identity, participant.name || "Guest", track);
      if (track.kind === Track.Kind.Audio) {
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.dataset.identity = participant.identity;
        document.body.append(audio);
        track.attach(audio);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      track.detach().forEach((element) => element.remove());
      if (track.kind === Track.Kind.Video) removeTile(participant.identity);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      removeTile(participant.identity);
      document.querySelectorAll(`audio[data-identity="${CSS.escape(participant.identity)}"]`).forEach((audio) => audio.remove());
      updateParticipants();
    });
    room.on(RoomEvent.ParticipantConnected, updateParticipants);
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== "chat") return;
      try {
        const message = JSON.parse(new TextDecoder().decode(payload));
        if (message.type === "chat" && typeof message.text === "string") addChatLine(participant?.name || "Guest", message.text.slice(0, 400));
      } catch {}
    });
    room.on(RoomEvent.Disconnected, () => setStatus(els.roomStatus, "You left the live lounge.", "pending"));

    await room.connect(auth.livekitUrl, auth.token);
    await room.localParticipant.enableCameraAndMicrophone();
    micOn = true;
    cameraOn = true;
    els.mic.textContent = "Mic on";
    els.camera.textContent = "Camera on";
    const cameraTrack = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (cameraTrack) addVideoTile(room.localParticipant.identity, auth.name, cameraTrack, true);
    els.roomTitle.textContent = `Live lounge · ${roomName}`;
    els.chatSection.classList.add("connected");
    els.leave.disabled = false;
    els.mic.disabled = false;
    els.camera.disabled = false;
    els.copy.disabled = false;
    els.chatInput.disabled = false;
    els.chatForm.querySelector("button").disabled = false;
    setStatus(els.roomStatus, "You’re live. Say hello and enjoy the room.", "success");
    updateParticipants();
    history.replaceState(null, "", makeInvite(roomName));
  } catch (error) {
    if (room) {
      for (const publication of room.localParticipant.trackPublications.values()) publication.track?.stop();
      await room.disconnect().catch(() => {});
    }
    room = null;
    els.videos.replaceChildren();
    setStatus(els.roomStatus, error.message || "Could not start video. Check camera permissions and try again.", "error");
  } finally {
    els.join.disabled = !config?.videoReady;
  }
}

async function leaveRoom() {
  if (room) {
    for (const publication of room.localParticipant.trackPublications.values()) publication.track?.stop();
    await room.disconnect();
  }
  room = null;
  els.videos.replaceChildren();
  document.querySelectorAll("audio[data-identity]").forEach((audio) => audio.remove());
  els.chatSection.classList.remove("connected");
  els.leave.disabled = true;
  els.mic.disabled = true;
  els.camera.disabled = true;
  els.copy.disabled = true;
  els.chatInput.disabled = true;
  els.chatForm.querySelector("button").disabled = true;
  micOn = false;
  cameraOn = false;
  els.participants.textContent = "Not connected";
  setStatus(els.roomStatus, "You left the live lounge.", "pending");
}

els.join.addEventListener("click", joinRoom);
els.leave.addEventListener("click", leaveRoom);
els.mic.addEventListener("click", async () => {
  if (!room) return;
  micOn = !micOn;
  await room.localParticipant.setMicrophoneEnabled(micOn);
  els.mic.textContent = micOn ? "Mic on" : "Mic muted";
  els.mic.setAttribute("aria-pressed", String(micOn));
});
els.camera.addEventListener("click", async () => {
  if (!room) return;
  cameraOn = !cameraOn;
  await room.localParticipant.setCameraEnabled(cameraOn);
  els.camera.textContent = cameraOn ? "Camera on" : "Camera off";
  els.camera.setAttribute("aria-pressed", String(cameraOn));
  if (!cameraOn) removeTile(room.localParticipant.identity);
  else {
    const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (track) addVideoTile(room.localParticipant.identity, els.displayName.value.trim() || "You", track, true);
  }
});
els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(makeInvite(els.room.value));
    setStatus(els.roomStatus, "Invite link copied. Share it with the people you want in the room.", "success");
  } catch {
    setStatus(els.roomStatus, `Room code: ${els.room.value}. Copy it and share it privately.`, "pending");
  }
});
els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!room) return;
  const text = els.chatInput.value.trim().slice(0, 400);
  if (!text) return;
  await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: "chat", text })), { reliable: true, topic: "chat" });
  addChatLine(els.displayName.value.trim() || "You", text, true);
  els.chatInput.value = "";
});

els.room.value = roomFromUrl();
loadConfig().catch(() => setStatus(els.marketStatus, "Could not load the page settings."));
loadMarket();
setInterval(loadMarket, 30_000);
