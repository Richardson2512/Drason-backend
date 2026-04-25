import { Router } from 'express';
import * as uniboxController from '../controllers/uniboxController';

const router = Router();

router.get('/threads', uniboxController.listThreads);
router.get('/threads/:id', uniboxController.getThread);
router.post('/threads/:id/reply', uniboxController.sendReply);
router.patch('/threads/:id', uniboxController.updateThread);
router.patch('/threads/bulk', uniboxController.bulkUpdateThreads);

export default router;
