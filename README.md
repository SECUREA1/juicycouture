# Juicy Couture Coin Live Hub

A Render-ready Node app for the **Juicy Couture Coin** community project. It includes a Solana token dashboard, the official participation reward schedule, and a small-group live video lounge with text chat.

## What it does

- Shows the project name, intended `$JCQ` ticker, Solana network, and configured mint address.
- Displays live market figures from DexScreener after you add the real Solana mint address.
- Offers a market-chart link only when market data returns a Solana pair.
- Publishes the participation schedule: $2 CAD-value for verified breakfast attendance, up to $5 for helpful or positive participation, and up to $10 for community-building. The highest eligible tier per approved gathering applies; tiers do not stack.
- Mints short-lived room access tokens on the server and uses LiveKit for browser video, audio, and in-room messages.
- Lets viewers connect Phantom or Solflare and approve voluntary token tips to the app's configured stream wallet while a room is live.
- Does not mint a token, make trades, hold wallet keys, or distribute participation rewards.

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

If LiveKit credentials are not set, the token dashboard still runs and the room explains that video setup is pending. The app never receives a wallet private key or seed phrase.

## Add the token after deployment

The app intentionally starts without a mint address. Once the real token is deployed and you have verified its Solana mint:

1. Open the Render service’s **Environment** settings.
2. Add `TOKEN_MINT` with the complete Solana mint address.
3. Optionally set `COMMUNITY_URL` to your official HTTPS community invite.
4. Save the changes and redeploy.

The dashboard then polls DexScreener through the server every 30 seconds. If no Solana pair exists, it continues to show launch-pending status. Price, FDV, liquidity, and volume may be delayed, incomplete, or unavailable.

## Local run

Requires Node.js 22.22 or newer (validated with 24.22.1) and a LiveKit Cloud project to enable video.

```sh
cp .env.example .env
# Put your settings in .env; never commit that file.
npm ci
npm run build
node --env-file=.env server.js
```

Do not source `.env.example` as a shell script; its display name contains spaces. `npm start` runs with environment variables already provided by the host.

`npm run build` bundles `client.js` and copies the root `index.html` and `styles.css` into the generated `public/` folder. Keep editing the root files, then rebuild; the server serves only generated public assets.

Open `http://localhost:3000`. Browser camera and microphone access requires HTTPS outside localhost. Join a room with a private room code and share its invite link only with people you want in the call. Room capacity defaults to 8 and can be set from 2 to 12 with `MAX_ROOM_PARTICIPANTS`.

## Send tokens during a stream

Configure `TOKEN_MINT` with the full address of an existing **standard Solana SPL token mint** and `STREAM_WALLET_ADDRESS` with the public receiving wallet address. All rooms pay this one app wallet. Restart after changing either setting. This feature does not create a currency or a wallet. Token-2022 mints are not supported.

Use `SOLANA_CLUSTER=devnet` with a devnet mint for testing, or `mainnet-beta` for real tokens. Optionally configure `SOLANA_RPC_URL` with a trusted HTTPS RPC provider for that same cluster. The endpoint stays on the server. Allow outbound access to that RPC host and your LiveKit host in your hosting environment. An RPC provider must support account lookups, recent blockhashes, transaction submission and confirmation. Mainnet tips move real tokens.

Join a live lounge, connect Phantom or Solflare, enter a token amount, and review the full destination, mint, and network. Choose **Send tokens**, then approve the transaction in your wallet. The sender needs the selected token and enough SOL for transaction fees and, if necessary, the receiving wallet's token account. The server checks LiveKit for an unmuted video publication before both preparing and submitting the transfer. A stream can end after submission; a broadcast blockchain transfer cannot be cancelled by this app.

Only the wallet signs. The server constructs a checked token transfer for the configured mint and recipient, rejects changes to the prepared transaction, and reports success only after confirmation. If confirmation is uncertain, check the displayed transaction signature before sending again. A confirmed tip does not represent a reward payment or an entry in an app balance. There is no fee deducted for the app.

Run `npm test` for payment validation and transaction tests. They use simulated chain and stream responses and never move funds. Real wallet, LiveKit, and RPC integration requires the settings above.

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
| `STREAM_WALLET_ADDRESS` | For tips | Public Solana wallet receiving tips for all rooms. Never enter a private key. |
| `SOLANA_CLUSTER` | No | `mainnet-beta` (default) or `devnet`. |
| `SOLANA_RPC_URL` | No | Server-only HTTPS RPC endpoint for the selected cluster. |
| `LIVEKIT_URL` | For video | LiveKit Cloud server URL. |
| `LIVEKIT_API_KEY` | For video | LiveKit server-side API key. |
| `LIVEKIT_API_SECRET` | For video | LiveKit server-side API secret. Keep secret. |
| `MAX_ROOM_PARTICIPANTS` | No | Room limit from 2 to 12; defaults to 8. |
| `COMMUNITY_URL` | No | Optional HTTPS community invite link. |

