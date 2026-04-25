/**
 * API Key Management Routes
 *
 * CRUD for API keys used by external integrations and MCP server.
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as apiKeyController from '../controllers/apiKeyController';

const router = Router();

router.get('/', asyncHandler(apiKeyController.listApiKeys));
router.post('/', asyncHandler(apiKeyController.createApiKey));
router.delete('/:id', asyncHandler(apiKeyController.revokeApiKey));
router.get('/scopes', asyncHandler(apiKeyController.getAvailableScopes));

export default router;
