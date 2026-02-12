import { Router } from 'express';
import * as leadController from '../controllers/leadController';
import { validateBody, ingestLeadSchema } from '../middleware/validation';

const router = Router();

router.post('/', validateBody(ingestLeadSchema), leadController.ingestLead);

export default router;
