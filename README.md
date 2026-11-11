# Juicy Couture Coin Live Hub

A Node app for the Juicy Couture Coin community: a Solana token dashboard,
participation reward information, and small-group video rooms with text chat.

Video uses the browser's built-in media support. The same Node process serves
the page, connects room members over WebSocket, and relays chat and media when
needed. **No video-service account, API keys, database, STUN/TURN service, or
separate media container is required.**

## Run locally

Requires Node.js 20 or newer.

```sh
npm ci
npm run build
npm start
```

Open the app on port 3000, enter a display name and room code, and join. Allow
camera and microphone access, then copy the invite for another participant.
Camera/microphone controls, participant counts, chat, and leaving are built in.
The room limit defaults to 8 and can be set from 2 to 12.

## Hosting and wallet tips

Choose **Go live** to become the room's host. Guests use **Join a room**. Open
**Your host payout settings**, enter a Solana wallet address (or use a connected
wallet), and save it. The full receiving wallet is displayed to every viewer.
Only the host can change it. A private resume key in the host's session storage
allows that tab to reclaim hosting after disconnecting while the room remains
active; do not share that key. If every participant leaves or the server restarts,
room state is discarded. Start a fresh room before sharing an invite again.

Viewers can connect Phantom or a MetaMask account with **Solana support** through
the Wallet Standard. Ethereum-only MetaMask accounts are not used for Solana
payments. Connecting a wallet never authorizes a payment. Viewers select a SOL
amount, review the host's full receiving address and network, then explicitly
approve the transfer in their wallet. Tips transfer directly to the designated
wallet, with no platform fee. Users pay network fees. The app never requests seed
phrases, private keys, or token spending approvals.

The server validates the real confirmed transaction before showing a tip event
or heart celebration. It checks the recipient, asset, sender, signature, and room
time, and rejects duplicate announcements. The app has no custodial balance or
reward ledger. It does not automatically mint, airdrop, or distribute rewards.

JCQ details are intentionally left as coming-soon copy. **JCQ transfers remain
disabled while TOKEN_MINT is blank.** After an official legacy SPL mint is
configured, the same review flow can send exact JCQ token amounts using checked
SPL transfers. The sender may need to fund creation of the host's associated
token account, in addition to network fees. Token-2022 extensions are not supported
by this implementation. Do not substitute a guessed or example mint.

SOLANA_CLUSTER defaults to mainnet-beta; use devnet for test funds. The app
checks the RPC genesis network before using it. Public RPC endpoints work without
an API key; SOLANA_RPC_URL can select a provider for production traffic. Hosting
must allow outbound HTTPS to api.mainnet-beta.solana.com (or api.devnet.solana.com
for devnet). This managed cloud's outbound policy blocked the live Solana endpoint
during development, so payment verification used a local RPC fixture and ephemeral
test signatures. No real funds were sent. Add the applicable RPC domain in cloud
environment network settings to test live chain access here.


All environment variables are optional. For local customization, copy
`.env.example` to `.env` if it does not exist and use
`node --env-file=.env server.js`. Do not source `.env` as a shell script: display
names can contain spaces. Never commit `.env`.

## Docker

```sh
docker compose up --build -d --wait
docker compose ps
docker compose logs web
# Stop this stack:
docker compose down
```

Compose starts one web container on port 3000. For managed Codex Cloud builds,
use the supplied CA secret without changing TLS verification:

```sh
docker compose -f compose.yaml -f compose.cloud.yaml up --build -d --wait --remove-orphans
```

The cloud override mounts `CODEX_PROXY_CERT` only during dependency installation.
It does not store that certificate in the image. To run a standalone image:

```sh
docker build -t juicy-live .
docker run --rm --init -p 3000:3000 juicy-live
```

The image contains the complete built page, runs as a non-root user, and checks
`/healthz`.

## Deploy on Render

Connect this repository as a Render Blueprint using `render.yaml`, or create a
Node web service with these commands:

- Build: `npm ci --no-audit --no-fund && npm run build`
- Start: `npm start`
- Health check: `/healthz`

Keep one service instance: active room membership is held in that Node process.
Render provides HTTPS and forwards the app's WebSocket endpoint. Video works
without setting any `LIVEKIT_*` variables; old values are ignored. Redeploy the
latest commit and reload the page to replace an older credential-gated build.
An app restart ends active rooms; participants can join again.

Camera and microphone access requires HTTPS outside localhost. The app first
tries a direct WebRTC connection. If a direct route is blocked or not established
within five seconds, it automatically sends live JPEG frames and mono audio
through the existing room WebSocket. This built-in relay needs only the web app's
HTTPS port and works when the browser blocks direct UDP. Relayed video uses
480×270 frames at up to 8 fps and 16 kHz audio; direct WebRTC has higher quality.
The relay keeps only live data in memory, limits packet sizes, and drops frames
when the network is backed up. This is intended for small groups, rather than
large broadcasts; relay traffic uses the web host's bandwidth.

## Validation

```sh
npm run build
npm test
# Against the running app, optionally setting BASE_URL:
node scripts/smoke-stack.js
# Browser regression tests (install Chromium once on a development machine):
npx playwright install chromium
npm run test:browser
```

The HTTP and WebSocket suite checks enabled rooms without credentials, joins,
validation, same-origin access, room isolation, signaling, chat identity, capacity,
and cleanup. The browser suite checks decoded remote video and live audio tracks,
chat, camera/mic controls, leaving, rejoining, permission denial, responsive artwork,
and Phantom/MetaMask wallet approval against a local Solana RPC fixture. It starts its
own Node process with no external ICE or blockchain service. Set `BROWSER_BASE_URL` to test an
already running instance with `npm run test:browser -- e2e/video-room.spec.js e2e/design.spec.js`.
Wallet browser tests require the default local fixture and are skipped for an
external BROWSER_BASE_URL. To use installed Chromium in Codex Cloud, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.

## Token dashboard and rewards

`TOKEN_MINT` starts blank. The dashboard shows launch-pending status until an
actual verified Solana mint is configured. Then it polls DexScreener through the
server every 30 seconds and displays a Solana pair if one exists. This requires
outbound HTTPS to `api.dexscreener.com`. Data can be delayed or unavailable.
The `$JCQ` ticker alone is not a verified on-chain identifier.

The participation schedule is $2 CAD-value for verified breakfast attendance,
up to $5 for helpful or positive participation, and up to $10 for community
building. The highest approved tier per gathering applies; tiers do not stack.
This app supports direct, wallet-approved tips. It does not trade, mint tokens,
maintain custodial balances, or issue participation rewards. Reward distribution remains manual and inactive until the project has
published a working process. Crypto assets may lose all value.

## Privacy

- Camera and microphone start only after joining and browser permission. Leaving
  or losing the room connection stops the local tracks.
- Calls are not recorded by this app. Direct calling shares network route
  information with the other participants. Relayed media, chat, and membership
  pass through the app server. HTTPS protects those connections; the app server
  can access relayed media. No chat history is stored for later joins.
- Anyone with the room code can attempt to join. Share a fresh, hard-to-guess room
  invite privately. Accounts, moderation, and room passwords are not included.
- This project is not affiliated with, endorsed by, or sponsored by Juicy Couture
  or its owners.

## Optional environment variables

| Name | Purpose |
| --- | --- |
| `PORT` | HTTP/WebSocket port; defaults to 3000. |
| `COIN_NAME` | Display name; defaults to Juicy Couture Coin. |
| `COIN_SYMBOL` | Display ticker; defaults to JCQ. |
| `COIN_NETWORK` | Display chain; defaults to Solana. |
| `TOKEN_MINT` | Verified Solana mint; blank keeps launch-pending status. |
| `COMMUNITY_URL` | Official HTTPS community invite. |
| `MAX_ROOM_PARTICIPANTS` | Room limit from 2 to 12; defaults to 8. |
| `SOLANA_CLUSTER` | Solana mainnet-beta (default) or devnet for tipping. |
| `SOLANA_RPC_URL` | Optional HTTPS RPC provider override; defaults to the cluster public RPC. Keep provider credentials server-side. |
| `ICE_SERVERS` | Optional JSON array of browser ICE server definitions to improve direct routes. Defaults to `[]`; the built-in relay works without it. Any supplied credentials must be browser-safe and short-lived. |
