import { Router } from 'express';
import * as validationController from '../controllers/validationController';

const router = Router();

// Upload
router.post('/upload', validationController.uploadLeads);
router.post('/upload/csv-raw', validationController.uploadCSVRaw);
router.post('/detect-columns', validationController.detectColumns);

// Batches
router.get('/batches', validationController.listBatches);
router.get('/batches/:id', validationController.getBatchDetail);

// Route leads to campaign
router.post('/batches/:id/route', validationController.routeLeadsToCampaign);

// Export
router.post('/batches/:id/export', validationController.exportCSV);

// Analytics
router.get('/analytics', validationController.getAnalytics);

export default router;
