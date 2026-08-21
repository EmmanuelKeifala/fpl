FROM node:22.19.0-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    FPL_DB_PATH=/app/data/fpl.db \
    FPL_SESSION_FILE=/app/data/fpl-session.json \
    FPL_HEALTH_PATH=/app/data/runner-health.json \
    FPL_RUNNER_LOCK_PATH=/app/data/fpl-runner.lock \
    FPL_MUTATION_LOCK_PATH=/app/data/fpl-mutation.lock \
    FPL_DB_LOCK_PATH=/app/data/fpl.db.lock \
    FPL_EMERGENCY_STOP_FILE=/app/data/EMERGENCY_STOP \
    FPL_ML_MODEL_PATH=/app/artifacts/ml/player-fixture-v1/model.json \
    FPL_ML_FEATURE_DIRECTORY=/app/data/live/player-fixture-features-v1 \
    FPL_ML_FEATURE_SCRIPT=/app/scripts/ml/live_features.py \
    FPL_LLM_CACHE_DIR=/app/data/llm-cache

RUN apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=5 update \
    && apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=5 install --no-install-recommends -y ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/ml ./scripts/ml
COPY --chown=node:node artifacts/ml ./artifacts/ml

RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["sh", "-c", "node dist/scheduler/preflight.js --require-shadow && exec node dist/scheduler/runner.js"]
