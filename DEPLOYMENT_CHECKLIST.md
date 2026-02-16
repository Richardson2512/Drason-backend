# Polar Billing Integration - Deployment Checklist

## ✅ Completed Implementation

All code has been written, committed, and pushed to the repositories:

### Backend (Drason-backend)
- ✅ Prisma schema with subscription fields
- ✅ Polar API client service
- ✅ Billing service with webhook processing
- ✅ Trial expiration worker (hourly cron)
- ✅ Billing controller and routes
- ✅ Feature gate middleware
- ✅ Capacity checks in lead ingestion and Smartlead sync
- ✅ Trial initialization in auth controller
- ✅ Usage tracking for leads, domains, mailboxes

### Frontend (Drason)
- ✅ BillingSection component with:
  - Current plan display
  - Usage metrics with progress bars
  - Upgrade options
  - Checkout flow
  - Subscription cancellation
- ✅ Trial countdown banner in dashboard layout
- ✅ Dynamic pricing page CTAs
- ✅ Authentication-aware routing

---

## 🚀 Deployment Steps

### Step 1: Configure Railway Environment Variables

Add these environment variables to your Railway backend project:

```bash
# Polar Access Token (API authentication)
POLAR_ACCESS_TOKEN=polar_oat_fu7yX57ZpBIDAqXE2PpFoxpNryBkLiZmNfDtH34JISO

# Polar Webhook Secret (for signature validation)
POLAR_WEBHOOK_SECRET=polar_whs_cDaCgENvOUZEzFk8CqBoxhR5FFz2EnVqWXkrG2Pwm9a

# Polar Product IDs (subscription tiers)
POLAR_STARTER_PRODUCT_ID=f82a3f93-14d5-49c6-b6cf-6bc0d8e6ca6c
POLAR_GROWTH_PRODUCT_ID=0690578b-2fe7-4e05-a2e2-a258a90599e9
POLAR_SCALE_PRODUCT_ID=edae6a6e-bfd2-4f24-9092-197021cf984d

# Frontend URL (for checkout redirects)
FRONTEND_URL=https://your-frontend-domain.vercel.app
```

**How to add in Railway:**
1. Go to your Railway project
2. Click on your backend service
3. Go to "Variables" tab
4. Add each variable with its value
5. Railway will automatically redeploy

---

### Step 2: Configure Polar Webhook

Your backend webhook endpoint is:
```
https://your-backend-domain.railway.app/api/billing/polar-webhook
```

**Setup in Polar Dashboard:**
1. Go to https://polar.sh/dashboard
2. Navigate to Settings → Webhooks
3. Click "Add Webhook"
4. Enter your webhook URL above
5. Select events to receive:
   - ✅ subscription.created
   - ✅ subscription.updated
   - ✅ subscription.canceled
   - ✅ invoice.paid
   - ✅ invoice.payment_failed
6. Webhook secret is already configured (you provided it)
7. Save webhook

---

### Step 3: Run Database Migration

The migration file already exists. To apply it:

```bash
cd backend
npx prisma migrate deploy
npx prisma generate
```

This will:
- Add subscription fields to Organization table
- Create SubscriptionEvent table
- Update usage tracking columns

---

### Step 4: Backfill Existing Organizations

Run the backfill script to initialize trial status for existing organizations:

```bash
cd backend
npx ts-node scripts/backfillSubscriptions.ts
```

This script:
- Sets all existing orgs to trial status
- Initializes 14-day trial period
- Sets trial_started_at and trial_ends_at
- Initializes usage counts to 0

**Expected Output:**
```
✅ Backfilled 5 organizations with trial status
```

---

### Step 5: Verify Deployment

1. **Check Backend Health**
   ```bash
   curl https://your-backend-domain.railway.app/api/health
   ```

2. **Verify Trial Worker Started**
   - Check Railway logs for: "Trial expiration worker started (runs hourly)"

3. **Test Billing Endpoint**
   ```bash
   curl -X GET https://your-backend-domain.railway.app/api/billing/subscription \
     -H "Authorization: Bearer YOUR_JWT_TOKEN"
   ```

4. **Check Frontend**
   - Visit https://your-frontend-domain.vercel.app/dashboard/settings
   - Verify BillingSection appears with trial status
   - Check trial countdown banner appears (if < 7 days remaining)

---

### Step 6: Test Checkout Flow

1. **From Settings Page:**
   - Navigate to Dashboard → Settings
   - Scroll to Billing Section
   - Click "Upgrade to Growth"
   - Should redirect to Polar checkout

2. **From Pricing Page (Logged In):**
   - Navigate to /pricing
   - Click "Get started" on any tier
   - Should redirect to Settings with `?upgrade=<tier>`

3. **From Pricing Page (Logged Out):**
   - Open /pricing in incognito
   - Click "Get started"
   - Should redirect to /signup with `?plan=<tier>`

4. **Complete Test Purchase:**
   - Use Polar test mode
   - Complete a checkout
   - Verify webhook fires
   - Check subscription_status becomes 'active'
   - Verify trial ends

---

### Step 7: Test Feature Gates

1. **Lead Capacity:**
   ```bash
   # Create a test org at capacity (set current_lead_count = 10000 for trial)
   # Try to ingest a lead
   curl -X POST https://your-backend-domain.railway.app/api/leads \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -d '{"email": "test@example.com", "persona": "decision_maker", "lead_score": 85, "workable": true}'
   # Expected: 403 error with upgrade_required: true
   ```

2. **Domain/Mailbox Capacity:**
   - Trigger Smartlead sync when at capacity
   - Verify capacity warnings in logs
   - Verify sync continues but skips new resources

3. **Trial Expiration:**
   - Set trial_ends_at to past date
   - Try to ingest leads
   - Expected: 403 error "subscription required"

---

### Step 8: Monitor Logs

Watch Railway logs for:
- Trial worker runs (every hour)
- Webhook events received
- Capacity warnings
- Checkout completions
- Subscription activations

```bash
# Railway CLI (if installed)
railway logs -s backend
```

---

## 📋 Feature Verification Checklist

- [ ] Environment variables added to Railway
- [ ] Polar webhook configured and receiving events
- [ ] Database migration applied
- [ ] Backfill script executed successfully
- [ ] Trial countdown banner appears for users with < 7 days
- [ ] BillingSection displays current plan and usage
- [ ] Pricing page CTAs redirect correctly (logged in vs out)
- [ ] Checkout flow completes and webhook processes
- [ ] Feature gates block at capacity
- [ ] Trial worker logs appear every hour
- [ ] Usage counts increment correctly
- [ ] Subscription upgrades work end-to-end

---

## 🐛 Troubleshooting

### Webhook Not Receiving Events
- Verify webhook URL is correct in Polar dashboard
- Check webhook secret matches POLAR_WEBHOOK_SECRET
- Verify backend is deployed and accessible
- Check Railway logs for incoming requests

### Feature Gates Not Blocking
- Verify migration applied (check database schema)
- Check current usage counts are accurate
- Run refreshUsageCounts endpoint manually
- Verify TIER_LIMITS are correct in polarClient.ts

### Trial Worker Not Running
- Check backend logs for startup message
- Verify no errors in trial worker initialization
- Trigger manual check via direct function call

### Checkout Not Completing
- Verify FRONTEND_URL is set correctly
- Check Polar product IDs match your dashboard
- Ensure Polar access token has correct permissions
- Test with Polar test mode first

---

## 📞 Support Resources

- **Polar Documentation**: https://docs.polar.sh
- **Prisma Migrations**: https://www.prisma.io/docs/concepts/components/prisma-migrate
- **Backend Logs**: Railway Dashboard → Service → Logs
- **Database Access**: Railway Dashboard → Service → Database → Data

---

## 🎉 Post-Deployment

Once all checks pass:
1. Test with a real user signup
2. Monitor first week for trial expirations
3. Track conversion rates from trial to paid
4. Set up alerts for webhook failures
5. Monitor usage count accuracy

**Your billing system is now live!** 🚀
