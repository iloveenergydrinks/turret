FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.15.8 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
ENV NODE_ENV=production PORT=8080 KEEPER_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "src/main.mjs"]
