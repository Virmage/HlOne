#!/bin/bash
# Deploy API to Railway with automatic cache busting
# Usage: ./deploy.sh

set -e

# Update cache bust timestamp in Dockerfile
TIMESTAMP=$(date +%s)
sed -i '' "s/cache bust by changing this comment on each deploy: [0-9]*/cache bust by changing this comment on each deploy: $TIMESTAMP/" apps/api/Dockerfile

echo "Cache bust timestamp: $TIMESTAMP"
echo "Deploying to Railway..."

npx @railway/cli up "$@"
