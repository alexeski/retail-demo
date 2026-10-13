# syntax=docker/dockerfile:1

# Storeloom: a Vite single-page app plus a small Express server (server/) that
# signs users in with ThoughtSpot trusted authentication and relays ThoughtSpot
# REST calls with their token. The server runs as TypeScript directly (Node 24
# strips types natively), so only the client needs a build.

FROM node:24-alpine AS base
WORKDIR /app

# ---- Build ----
FROM base AS builder
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Inlined into the client bundle by `vite build`, so they must be set at build
# time (Coolify: tick "Build Variable?"). None are secret — a host URL and
# Liveboard GUIDs are visible in the browser anyway. Left unset, the defaults
# in src/thoughtspot.ts apply.
ARG VITE_TS_HOST
ARG VITE_INSIGHTS_LIVEBOARD_ID
ARG VITE_REGION_LIVEBOARD_ID
ENV VITE_TS_HOST=$VITE_TS_HOST \
    VITE_INSIGHTS_LIVEBOARD_ID=$VITE_INSIGHTS_LIVEBOARD_ID \
    VITE_REGION_LIVEBOARD_ID=$VITE_REGION_LIVEBOARD_ID

# Type-checks the app and the server, then builds the client into dist/.
RUN npm run build

# ---- Run ----
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY server ./server

# THOUGHTSPOT_SECRET_KEY / THOUGHTSPOT_ORG_ID (and the optional
# THOUGHTSPOT_REGISTER_USERNAME / THOUGHTSPOT_HOST) are read by the server at
# runtime. They're secrets or server settings: supply them as Coolify runtime
# environment variables, never as build args (they'd stay in the image history).
# The server falls back to VITE_TS_HOST for the cluster URL, so pass that at
# runtime too if you changed it.

USER node
# Port 3000 matches Coolify's default "Ports Exposes".
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server/index.ts"]
