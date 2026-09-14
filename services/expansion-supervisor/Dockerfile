FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.15.8 --activate
COPY services/liquidator/package.json services/liquidator/pnpm-lock.yaml ./services/liquidator/
RUN cd services/liquidator && pnpm install --prod --frozen-lockfile
COPY services/borrower-alerts/package.json services/borrower-alerts/pnpm-lock.yaml ./services/borrower-alerts/
RUN corepack prepare pnpm@10.24.0 --activate
RUN cd services/borrower-alerts && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY services/liquidator/src ./services/liquidator/src
COPY services/risk-monitor/src ./services/risk-monitor/src
COPY services/borrower-alerts/src ./services/borrower-alerts/src
COPY services/expansion-supervisor/src ./services/expansion-supervisor/src
COPY shared ./shared
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node","services/expansion-supervisor/src/main.mjs"]
