#!/bin/bash
# Apply Prisma Migrations to Railway Production Database
#
# This script applies all pending migrations including the new clay_webhook_secret column.
# Run this after the latest code has been deployed to Railway.

echo "🚀 Applying Prisma migrations to production database..."
echo ""

npx prisma migrate deploy

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Migrations applied successfully!"
    echo ""
    echo "The following changes were applied:"
    echo "  - Added clay_webhook_secret column to Organization table"
    echo ""
    echo "🎉 Your billing page and settings should now work correctly!"
else
    echo ""
    echo "❌ Migration failed. Check the error above."
    exit 1
fi
