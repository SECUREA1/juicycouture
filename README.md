# Juicy Couture Coin Live Hub

A Render-ready Node app for the **Juicy Couture Coin** community project. It includes a Solana token dashboard, the official participation reward schedule, and a small-group live video lounge with text chat.

## What it does

- Shows the project name, intended `$JCQ` ticker, Solana network, and configured mint address.
- Displays live market figures from DexScreener after you add the real Solana mint address.
- Offers a market-chart link only when market data returns a Solana pair.
- Publishes the participation schedule: $2 CAD-value for verified breakfast attendance, up to $5 for helpful or positive participation, and up to $10 for community-building. The highest eligible tier per approved gathering applies; tiers do not stack.
- Mints short-lived room access tokens on the server and uses LiveKit for browser video, audio, and in-room messages.
- Does not connect a wallet, make trades, mint a token, track balances, or distribute rewards.

The ticker is a project choice, not a unique on-chain identifier. Do not use `$JCQ` as a verified token until the token has been deployed and its full mint address has been published.

## Deploy on Render

Render runs the web app and token endpoint. **LiveKit Cloud carries the live audio/video**, so create a LiveKit project before deploying if you want the room enabled.

1. Create a LiveKit Cloud project and copy its server URL, API key, and API secret. Keep the API secret private.
2. Unzip this project and push the folder contents to a new GitHub repository. Keep `render.yaml` at the repository root.
3. In Render, choose **New → Blueprint**, connect that repository, and apply the Blueprint.
4. When prompted, enter the three LiveKit values:
   - `LIVEKIT_URL` (usually starts with `wss://`)
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
5. Wait for the Render deploy to finish, then open the generated `onrender.com` URL. Use `/healthz` to confirm the web process is responding.

If LiveKit credentials are not set, the token dashboard still runs and the room explains that video setup is pending. Render never receives a wallet key or token-holder data.

## Add the token after deployment

The app intentionally starts without a mint address. Once the real token is deployed and you have verified its Solana mint:

1. Open the Render service’s **Environment** settings.
2. Add `TOKEN_MINT` with the complete Solana mint address.
3. Optionally set `COMMUNITY_URL` to your official HTTPS community invite.
4. Save the changes and redeploy.

The dashboard then polls DexScreener through the server every 30 seconds. If no Solana pair exists, it continues to show launch-pending status. Price, FDV, liquidity, and volume may be delayed, incomplete, or unavailable.

## Local run

Requires Node.js 20 or newer and a LiveKit Cloud project to enable video.

```sh
npm ci
npm run build
# Create .env only if you do not already have one:
cp -n .env.example .env
# Optional: enter LiveKit Cloud credentials in .env.
node --env-file=.env server.js
```

Do not source `.env` as a shell script: display names may contain spaces.

## Docker development (including live video)

```sh
docker compose up --build -d
# Check startup and application readiness:
docker compose ps
docker compose logs web livekit
# Stop when finished:
docker compose down
```

Compose starts the web app on port 3000 and a local LiveKit development server
on port 7880, with TCP media on 7881 and UDP media on 7882. Access the app from
the same machine as Docker. The browser uses `ws://localhost:7880`; the app uses
`LIVEKIT_INTERNAL_URL=http://livekit:7880` for server-to-server room management.
The public dev key is for local testing only. Ports bind to loopback deliberately.
For remote/production use, deploy LiveKit with TLS, real credentials, and reachable
media addresses/ports (or use LiveKit Cloud). Set `LIVEKIT_URL` to its public WSS
URL and omit `LIVEKIT_INTERNAL_URL` unless you need a separate internal endpoint.
Never publish the development LiveKit service to the Internet.

For this managed cloud environment, supply the platform CA during the build:

```sh
docker compose -f compose.yaml -f compose.cloud.yaml up --build -d
```

The optional build secret extends npm trust only during installation; it is not
stored in the image. Ordinary Docker installations can use `compose.yaml` alone.

## Standalone production image

```sh
docker build -t juicy-live .
docker run --rm --init -p 3000:3000 --env-file .env juicy-live
```

The image includes all built page assets, runs as a non-root user, and checks
`/healthz`. Supply LiveKit Cloud credentials through runtime variables for video.
`TOKEN_MINT` remains optional; market data needs an actual verified Solana mint
and outbound access to `api.dexscreener.com`. No token or rewards are created by setup.

## Validation

```sh
npm run build
npm test
# With the local Compose stack running:
node scripts/smoke-stack.js
```

The smoke test starts the real server and checks the homepage, CSS, JavaScript,
health, config, market-pending state, and unconfigured-video response.


Open `http://localhost:3000`. Browser camera and microphone access requires HTTPS outside localhost. Join a room with a private room code and share its invite link only with people you want in the call. Room capacity defaults to 8 and can be set from 2 to 12 with `MAX_ROOM_PARTICIPANTS`.

## Privacy and launch notes

- Video and audio are not recorded by this app. Live media is handled by the configured LiveKit service; review its project settings and terms before inviting users.
- Anyone with a room invite can attempt to join. Use a fresh, hard-to-guess room code for private gatherings; this starter does not include accounts, moderation tools, or room passwords.
- LiveKit API secrets stay server-side. The browser receives a room-scoped token that expires after 15 minutes.
- The app is not affiliated with, endorsed by, or sponsored by Juicy Couture or its owners.
- Crypto assets can lose all value. Market displays and participation rewards are not an investment promise. Reward payouts remain manual and inactive until the project establishes and publishes a working distribution process.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `COIN_NAME` | No | Display name; defaults to Juicy Couture Coin. |
| `COIN_SYMBOL` | No | Display symbol; defaults to JCQ. |
| `COIN_NETWORK` | No | Display chain; defaults to Solana. |
| `TOKEN_MINT` | No | Verified Solana mint; blank keeps launch-pending status. |
| `LIVEKIT_URL` | For video | LiveKit Cloud server URL. |
| `LIVEKIT_INTERNAL_URL` | No | Server-only LiveKit HTTP endpoint; defaults to the public URL. |
| `LIVEKIT_API_KEY` | For video | LiveKit server-side API key. |
| `LIVEKIT_API_SECRET` | For video | LiveKit server-side API secret. Keep secret. |
| `MAX_ROOM_PARTICIPANTS` | No | Room limit from 2 to 12; defaults to 8. |
| `COMMUNITY_URL` | No | Optional HTTPS community invite link. |

