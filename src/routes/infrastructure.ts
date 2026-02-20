import { Router } from 'express';
import * as dashboardController from '../controllers/dashboardController';

const router = Router();

// Mailbox management
router.post('/mailbox/resume', dashboardController.resumeMailbox);

// Domain management
router.post('/domain/resume', dashboardController.resumeDomain);

export default router;
