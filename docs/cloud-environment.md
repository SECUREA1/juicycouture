# Cloud development environment

Use the existing isolated checkout at `/workspace/cautious-dollop`. Do not create
an additional Git worktree unless the user explicitly requests one.

## Installation script

```bash
set -euo pipefail
cd /workspace/cautious-dollop
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
npm run build
npm test
docker compose -f compose.yaml -f compose.cloud.yaml build
docker compose pull livekit
```

Node 22 or newer and the managed Docker daemon are required. The platform supplies
`CODEX_PROXY_CERT`; the cloud override mounts this CA only during npm installation.
Keep package integrity and TLS verification enabled. Dependencies and images are
retained in snapshots; running processes must restart.

## Startup instructions

```bash
cd /workspace/cautious-dollop
docker compose -f compose.yaml -f compose.cloud.yaml up -d --wait --wait-timeout 60
node scripts/smoke-stack.js
```

Check `docker compose ps` if readiness fails. The smoke check tests the homepage,
assets, health endpoint, room-token signing, room creation, and participant limit.
The browser connects to the local LiveKit endpoint on port 7880; the Node service
uses the internal Compose hostname. Media ports are TCP 7881 and UDP 7882.
This development stack binds to loopback and uses LiveKit's public development
credentials. Production video needs HTTPS, real credentials, and reachable media
addresses/ports, or a LiveKit Cloud project. Do not expose dev credentials remotely.
Stop this stack with `docker compose down` when needed.

The optional market dashboard starts in pending state. Do not invent a token mint.
A verified `TOKEN_MINT` and outbound HTTPS access to `api.dexscreener.com` are needed
for real market data. No external credentials are needed for the local stack.

These instructions are retained in the repository because the onboarding service
could not confirm saving `install_script` and `start_skill` during setup. They do
not establish that a reusable environment draft or snapshot has been published.
