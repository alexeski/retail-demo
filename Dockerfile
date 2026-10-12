# syntax=docker/dockerfile:1

# Storeloom is a static Vite SPA: build it with Node, serve dist/ with nginx.
# There's no server-side code and no secrets — sign-in rides on the visitor's
# own ThoughtSpot browser session.

# ---- Build ----
# Vite 8 requires Node >= 20.19 / 22.12.
FROM node:22-alpine AS builder
WORKDIR /app

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

RUN npm run build

# ---- Run ----
# Unprivileged nginx: runs as a non-root user and listens on 3000 (Coolify's default "Ports Exposes").
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runner

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
