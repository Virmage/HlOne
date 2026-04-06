FROM node:20-alpine AS base

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
RUN npm ci --workspace=packages/db --workspace=apps/api --include-workspace-root

# Build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Build timestamp: 2026-04-06T20:10 — change to bust cache
COPY . .
# Clean stale dist and compile fresh
RUN rm -rf packages/db/dist apps/api/dist
RUN npx tsc --project packages/db/tsconfig.json
RUN npx tsc --project apps/api/tsconfig.json
RUN echo "Build complete" && ls apps/api/dist/index.js

# Run
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/package.json ./package.json
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
