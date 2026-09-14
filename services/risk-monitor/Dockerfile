FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.15.8 --activate
COPY services/liquidator/package.json services/liquidator/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY services/liquidator/package.json ./services/liquidator/package.json
COPY services/liquidator/src ./services/liquidator/src
COPY services/risk-monitor/package.json ./services/risk-monitor/package.json
COPY services/risk-monitor/src ./services/risk-monitor/src
ENV NODE_ENV=production PORT=8080 RISK_DATA_DIR=/data
EXPOSE 8080
CMD ["node","services/risk-monitor/src/main.mjs"]
