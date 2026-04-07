FROM node:20-alpine AS base

# Install dependencies — all workspace deps go to root node_modules
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
RUN npm ci --workspace=packages/db --workspace=apps/api --include-workspace-root \
    && npm ls zod --workspace=apps/api 2>/dev/null || true

# Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# If zod isn't hoisted, ensure it's available for tsc
RUN node -e "require('zod')" 2>/dev/null || npm install zod --no-save
RUN rm -rf packages/db/dist apps/api/dist
RUN npx tsc --project packages/db/tsconfig.json
RUN npx tsc --project apps/api/tsconfig.json
RUN ls -la apps/api/dist/index.js && echo "Build OK"
RUN rm -rf node_modules/@hl-copy/db && cp -r packages/db node_modules/@hl-copy/db

# Run — minimal image
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/package.json ./package.json
RUN echo "deploy-v4" > /tmp/.build-id
EXPOSE 3001
CMD node apps/api/dist/index.js
