import { Router } from 'express';
import * as dashboardController from '../controllers/dashboardController';
import { requireCapability } from '../middleware/requireCapability';
import { protectionConfigRateLimit } from '../middleware/rateLimitPerOrg';

const router = Router();

// Mailbox management - clearing a paused mailbox is a state mutation that
// should require the same capability as connecting one. Rate-limited via
// protectionConfigRateLimit (3/min/org) for Super Protect R3-SP2 -
// operator-driven resume should be rare; >3/min is scripted abuse.
router.post('/mailbox/resume', requireCapability('connect_mailboxes'), protectionConfigRateLimit, dashboardController.resumeMailbox);

// Domain management - same rate limit reasoning. R3-SP2.
router.post('/domain/resume', requireCapability('connect_domains'), protectionConfigRateLimit, dashboardController.resumeDomain);

export default router;
