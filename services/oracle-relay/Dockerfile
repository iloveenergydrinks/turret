# Build from the repository root; shares the keeper's pinned dependencies and transaction journal.
FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.15.8 --activate
COPY services/liquidator/package.json services/liquidator/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY services/liquidator/package.json ./services/liquidator/package.json
COPY services/liquidator/src ./services/liquidator/src
COPY services/oracle-relay/package.json ./services/oracle-relay/package.json
COPY services/oracle-relay/src ./services/oracle-relay/src
ENV NODE_ENV=production PORT=8080 ORACLE_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "services/oracle-relay/src/main.mjs"]
