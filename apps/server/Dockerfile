# syntax=docker/dockerfile:1
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.runtime.json ./
COPY src ./src
RUN pnpm run build:runtime

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=8080
WORKDIR /app
COPY package.json ./
COPY --from=builder /app/dist/runtime ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/src/index.js"]
