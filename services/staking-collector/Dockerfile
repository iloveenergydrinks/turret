FROM node:24-bookworm-slim
WORKDIR /app/services/staking-collector
COPY services/staking-collector/package.json services/staking-collector/npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/staking-collector/src ./src
COPY services/staking-collector/config ./config
COPY services/liquidator/src/store.mjs /app/services/liquidator/src/store.mjs
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node","src/main.mjs"]
