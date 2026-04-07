FROM node:20-slim AS base
ARG CACHE_BUST=20260407a

# Install dependencies — all workspace deps go to root node_modules
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
RUN npm ci --workspace=packages/db --workspace=apps/api --include-workspace-root \
    && echo "npm ci OK"

# Build
FROM base AS builder
WORKDIR /app
ARG CACHE_BUST=20260407a
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# If zod isn't hoisted, ensure it's available for tsc
RUN node -e "require('zod')" 2>/dev/null || npm install zod --no-save
RUN rm -rf packages/db/dist apps/api/dist
RUN npx tsc --project packages/db/tsconfig.json
RUN npx tsc --project apps/api/tsconfig.json
RUN ls -la apps/api/dist/index.js && echo "Build OK"
# Replace workspace symlink with real copy (includes dist/ and drizzle/)
RUN rm -rf node_modules/@hl-copy/db && cp -r packages/db node_modules/@hl-copy/db
# Verify all critical files exist
RUN ls node_modules/@hl-copy/db/dist/index.js && echo "DB dist OK"
RUN ls node_modules/@hl-copy/db/drizzle/*.sql && echo "Migrations OK"

# Run — minimal image
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/start.mjs ./apps/api/start.mjs
# Copy root package.json but strip workspaces/scripts to prevent npm resolving missing workspaces
COPY --from=builder /app/package.json /tmp/pkg.json
RUN node -e "\
  const pkg = JSON.parse(require('fs').readFileSync('/tmp/pkg.json','utf8')); \
  delete pkg.workspaces; \
  delete pkg.scripts; \
  require('fs').writeFileSync('/app/package.json', JSON.stringify(pkg, null, 2));"
RUN echo "deploy-v8" > /tmp/.build-id

# Verify runner has all required files
RUN ls -la apps/api/dist/index.js && echo "1. API dist OK"
RUN ls -la node_modules/@hl-copy/db/dist/index.js && echo "2. DB dist OK"
RUN ls node_modules/@hl-copy/db/drizzle/*.sql && echo "3. Migrations OK"
RUN ls node_modules/@fastify/rate-limit/package.json && echo "4. rate-limit OK"
RUN ls node_modules/@fastify/cors/package.json && echo "5. cors OK"
RUN ls node_modules/fastify/package.json && echo "6. fastify OK"
RUN ls node_modules/dotenv/package.json && echo "7. dotenv OK"

# Test that Node can actually resolve and load the DB module
RUN node --input-type=module -e "import '@hl-copy/db'; console.log('8. DB module import OK')"

# Test that all major deps can be resolved
RUN node --input-type=module -e "\
  import 'fastify'; \
  import '@fastify/cors'; \
  import '@fastify/rate-limit'; \
  import 'dotenv'; \
  import 'drizzle-orm'; \
  import 'pg'; \
  console.log('9. All deps import OK');"

RUN node -e "console.log('Node OK, version:', process.version)"

EXPOSE 3001
CMD ["node", "apps/api/start.mjs"]
