/**
 * Agency Routes
 *
 * Phase 1 — read-only endpoints for the workspaces feature. These power the
 * fleet overview, sidebar workspace switcher, and workspace detail page on
 * the frontend, replacing the localStorage mock with real data.
 *
 * Mutations (create/rename/delete/invite/etc.) come in Phase 2.
 */

import { Router } from 'express';
import * as agencyController from '../controllers/agencyController';
import * as inviteController from '../controllers/inviteController';

const router = Router();

// List all workspaces visible to the requesting user.
router.get('/workspaces', agencyController.listWorkspaces);

// Single workspace detail by ID.
router.get('/workspaces/:id', agencyController.getWorkspace);

// Aggregate stats across visible workspaces.
router.get('/fleet-stats', agencyController.getFleetStats);

// Create a new workspace under the requesting agency owner's Account.
router.post('/workspaces', agencyController.createWorkspace);

// Rename / re-brand a workspace (name, slug, client company).
router.patch('/workspaces/:id', agencyController.updateWorkspace);

// Delete a workspace (cascade-deletes child resources). Seed workspace blocked.
router.delete('/workspaces/:id', agencyController.deleteWorkspace);

// Re-issue JWT scoped to a different workspace (agency owners only; clients
// are JWT-locked to their scoped_organization_id).
router.post('/switch-workspace', agencyController.switchWorkspace);

// Create a workspace invite — agency-owner only. Sends the magic-link email.
router.post('/workspaces/:id/invites', inviteController.createWorkspaceInvite);

export default router;
