# Cloud development environment

Use the existing isolated checkout at `/workspace/cautious-dollop`. Do not create
another Git worktree unless the user explicitly requests one.

## Installation

```bash
set -euo pipefail
cd /workspace/cautious-dollop
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
npm run build
npm test
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
docker compose -f compose.yaml -f compose.cloud.yaml build
```

Node 22 or newer, Chromium, and the managed Docker daemon are available in this
environment. The platform supplies `CODEX_PROXY_CERT` for build-time trust. Keep
TLS and package integrity verification enabled. No video-service credentials,
additional media server, database, or media ports are needed by the Node service.

## Startup

```bash
cd /workspace/cautious-dollop
docker compose -f compose.yaml -f compose.cloud.yaml up -d --wait --wait-timeout 60 --remove-orphans
node scripts/smoke-stack.js
```

One web container serves the app and room WebSockets on port 3000. Processes must
restart after snapshot restore. Inspect `docker compose ps` and
`docker compose logs web` if readiness fails. Stop only this stack with
`docker compose down` when appropriate. Do not create localhost preview links.
The `--remove-orphans` flag removes the previous development media container when
upgrading this stack.

The smoke check verifies assets, room joins without credentials, shared chat,
and leave cleanup. The browser suite additionally verifies decoded remote video,
live audio tracks, controls, rejoining, and camera permission errors. Its Node
process uses `ICE_SERVERS=[]` and needs no external STUN or TURN service.
To check the container itself:

```bash
BROWSER_BASE_URL=http://127.0.0.1:3000 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

Production hosting must provide HTTPS and forward WebSockets to this one Node
process. When direct WebRTC cannot connect, media automatically uses that same
WebSocket after five seconds. The built-in relay works with this environment's
browser policy, which disables non-proxied UDP. No STUN or TURN server is needed.
A verified
`TOKEN_MINT` and access to `api.dexscreener.com` are optional for real market data.
Do not invent a token mint or credentials.

These repository instructions do not establish publication of a reusable cloud
environment configuration or snapshot.
