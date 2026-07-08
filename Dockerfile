# NOTE(vettd-scanner-suite#12): this image is one service in the local
# Compose deployment (compose.yaml). It is NOT yet the deferred single-image
# bundle — that image would additionally vendor the shim binaries into this
# same image instead of running them as separate containers.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8080
# Config is supplied at runtime (compose mounts deploy/scanner-suite.docker.toml
# here) rather than baked in — scanner-suite.toml is gitignored/environment-
# specific, matching how the suite already expects a config path argument.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js", "/config/scanner-suite.toml"]
