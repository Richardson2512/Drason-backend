import { Router } from 'express';
import * as dashboardController from '../controllers/dashboardController';
import { requireCapability } from '../middleware/requireCapability';

const router = Router();

// Mailbox management — clearing a paused mailbox is a state mutation that
// should require the same capability as connecting one.
router.post('/mailbox/resume', requireCapability('connect_mailboxes'), dashboardController.resumeMailbox);

// Domain management
router.post('/domain/resume', requireCapability('connect_domains'), dashboardController.resumeDomain);

export default router;
