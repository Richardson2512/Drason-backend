# Polar Payment Integration Setup Guide

Complete setup guide for integrating Polar.sh payment gateway with Superkabe.

## Prerequisites

1. ✅ Backend deployed and accessible (e.g., Railway)
2. ✅ Polar.sh account created
3. ✅ Products created in Polar (Starter, Growth, Scale)
4. ✅ Free trial enabled on all products

---

## Step 1: Configure Polar Webhook

### 1.1 Get Your Backend Webhook URL

Your webhook endpoint is:
```
https://YOUR-BACKEND-DOMAIN.up.railway.app/api/billing/polar-webhook
```

**Example:**
- Railway: `https://drason-backend-production.up.railway.app/api/billing/polar-webhook`
- Custom domain: `https://api.superkabe.com/api/billing/polar-webhook`

### 1.2 Create Webhook in Polar Dashboard

1. Go to **Polar Dashboard** → **Settings** → **Webhooks**
2. Click **Create Webhook**
3. Enter webhook URL: `https://YOUR-BACKEND-DOMAIN/api/billing/polar-webhook`
4. Select events to listen for:
   - ✅ `subscription.created`
   - ✅ `subscription.updated`
   - ✅ `subscription.canceled`
   - ✅ `invoice.paid`
   - ✅ `invoice.payment_failed`
5. Copy the **Webhook Secret** (starts with `polar_whs_`)
6. Save webhook

---

## Step 2: Get Polar API Key

1. Go to **Polar Dashboard** → **Settings** → **API Keys**
2. Click **Create API Key**
3. Name: `Superkabe Backend`
4. Select permissions:
   - ✅ `customers:read`
   - ✅ `customers:write`
   - ✅ `subscriptions:read`
   - ✅ `subscriptions:write`
   - ✅ `checkouts:write`
5. Copy the API key (starts with `polar_` or similar)
6. Save key securely

---

## Step 3: Add Environment Variables

### Railway Deployment

1. Go to your Railway project
2. Click on your backend service
3. Go to **Variables** tab
4. Add the following variables:

```bash
POLAR_ACCESS_TOKEN=your_polar_api_key_here
POLAR_WEBHOOK_SECRET=polar_whs_cDaCgENvOUZEzFk8CqBoxhR5FFz2EnVqWXkrG2Pwm9a
POLAR_STARTER_PRODUCT_ID=f82a3f93-14d5-49c6-b6cf-6bc0d8e6ca6c
POLAR_GROWTH_PRODUCT_ID=0690578b-2fe7-4e05-a2e2-a258a90599e9
POLAR_SCALE_PRODUCT_ID=edae6a6e-bfd2-4f24-9092-197021cf984d
FRONTEND_URL=https://your-frontend-domain.vercel.app
```

5. Click **Deploy** to restart with new variables

### Local Development

1. Copy `.env.example` to `.env`
2. Fill in the Polar values:

```bash
cp .env.example .env
# Edit .env with your actual values
```

---

## Step 4: Test Webhook

### 4.1 Test Webhook Delivery

1. In Polar Dashboard → Webhooks → Your Webhook
2. Click **Send Test Event**
3. Select event type: `subscription.created`
4. Send test event

### 4.2 Check Backend Logs

Check Railway logs for:
```
[BILLING] Webhook processed successfully
```

If you see errors:
- ❌ `Invalid signature` → Check POLAR_WEBHOOK_SECRET matches
- ❌ `Missing organization_id` → Test event may not have metadata (normal for test events)

---

## Step 5: Run Database Backfill

Initialize existing organizations with trial status:

```bash
# SSH into your Railway container
railway run npm run backfill-subscriptions

# Or run locally
npm run backfill-subscriptions
```

This script:
- Sets `subscription_tier = 'trial'`
- Sets `subscription_status = 'trialing'` or `'expired'`
- Calculates `trial_ends_at` (14 days from org creation)

---

## Step 6: Verify Integration

### Test Checkout Flow

1. Sign up for a new account (gets 14-day trial automatically)
2. Go to Settings → Billing
3. Click "Upgrade to Growth"
4. Should redirect to Polar checkout page
5. Complete payment (use Polar test card if in test mode)
6. Webhook fires → subscription activates
7. Check Settings → subscription should show "Active"

### Test Feature Gates

1. Try creating more leads than tier limit
2. Should see: `403 - Lead limit reached. Upgrade to add more.`

### Test Trial Expiration

1. In database, set `trial_ends_at` to past date
2. Wait for trial worker to run (runs hourly)
3. Organization should be marked as `expired`
4. Accessing protected routes should return 403

---

## Troubleshooting

### Webhook Not Firing

1. Check webhook URL is publicly accessible
2. Verify webhook is enabled in Polar
3. Check Railway logs for incoming requests
4. Test with `curl`:
   ```bash
   curl -X POST https://your-backend.up.railway.app/api/billing/polar-webhook \
     -H "Content-Type: application/json" \
     -d '{"type": "test"}'
   ```

### Signature Validation Fails

- Ensure `POLAR_WEBHOOK_SECRET` exactly matches Polar dashboard
- Check for extra spaces or newlines in environment variable
- Webhook secret format: `polar_whs_...`

### Checkout Creation Fails

- Verify `POLAR_ACCESS_TOKEN` is set and valid
- Check API key has correct permissions
- Verify product IDs are correct (must match Polar dashboard)
- Check `FRONTEND_URL` is set for redirect URLs

### Trial Not Initializing

- Run database migration: `npx prisma migrate deploy`
- Verify Prisma client was regenerated: `npx prisma generate`
- Check auth controller is creating orgs with trial fields

---

## API Endpoints

### Get Subscription Status
```bash
GET /api/billing/subscription
Authorization: Bearer <jwt>

Response:
{
  "subscription": {
    "tier": "trial",
    "status": "trialing",
    "trialEndsAt": "2026-03-02T00:00:00Z"
  },
  "usage": {
    "leads": 150,
    "domains": 1,
    "mailboxes": 5
  },
  "limits": {
    "leads": 10000,
    "domains": 3,
    "mailboxes": 15
  }
}
```

### Create Checkout
```bash
POST /api/billing/create-checkout
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "tier": "growth"
}

Response:
{
  "checkoutUrl": "https://checkout.polar.sh/...",
  "checkoutId": "..."
}
```

### Cancel Subscription
```bash
POST /api/billing/cancel
Authorization: Bearer <jwt>

Response:
{
  "message": "Subscription canceled. Access will continue until the end of your billing period."
}
```

---

## Monitoring

### Key Metrics to Watch

1. **Webhook Success Rate**
   - Check audit logs for failed webhook processing
   - Monitor `SubscriptionEvent` table for gaps

2. **Trial Conversion Rate**
   - Query: Organizations that upgraded vs expired trials

3. **Feature Gate Blocks**
   - Check logs for `[FEATURE-GATE]` entries
   - Monitor 403 responses on capacity checks

4. **Usage Tracking Accuracy**
   - Compare `current_*_count` fields vs actual counts
   - Run periodic reconciliation

---

## Security Notes

🔒 **Webhook Security:**
- All webhooks are HMAC-SHA256 validated
- Invalid signatures are rejected with 401
- Idempotency prevents duplicate processing

🔒 **API Key Security:**
- Never commit `.env` files
- Rotate keys if compromised
- Use Railway's encrypted environment variables

🔒 **Feature Gates:**
- Applied at middleware level (can't bypass)
- Checks both subscription status AND capacity
- Logs all blocked attempts for audit

---

## Support

- **Backend Issues**: Check Railway logs
- **Polar Issues**: Contact Polar support or check their docs
- **Integration Help**: Review this guide and backend code comments
