# Juicy Couture Coin Live Hub

A Node app for the Juicy Couture Coin community: a Solana token dashboard,
participation reward information, and small-group video rooms with text chat.

Video uses the browser's built-in media support. The same Node process serves
the page, connects room members over WebSocket, and relays chat and media when
needed. **No video-service account, API keys, database, STUN/TURN service, or
separate media container is required.**

## Run locally

Requires Node.js 24.22 or newer (the retained community feed and reward store use built-in SQLite).

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

The cloud override mounts `CODEX_PROXY_CERT` during dependency installation and
as a read-only runtime trust certificate for outbound HTTPS. It does not store
that certificate in the image or disable TLS verification. To run a standalone image:

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
Render provides HTTPS and forwards the app's WebSocket endpoint. The Blueprint retains the existing paid Starter plan and 2 GB persistent disk for community photos and reward records; Docker retains the community-data volume. Video works
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
The default channel is public. Watch live joins with camera and microphone off;
Go live publishes and designates the room host.
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
This app supports direct, wallet-approved tips. It does not mint tokens or maintain custodial balances. Optional swaps and host-approved reward drops are described below. Reward distribution remains manual and inactive until the project has
published a working process. Crypto assets may lose all value.

## Approved jobs and token drops

Configure the public funding-wallet addresses in `REWARD_HOST_WALLETS` (comma-separated), the verified `TOKEN_MINT`, and a matching `SOLANA_CLUSTER`/RPC. These wallets are the only hosts allowed to create and approve drops. A connected authorized host sees the controls under **Rewards & drops**. The application never needs a host private key or seed phrase.

1. Create a gathering or approved-job drop with a unique event code, title, and the **host-entered CAD value per token**. This is an explicit valuation snapshot, not an exchange-rate oracle or a promise of market value.
2. Approve each recipient wallet and a reward tier, choosing a CAD amount up to that tier's cap. Approval automatically calculates and queues its token allocation using exact base units, rounding down rather than exceeding the approved CAD value. Approving a higher eligible tier replaces the previous allocation; amounts never stack for the same wallet and event code.
3. Review the token drop: full recipients, amounts, mint, network, valuation, and funding wallet. Only **Approve payout in wallet** signs the actual on-chain transfer. Hosting a job, clicking approve, viewing a stream, or posting a photo never automatically spends tokens.

Each drop supports up to five recipients in one atomic legacy SPL transaction. The host needs enough tokens and SOL for fees and any recipient-account creation. Only confirmed transactions mark rewards paid. Drop records and receipts persist in `drops.sqlite` on the same persistent volume as community posts. Pending or uncertain payments keep their signature and cannot be issued again, including after server restart. Use **Check payout status** to reconcile them. A prepared transaction that was never submitted can be reviewed again after its expiry and verified finalized block-height expiration; submitted or paid drops remain locked. Do not broadcast a prepared drop outside this application.

Job completion and real-world attendance remain verified by hosts. Automation covers allocation math, queuing, and receipt reconciliation; each payout still requires the host's wallet transaction approval. A token mint, approved funding hosts, funded wallets, and working RPC access are prerequisites for real drops. Automated tests simulate chain responses and send no real tokens.


## Community image feed

Connect a Solana wallet, choose a JPEG, PNG, or WebP image up to 5 MiB, and add a caption of up to 500 characters. Posting prompts for a domain-bound, expiring sign-in message. This signature proves authorship and does not transfer coins or charge SOL. Posts are public, persist in SQLite and the media directory, and can be deleted by their author. Refresh or load more to see other community posts. There is no public profile password or server-held wallet key.

The server verifies the signature, strips image metadata, resizes images to at most 2048 pixels, and stores sanitized WebP output. SVG and oversized images are rejected. Each wallet can create up to 10 posts per hour; deleting a post does not reset that limit. Storage is capped at 1 GiB of image data and 10,000 posts. Sessions expire after 24 hours and are cleared when the server restarts; posts remain. This is single-instance disk-backed storage; do not run multiple independent replicas against separate media folders. Back up the database and images together.


## Swap SOL and tokens

Set `JUPITER_API_KEY` securely on the server and use `SOLANA_CLUSTER=mainnet-beta` with a matching HTTPS RPC endpoint. Swaps call the official Jupiter `https://api.jup.ag/swap/v1` API. Permit `api.jup.ag` and your RPC host in outbound network settings; the public mainnet RPC host is `api.mainnet-beta.solana.com`. Managed environment proxy settings and inherited CA trust are respected. The API key and private RPC URL are never sent to browsers.

In **Exchange in your wallet**, select SOL, USDC, the configured project mint, or another standard SPL mint with a supported direct route. Choose an amount and slippage tolerance, then get a quote. Review the full mints, wallet, estimated and minimum receive amounts, slippage, and expiration before choosing **Approve swap in wallet**. Swaps exchange tokens within that same connected wallet, whether the user is a viewer or streamer; they do not pay another user's wallet. Live-room tips use the current host-designated receiving wallet. The legacy shared-wallet API remains available for compatible clients. No live room is required for swapping.

Only mainnet, exact-input swaps of standard SPL tokens with a verified direct route are supported. Token-2022, cross-chain swaps, unsupported instruction formats, and pairs without a verifiable route are rejected. Quotes last 30 seconds. The server binds every quote and transaction to its wallet, amounts, and mints, rejects altered signed transactions, and reports success only after confirmation. The app adds no swap fee; route fees and network fees still apply. If confirmation is uncertain, check the transaction signature before starting another swap. Automated tests use simulated Jupiter/RPC responses and do not move real funds.


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
| `MEDIA_DATA_DIR` | Persistent community media and reward database directory; use a persistent disk or Docker volume. |
| `JUPITER_API_KEY` | Optional server-only Jupiter key to enable retained swaps. |
| `REWARD_HOST_WALLETS` | Optional comma-separated public wallets authorized to approve/fund reward drops. |
| `STREAM_WALLET_ADDRESS` | Optional legacy shared-wallet API recipient. The main live-room UI uses the host-designated wallet. |
| `DEFAULT_LIVE_ROOM` | Default public channel; juicy-live unless overridden. |
| `ICE_SERVERS` | Optional JSON array of browser ICE server definitions to improve direct routes. Defaults to `[]`; the built-in relay works without it. Any supplied credentials must be browser-safe and short-lived. |
