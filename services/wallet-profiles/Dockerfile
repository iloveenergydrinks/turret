FROM node:24-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
COPY services/wallet-profiles/package.json services/wallet-profiles/pnpm-lock.yaml ./services/wallet-profiles/
RUN cd services/wallet-profiles && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY services/wallet-profiles/src ./services/wallet-profiles/src
COPY shared/wallet-avatar.mjs ./shared/wallet-avatar.mjs
COPY shared/rpc-fallback.mjs ./shared/rpc-fallback.mjs
WORKDIR /app/services/wallet-profiles
ENV NODE_ENV=production
EXPOSE 3031
CMD ["node", "src/server.mjs"]
