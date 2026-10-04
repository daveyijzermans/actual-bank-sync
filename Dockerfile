FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries; its build script needs no run.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data
VOLUME /data
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s \
  CMD node -e "process.exit(Date.now() - require('fs').statSync('/tmp/actual-bank-sync.alive').mtimeMs > 120000 ? 1 : 0)"
CMD ["node", "src/main.js"]
