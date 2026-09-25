FROM node:22-alpine AS dependencies

WORKDIR /app

# Pin the repository's pnpm version so image builds remain reproducible when
# Corepack's default changes.
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node lib ./lib
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

CMD ["node", "server.js"]
