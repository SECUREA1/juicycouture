# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional cloud proxy CA: never retained in the image.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY feed-client.js swap-client.js drops-client.js browser-globals.js crown.svg ./
COPY sections-client.js ticker-client.js experience-client.js app-experience.css ./
COPY client.js wallet-ui.js transactions.js amounts.js index.html styles.css audio-worklet.js coin-medallion.jpeg juicy-banner.jpeg ./
COPY assets ./assets
RUN npm run build && npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 MEDIA_DATA_DIR=/var/data/community
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node package.json server.js rooms.js payments.js transactions.js amounts.js tips.js swaps.js feed.js drops.js network.js ./
RUN mkdir -p /var/data/community && chown -R node:node /var/data
VOLUME ["/var/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
