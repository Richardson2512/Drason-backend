# Environment Variables Setup Guide

Complete list of environment variables needed for Railway (backend) and Vercel (frontend).

---

## 🚂 Railway (Backend)

### Required Variables

#### Database
```bash
DATABASE_URL=postgresql://user:password@host:5432/dbname
# Railway auto-provides this when you add a PostgreSQL service
```

#### Authentication
```bash
JWT_SECRET=your_super_secret_jwt_key_min_32_characters_long
# Generate with: openssl rand -base64 32
```

#### Frontend Connection
```bash
FRONTEND_URL=https://your-app.vercel.app
# Your Vercel frontend URL (for CORS and checkout redirects)
```

#### Polar Payment Integration
```bash
# Polar API Access Token
POLAR_ACCESS_TOKEN=polar_oat_fu7yX57ZpBIDAqXE2PpFoxpNryBkLiZmNfDtH34JISO

# Polar Webhook Secret (for signature validation)
POLAR_WEBHOOK_SECRET=polar_whs_cDaCgENvOUZEzFk8CqBoxhR5FFz2EnVqWXkrG2Pwm9a

# Polar Product IDs (Subscription Tiers)
POLAR_STARTER_PRODUCT_ID=f82a3f93-14d5-49c6-b6cf-6bc0d8e6ca6c
POLAR_GROWTH_PRODUCT_ID=0690578b-2fe7-4e05-a2e2-a258a90599e9
POLAR_SCALE_PRODUCT_ID=edae6a6e-bfd2-4f24-9092-197021cf984d
```

#### Application Settings
```bash
NODE_ENV=production
LOG_LEVEL=info
PORT=3001
```

### Optional Variables

#### Redis (for rate limiting and caching)
```bash
REDIS_URL=redis://default:password@host:6379
# Only needed if you plan to use Redis
# Railway can auto-provide this if you add a Redis service
```

#### Smartlead Integration
```bash
# Not required at startup - users add this in settings UI
# But you can set a default for development:
DEFAULT_SMARTLEAD_API_KEY=your_smartlead_api_key
```

#### Clay Integration
```bash
# Not required - webhook ingestion works without API key
# Clay webhook URL is auto-generated at runtime
```

#### Development
```bash
# Only needed for local development without auth
DEFAULT_ORG_ID=your_test_org_uuid
```

---

## ▲ Vercel (Frontend)

### Required Variables

#### Backend API Connection
```bash
NEXT_PUBLIC_API_URL=https://your-backend.railway.app
# Your Railway backend URL
```

### Optional Variables

#### Analytics/Monitoring (if using)
```bash
NEXT_PUBLIC_ANALYTICS_ID=your_analytics_id
# Only if you're using analytics services
```

#### Feature Flags (if using)
```bash
NEXT_PUBLIC_ENABLE_FEATURE_X=true
# Only if you implement feature flags
```

---

## 📋 Setup Instructions

### Railway Setup (Backend)

1. **Go to Railway Dashboard**
   - Navigate to your project
   - Click on your backend service
   - Go to "Variables" tab

2. **Add Required Variables**
   ```bash
   # Copy these one by one:
   JWT_SECRET=<generate with: openssl rand -base64 32>
   FRONTEND_URL=https://your-app.vercel.app
   POLAR_ACCESS_TOKEN=polar_oat_fu7yX57ZpBIDAqXE2PpFoxpNryBkLiZmNfDtH34JISO
   POLAR_WEBHOOK_SECRET=polar_whs_cDaCgENvOUZEzFk8CqBoxhR5FFz2EnVqWXkrG2Pwm9a
   POLAR_STARTER_PRODUCT_ID=f82a3f93-14d5-49c6-b6cf-6bc0d8e6ca6c
   POLAR_GROWTH_PRODUCT_ID=0690578b-2fe7-4e05-a2e2-a258a90599e9
   POLAR_SCALE_PRODUCT_ID=edae6a6e-bfd2-4f24-9092-197021cf984d
   NODE_ENV=production
   LOG_LEVEL=info
   PORT=3001
   ```

3. **DATABASE_URL** is auto-provided by Railway PostgreSQL service

4. **Save** - Railway will auto-redeploy with new variables

### Vercel Setup (Frontend)

1. **Go to Vercel Dashboard**
   - Navigate to your project
   - Go to Settings → Environment Variables

2. **Add Required Variable**
   ```bash
   NEXT_PUBLIC_API_URL=https://your-backend.railway.app
   ```

3. **Apply to all environments** (Production, Preview, Development)

4. **Save** - Vercel will redeploy

---

## 🔐 Security Notes

### DO NOT Commit to Git
Never commit these files with real values:
- `.env`
- `.env.local`
- `.env.production`

### Keep Secret
These are sensitive and should never be shared:
- `JWT_SECRET`
- `POLAR_ACCESS_TOKEN`
- `POLAR_WEBHOOK_SECRET`
- `DATABASE_URL` (contains password)
- `REDIS_URL` (contains password)

### Can Be Public
These are safe to expose in frontend:
- `NEXT_PUBLIC_API_URL`
- Any `NEXT_PUBLIC_*` variables (they're bundled in client code)

---

## ✅ Verification Commands

### Check Backend Variables
```bash
# SSH into Railway or check logs
echo $DATABASE_URL
echo $JWT_SECRET
echo $POLAR_ACCESS_TOKEN
```

### Check Frontend Variables
```bash
# In browser console on your site
console.log(process.env.NEXT_PUBLIC_API_URL)
```

### Test Backend Connection
```bash
curl https://your-backend.railway.app/health
# Should return 200 OK
```

### Test Frontend → Backend
```bash
# Open your frontend
# Check Network tab in DevTools
# API calls should go to correct backend URL
```

---

## 🚨 Common Issues

### Backend can't connect to database
- ✅ Check DATABASE_URL is set
- ✅ Verify PostgreSQL service is running
- ✅ Check if DATABASE_URL format is correct

### Frontend can't reach backend
- ✅ Check NEXT_PUBLIC_API_URL is set
- ✅ Verify Railway backend is deployed and accessible
- ✅ Check CORS settings allow your frontend domain

### Polar webhooks failing
- ✅ Verify POLAR_WEBHOOK_SECRET matches Polar dashboard
- ✅ Check webhook URL is correct in Polar
- ✅ Ensure webhook endpoint is publicly accessible

### JWT authentication failing
- ✅ Verify JWT_SECRET is at least 32 characters
- ✅ Check same secret is used consistently
- ✅ Ensure cookies are being set correctly

---

## 📖 Quick Reference

### Generate JWT Secret
```bash
openssl rand -base64 32
```

### Get Railway Backend URL
```bash
# Railway Dashboard → Service → Settings → Domain
# Or check deployment logs
```

### Get Vercel Frontend URL
```bash
# Vercel Dashboard → Project → Domains
# Usually: your-app.vercel.app
```

---

## 🎯 Minimum Required Setup

To get the billing system working, you absolutely need:

**Railway:**
- ✅ DATABASE_URL (auto)
- ✅ JWT_SECRET
- ✅ FRONTEND_URL
- ✅ POLAR_ACCESS_TOKEN
- ✅ POLAR_WEBHOOK_SECRET
- ✅ POLAR_*_PRODUCT_ID (all 3 tiers)

**Vercel:**
- ✅ NEXT_PUBLIC_API_URL

Everything else is optional or can be added later!
