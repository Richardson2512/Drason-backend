import { Router } from 'express';
import * as authController from '../controllers/authController';
import { validateBody, loginSchema, registerSchema } from '../middleware/validation';

const router = Router();

router.post('/login', validateBody(loginSchema), authController.login);
router.post('/register', validateBody(registerSchema), authController.register);

export default router;
