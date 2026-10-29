# Mergeport hub. Build context is the repository root:  docker build -f hub/Dockerfile .
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Only the hub's four runtime packages (hub/package.json), not the app's tree. No install scripts: better-sqlite3 ships prebuilt.
COPY hub/package.json ./package.json
RUN npm install --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY hub ./hub
COPY src/lib/db/migrate.ts ./src/lib/db/migrate.ts

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production MERGEPORT_HUB_DATA=/data MERGEPORT_HUB_BIND_HOST=0.0.0.0 MERGEPORT_HUB_PORT=8787
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "hub/src/main.ts"]
