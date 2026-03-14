#!/bin/bash
set -e

echo "═══════════════════════════════════════════════════════"
echo "  HL Copy Trading — Cloud Setup"
echo "═══════════════════════════════════════════════════════"
echo ""

# Check prerequisites
check_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "❌ $1 is not installed."
    echo "   Install: $2"
    exit 1
  fi
  echo "✓ $1 found"
}

echo "Checking prerequisites..."
check_cmd "gh" "brew install gh"
check_cmd "railway" "npm install -g @railway/cli"
check_cmd "vercel" "npm install -g vercel"
echo ""

# Step 1: Push to GitHub
echo "─── Step 1: GitHub Repository ───"
if ! gh repo view &> /dev/null; then
  echo "Creating GitHub repo..."
  gh repo create hl-copy-trading --private --source=. --push
else
  echo "✓ GitHub repo exists"
  git push origin main 2>/dev/null || true
fi
echo ""

# Step 2: Deploy frontend to Vercel
echo "─── Step 2: Deploy Frontend to Vercel ───"
echo "This will open Vercel to connect your repo."
echo ""
echo "Set these env vars in Vercel dashboard:"
echo "  NEXT_PUBLIC_API_URL = (set after Railway deploy)"
echo "  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = (from cloud.walletconnect.com)"
echo ""
echo "Root Directory: apps/web"
echo ""
read -p "Press Enter to deploy to Vercel..."
cd apps/web && vercel --prod && cd ../..
echo ""

# Step 3: Deploy API to Railway
echo "─── Step 3: Deploy API to Railway ───"
echo "This will create a Railway project for the API."
echo ""
echo "Set these env vars in Railway dashboard:"
echo "  DATABASE_URL = (from Neon)"
echo "  REDIS_URL = (from Upstash)"
echo "  FRONTEND_URL = (your Vercel URL)"
echo "  PORT = 3001"
echo ""
read -p "Press Enter to deploy API to Railway..."
railway init --name hl-copy-api
railway link
railway up --service api --dockerfile apps/api/Dockerfile
echo ""

# Step 4: Deploy Worker to Railway
echo "─── Step 4: Deploy Worker to Railway ───"
echo ""
echo "Set these env vars in Railway dashboard:"
echo "  DATABASE_URL = (same as API)"
echo "  REDIS_URL = (same as API)"
echo "  HEALTH_PORT = 3002"
echo ""
read -p "Press Enter to deploy Worker to Railway..."
railway up --service worker --dockerfile apps/worker/Dockerfile
echo ""

echo "═══════════════════════════════════════════════════════"
echo "  ✓ Deployment complete!"
echo ""
echo "  Next steps:"
echo "  1. Go to Vercel dashboard → set NEXT_PUBLIC_API_URL"
echo "     to your Railway API URL"
echo "  2. Run database migrations:"
echo "     DATABASE_URL=your_neon_url npm run db:migrate"
echo "  3. Visit your Vercel URL!"
echo "═══════════════════════════════════════════════════════"
