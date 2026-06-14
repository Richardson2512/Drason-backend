import { Router } from 'express';
import * as validationController from '../controllers/validationController';
import { requireCapability } from '../middleware/requireCapability';

const router = Router();

// Upload - bringing leads into the workspace is gated by add_leads. detect-columns
// is a stateless preview helper for the upload UX; leave open.
router.post('/upload', requireCapability('add_leads'), validationController.uploadLeads);
router.post('/upload/csv-raw', requireCapability('add_leads'), validationController.uploadCSVRaw);
router.post('/detect-columns', validationController.detectColumns);

// Batches (read-only listing)
router.get('/batches', validationController.listBatches);
router.get('/batches/:id', validationController.getBatchDetail);

// Route leads to a campaign - touches campaign sequence membership.
router.post('/batches/:id/route', requireCapability('edit_sequences'), validationController.routeLeadsToCampaign);

// Export - read-only data export of leads the user already has access to. Open.
router.post('/batches/:id/export', validationController.exportCSV);

// Analytics
router.get('/analytics', validationController.getAnalytics);

export default router;
