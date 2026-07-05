/**
 * Mint a short-lived (1h) support session token for a user - identical payload
 * to authController login (tokenService.generateToken), so every middleware
 * accepts it. Requires the PROD JWT secret (Railway -> backend service ->
 * Variables -> JWT_SECRET). The secret never leaves your machine.
 *
 * Usage:
 *   set PROD_DB_URL=postgres://...
 *   set JWT_SECRET=<from Railway>
 *   node scripts/mint_support_session.js seo@authority.inc
 *
 * Then: open https://app.superkabe.com -> DevTools -> Application -> Cookies ->
 * add cookie  name: token  value: <printed token>  -> refresh /dashboard.
 */
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const email = process.argv[2];
if (!email) { console.error('usage: node scripts/mint_support_session.js <user-email>'); process.exit(1); }
if (!process.env.JWT_SECRET) { console.error('JWT_SECRET env var required (Railway -> Variables)'); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url: process.env.PROD_DB_URL } } });

(async () => {
  try {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, role: true, organization_id: true, account_id: true, is_agency_owner: true, scoped_organization_id: true },
    });
    if (!user) { console.error('No user found for', email); process.exit(1); }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        orgId: user.organization_id,
        accountId: user.account_id ?? null,
        activeOrganizationId: user.organization_id,
        isAgencyOwner: !!user.is_agency_owner,
        scopedOrganizationId: user.scoped_organization_id ?? null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }, // support session: short-lived on purpose
    );
    console.log('\n1-hour support session token for', user.email, '\n');
    console.log(token);
    console.log('\nSet as cookie "token" on https://app.superkabe.com (DevTools -> Application -> Cookies), then open /dashboard.');
  } catch (e) { console.error('ERR', e.message); process.exit(1); }
  finally { await prisma.$disconnect(); }
})();
