FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app/services/buyback-worker
COPY services/buyback-worker/package.json services/buyback-worker/npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/buyback-worker/src ./src
COPY services/buyback-worker/config ./config
COPY services/liquidator/src/store.mjs /app/services/liquidator/src/store.mjs
COPY frontend/app/src/borrow/collateral-swap.mjs /app/frontend/app/src/borrow/collateral-swap.mjs
# Shared validation resolves the same pinned viem dependency.
RUN mkdir -p /app/frontend/app && ln -s /app/services/buyback-worker/node_modules /app/frontend/app/node_modules
ENV NODE_ENV=production PORT=8080 BUYBACK_MODE=observe
EXPOSE 8080
CMD ["node","src/main.mjs"]
