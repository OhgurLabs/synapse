FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/

FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN npm prune --production

COPY --from=builder /app/src ./src

RUN useradd --create-home --shell /bin/bash --uid 1000 synapse \
    && mkdir -p /data \
    && chown -R synapse:synapse /app /data

USER synapse

ENV NODE_ENV=production \
    SYNAPSE_SERVER_PORT=8080 \
    SYNAPSE_PROJECT_DIR=/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

ENTRYPOINT ["node", "src/orchestrator.js"]
