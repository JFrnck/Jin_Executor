# syntax=docker/dockerfile:1
FROM node:24.11.0-alpine AS base
RUN apk add --no-cache dumb-init
RUN corepack enable pnpm
WORKDIR /app

# builder: toolchain de compilación (por si alguna dependencia transitiva
# trae bindings nativos) + build de TypeScript. Se descarta entero después
# de `pnpm prune` — nunca llega a runtime.
FROM base AS builder
# `nest build` puede agotar el heap por defecto de Node (~2GB en un contenedor
# de 4GB). Solo afecta a este stage; runtime no compila nada.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build
RUN pnpm prune --prod

# runtime: sin toolchain de compilación, usuario no-root, dumb-init como
# PID 1 (Nest deja child processes huérfanos sin él).
FROM node:24.11.0-alpine AS runtime
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
# `nest build` emite dist/src/main.js, no dist/main.js: tsconfig.json no fija
# rootDir y hay .ts en la raíz (vitest.config.ts, ...), así que el root común
# es ./ y la salida queda un nivel más abajo. Verificado sobre la imagen
# publicada del 2026-08-06 (STATUS_DEPLOY.md, Jin_Docs).
CMD ["node", "dist/src/main"]
