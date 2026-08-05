# syntax=docker/dockerfile:1
FROM node:24.11.0-alpine AS base
RUN apk add --no-cache dumb-init
RUN corepack enable pnpm
WORKDIR /app

# builder: toolchain de compilación (por si alguna dependencia transitiva
# trae bindings nativos) + build de TypeScript. Se descarta entero después
# de `pnpm prune` — nunca llega a runtime.
FROM base AS builder
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml ./
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
CMD ["node", "dist/main"]
