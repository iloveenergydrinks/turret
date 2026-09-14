FROM node:24-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
COPY services/borrower-alerts/package.json services/borrower-alerts/pnpm-lock.yaml ./services/borrower-alerts/
RUN cd services/borrower-alerts && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY services/borrower-alerts/src ./services/borrower-alerts/src
COPY shared ./shared
COPY frontend/app/public/p2p-markets.json ./config/p2p-markets.json
WORKDIR /app/services/borrower-alerts
ENV NODE_ENV=production
CMD ["node", "src/server.mjs"]
