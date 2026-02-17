# Debugging "Failed to Get Subscription Status" Error

## Problem
User gets "failed to get subscription status" error when viewing billing page.

## Root Cause Analysis

The error is coming from the **production backend on Railway**. Here are the possible causes:

### 1. Railway Hasn't Deployed Latest Changes ⚠️
**Most Likely Issue**

The latest commit with tier limit changes was pushed, but Railway might still be deploying or failed to deploy.

**How to Check:**
1. Go to [Railway Dashboard](https://railway.app)
2. Find your backend service
3. Check the "Deployments" tab
4. Look for commit `3901f99` ("feat(billing): update TIER_LIMITS to new capacity model")
5. Check if it says "Success" or "Failed"

**If deployment failed:**
- Click on the failed deployment
- Check the logs for errors
- Common issues:
  - TypeScript compilation errors
  - Missing environment variables
  - Database connection issues

### 2. Backend Error in getSubscriptionStatus Endpoint

The endpoint `/api/billing/subscription` might be throwing an error.

**How to Check Railway Logs:**
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# View logs
railway logs --service backend
```

**What to look for:**
```
[BILLING] Failed to get subscription status
```

### 3. Missing Subscription Fields in Production Database

Your trial account might not have subscription fields populated in the production database.

**How to Fix:**
1. SSH into Railway or use Railway CLI
2. Run the fix script:
```bash
railway run npx ts-node scripts/fix_trial_subscriptions.ts
```

### 4. CORS or Authentication Issue

Frontend might not be sending the auth token correctly.

**How to Check Browser DevTools:**
1. Open your site
2. Press F12 → Network tab
3. Try loading billing page
4. Find the request to `/api/billing/subscription`
5. Check:
   - Status code (should be 200, not 401, 403, or 500)
   - Request headers (should include `Cookie` with auth token)
   - Response body (what's the error message?)

## Quick Fix Steps

### Step 1: Check Railway Deployment
```bash
# Check if latest commit deployed
git log --oneline -1
# Should show: 3901f99 feat(billing): update TIER_LIMITS to new capacity model

# Go to Railway dashboard and verify deployment status
```

### Step 2: Check Backend Logs
```bash
# Install Railway CLI if not installed
npm install -g @railway/cli

# Login
railway login

# View logs (look for errors)
railway logs --service backend
```

### Step 3: Test API Directly
```bash
# Replace with your Railway backend URL
export BACKEND_URL="https://your-backend.railway.app"
export AUTH_TOKEN="your_jwt_token_from_browser_cookies"

# Test subscription endpoint
curl -X GET "$BACKEND_URL/api/billing/subscription" \
  -H "Cookie: token=$AUTH_TOKEN" \
  -v
```

### Step 4: Fix Subscription Fields (if needed)
```bash
# Connect to Railway database and run fix script
railway run npx ts-node scripts/fix_trial_subscriptions.ts
```

## Expected Response

A successful API response should look like:
```json
{
  "subscription": {
    "tier": "trial",
    "status": "trialing",
    "trialStartedAt": "2025-02-15T...",
    "trialEndsAt": "2025-03-01T...",
    "subscriptionStartedAt": null,
    "nextBillingDate": null
  },
  "usage": {
    "leads": 0,
    "domains": 0,
    "mailboxes": 0
  },
  "limits": {
    "leads": 10000,
    "domains": 20,
    "mailboxes": 75
  }
}
```

## Common Errors and Solutions

### Error: "Organization not found"
**Solution:** Check if your organization ID in the JWT token matches the database.

### Error: "Database connection failed"
**Solution:** Check `DATABASE_URL` in Railway environment variables.

### Error: "Cannot read properties of null"
**Solution:** Run the fix script to populate subscription fields.

### Error: 401 Unauthorized
**Solution:** JWT token might be expired. Log out and log back in.

### Error: 500 Internal Server Error
**Solution:** Check Railway logs for the specific error.

## Next Steps

1. ✅ Check Railway deployment status FIRST
2. ✅ View Railway logs to see the exact error
3. ✅ Test the API endpoint directly with curl
4. ✅ Run fix script if needed
5. ✅ Report back with error details if still stuck

## Contact Support

If none of these steps work, gather:
1. Railway deployment logs
2. Browser Network tab screenshot
3. curl test results
4. Error message from frontend

This will help diagnose the exact issue.
