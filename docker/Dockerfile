# Multi-stage build: compile backend + frontend (matching upstream's CI),
# then package a minimal runtime. Keeps the fork's self-contained GHCR
# image without depending on the npm @modbus2mqtt/server package.

# ---- stage 1: build ----
FROM node:22-alpine AS build
WORKDIR /src

RUN apk add --no-cache git jq
RUN corepack enable

# Layer-cache friendly: copy manifests first
COPY package.json pnpm-lock.yaml .npmrc .nvmrc ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN cd backend && pnpm install --frozen-lockfile --ignore-scripts
RUN cd frontend && pnpm install --frozen-lockfile --ignore-scripts

# Source
COPY . .

# Shamefully hoist for the backend's flat node_modules layout
RUN pnpm run build

# ---- stage 2: runtime ----
FROM node:22-alpine
WORKDIR /app

COPY --from=build /src/dist /app/dist
COPY --from=build /src/docker/rootfs /app/rootfs
COPY --from=build /src/backend/node_modules /app/node_modules
COPY --from=build /src/package.json /app/package.json

ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -q --tries=1 -O /dev/null http://127.0.0.1:3000/index.html || exit 1

EXPOSE 3000 3443

CMD ["node", "dist/server/modbus2mqtt.js"]
