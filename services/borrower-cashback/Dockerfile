FROM node:24.20.0-bookworm-slim
WORKDIR /app/services/borrower-cashback
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
COPY services/borrower-cashback/package.json services/borrower-cashback/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY services/borrower-cashback/src ./src
COPY shared/borrower-cashback.mjs /app/shared/borrower-cashback.mjs
ENV NODE_ENV=production CASHBACK_DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "src/server.mjs"]
