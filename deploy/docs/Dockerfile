FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node scripts/serve-gitbook.mjs ./scripts/serve-gitbook.mjs
COPY --chown=node:node docs/gitbook ./docs/gitbook
USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node", "scripts/serve-gitbook.mjs"]
