import { Router } from 'express';
import * as uniboxController from '../controllers/uniboxController';
import { requireCapability } from '../middleware/requireCapability';

const router = Router();

router.get('/threads', uniboxController.listThreads);
router.get('/threads/:id', uniboxController.getThread);
router.post('/threads/:id/reply', requireCapability('reply_to_messages'), uniboxController.sendReply);
router.patch('/threads/:id', requireCapability('reply_to_messages'), uniboxController.updateThread);
router.patch('/threads/bulk', requireCapability('reply_to_messages'), uniboxController.bulkUpdateThreads);

export default router;
