FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/features/package.json ./packages/features/
COPY packages/channel-wechat/package.json ./packages/channel-wechat/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY apps/desktop/package.json ./apps/desktop/
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tests ./tests
COPY scripts ./scripts
RUN pnpm run build

FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build /app/packages/runtime/package.json ./packages/runtime/
COPY --from=build /app/packages/features/package.json ./packages/features/
COPY --from=build /app/packages/channel-wechat/package.json ./packages/channel-wechat/
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/web/package.json ./apps/web/
COPY --from=build /app/apps/desktop/package.json ./apps/desktop/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir=/tmp/pnpm-store && rm -rf /tmp/pnpm-store
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=build /app/packages/features/dist ./packages/features/dist
COPY --from=build /app/packages/channel-wechat/dist ./packages/channel-wechat/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_NO_WARNINGS=1
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
