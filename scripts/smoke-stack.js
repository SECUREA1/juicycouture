import assert from 'node:assert/strict';
import { RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';

// Checks the local Compose development stack; never prints tokens or secrets.
const base = 'http://127.0.0.1:3000';
for (const path of ['/', '/styles.css', '/app.js', '/healthz']) {
  assert.equal((await fetch(base + path)).status, 200, path);
}
const room = `smoke-${Date.now()}`;
const service = new RoomServiceClient('http://127.0.0.1:7880', 'devkey', 'secret');
try {
  const response = await fetch(base + '/api/room-token', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, name: 'Smoke test' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const claims = await new TokenVerifier('devkey', 'secret').verify(body.token);
  assert.equal(claims.video.room, room);
  assert.equal(body.livekitUrl, 'ws://localhost:7880');
  const rooms = await service.listRooms([room]);
  assert.equal(rooms[0].maxParticipants, 8);
  console.log('Compose assets, signed room token and LiveKit room creation: PASS');
} finally {
  await service.deleteRoom(room);
}
