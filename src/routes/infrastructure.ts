import { Router } from 'express';
import * as dashboardController from '../controllers/dashboardController';
import { requireCapability } from '../middleware/requireCapability';
import { protectionConfigRateLimit } from '../middleware/rateLimitPerOrg';

const router = Router();

// Mailbox management - clearing a paused mailbox is a state mutation that
// should require the same capability as connecting one.
router.post('/mailbox/resume', requireCapability('connect_mailboxes'), protectionConfigRateLimit, dashboardController.resumeMailbox);

// Domain management
router.post('/domain/resume', requireCapability('connect_domains'), protectionConfigRateLimit, dashboardController.resumeDomain);

export default router;
