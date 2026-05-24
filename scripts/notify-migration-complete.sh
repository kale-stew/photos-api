#!/bin/bash
# Monitor migration progress and notify when complete
# Usage: ./scripts/notify-migration-complete.sh &

TOTAL=573
LOG_FILE="/tmp/photos-migration.log"
CHECK_INTERVAL=60  # seconds

echo "Monitoring migration progress (target: $TOTAL photos)..."
echo "Will check every $CHECK_INTERVAL seconds and notify when complete."
echo ""

while true; do
  # Check if migration process is still running
  if ! pgrep -f "from-notion.ts" > /dev/null; then
    echo "Migration process has stopped."
    
    # Get final count
    COUNT=$(cd /Users/kski/Developer/photos-api && npx wrangler d1 execute photos-db --remote --command="SELECT COUNT(*) as count FROM photos" 2>/dev/null | grep -A2 '"count"' | grep -o '[0-9]*' | head -1)
    
    # macOS notification
    osascript -e "display notification \"Migration complete! $COUNT/$TOTAL photos migrated.\" with title \"Photos API Migration\" sound name \"Glass\""
    
    # Also speak it
    say "Photos migration complete. $COUNT of $TOTAL photos migrated."
    
    echo ""
    echo "=== Migration Complete ==="
    echo "Photos migrated: $COUNT / $TOTAL"
    echo ""
    echo "Next steps:"
    echo "  1. npm run migrate:climb-links"
    echo "  2. npm run generate:blurhash"
    echo ""
    echo "See TODO.md for full checklist."
    
    break
  fi
  
  # Get current count
  COUNT=$(cd /Users/kski/Developer/photos-api && npx wrangler d1 execute photos-db --remote --command="SELECT COUNT(*) as count FROM photos" 2>/dev/null | grep -A2 '"count"' | grep -o '[0-9]*' | head -1)
  
  # Get last processed photo from log
  LAST=$(tail -1 "$LOG_FILE" 2>/dev/null | head -c 60)
  
  echo "[$(date +%H:%M:%S)] Progress: $COUNT / $TOTAL - $LAST"
  
  sleep $CHECK_INTERVAL
done
