#!/bin/bash
# Setup script for photos-api development environment
# Creates wrangler.local.jsonc with your Cloudflare credentials

set -e

WRANGLER_LOCAL="wrangler.local.jsonc"
WRANGLER_EXAMPLE="wrangler.local.jsonc.example"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}photos-api setup${NC}"
echo "================"
echo ""

# Check if wrangler.local.jsonc already exists
if [ -f "$WRANGLER_LOCAL" ]; then
    echo -e "${YELLOW}$WRANGLER_LOCAL already exists.${NC}"
    read -p "Overwrite? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing file."
        exit 0
    fi
fi

# Get account ID
echo -e "${GREEN}Enter your Cloudflare Account ID:${NC}"
echo "(Find it at: https://dash.cloudflare.com → Overview → Account ID)"
read -p "> " ACCOUNT_ID

if [ -z "$ACCOUNT_ID" ]; then
    echo -e "${RED}Account ID is required.${NC}"
    exit 1
fi

# Get D1 database ID
echo ""
echo -e "${GREEN}Enter your D1 Database ID:${NC}"
echo "(Find it at: https://dash.cloudflare.com → Workers & Pages → D1)"
echo "(Or run: wrangler d1 list)"
read -p "> " DATABASE_ID

if [ -z "$DATABASE_ID" ]; then
    echo -e "${RED}Database ID is required.${NC}"
    exit 1
fi

# Create wrangler.local.jsonc
cat > "$WRANGLER_LOCAL" << EOF
{
  // Local overrides - this file is gitignored
  "account_id": "$ACCOUNT_ID",
  
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "photos-db",
      "database_id": "$DATABASE_ID",
      "migrations_dir": "migrations"
    }
  ]
}
EOF

echo ""
echo -e "${GREEN}Created $WRANGLER_LOCAL${NC}"
echo ""

# Optional: Cloudflare Access settings
echo -e "${YELLOW}Optional: Configure Cloudflare Access JWT verification${NC}"
echo "(Leave blank to skip - you can add these later as secrets)"
echo ""
read -p "CF_ACCESS_TEAM_DOMAIN (e.g., your-team.cloudflareaccess.com): " TEAM_DOMAIN
read -p "CF_ACCESS_AUD (application audience tag): " AUD

if [ -n "$TEAM_DOMAIN" ] && [ -n "$AUD" ]; then
    echo ""
    echo "To set these as secrets, run:"
    echo -e "${GREEN}  wrangler secret put CF_ACCESS_TEAM_DOMAIN${NC}"
    echo -e "${GREEN}  wrangler secret put CF_ACCESS_AUD${NC}"
fi

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. npm install"
echo "  2. npm run db:migrate:local   # Set up local D1"
echo "  3. npm run dev                # Start dev server"
echo ""
