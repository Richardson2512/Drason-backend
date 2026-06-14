import { Router } from 'express';
import * as connectedAccountController from '../controllers/connectedAccountController';
import * as oauthConnectController from '../controllers/oauthConnectController';
import * as infraProvidersController from '../controllers/infraProvidersController';
import * as campaignController2 from '../controllers/campaignController2';
import * as templateController from '../controllers/templateController';
import * as templateFolderController from '../controllers/templateFolderController';
import * as mailboxImportController from '../controllers/mailboxImportController';
import * as tagController from '../controllers/tagController';
import * as contactController from '../controllers/contactController';
import * as sequencerSettingsController from '../controllers/sequencerSettingsController';
import * as sequencerAnalyticsController from '../controllers/sequencerAnalyticsController';
import * as signatureController from '../controllers/signatureController';
import * as recipientPreviewController from '../controllers/recipientPreviewController';
import * as zapmailController from '../controllers/zapmailController';
import { requireCapability, requireAgencyOwner } from '../middleware/requireCapability';

const router = Router();

// --- Connected Accounts (mailboxes) ---
const accountRoutes = Router();
accountRoutes.get('/', connectedAccountController.listAccounts);
accountRoutes.post('/', requireCapability('connect_mailboxes'), connectedAccountController.createAccount);
accountRoutes.post('/bulk', requireCapability('connect_mailboxes'), connectedAccountController.bulkCreateAccounts);
accountRoutes.delete('/:id', requireCapability('connect_mailboxes'), connectedAccountController.deleteAccount);
accountRoutes.patch('/:id', requireCapability('connect_mailboxes'), connectedAccountController.updateAccount);
accountRoutes.post('/:id/test', requireCapability('connect_mailboxes'), connectedAccountController.testConnection);
accountRoutes.get('/tracking-domain/check', connectedAccountController.checkTrackingDomainEndpoint);
accountRoutes.post('/:id/tracking-domain', requireCapability('connect_domains'), connectedAccountController.setTrackingDomain);
accountRoutes.post('/:id/tracking-domain/verify', requireCapability('connect_domains'), connectedAccountController.verifyTrackingDomain);

// OAuth flows (Google + Microsoft) - mailbox connection is gated; the OAuth
// dance itself MUST stay open because the callback URL is hit by the OAuth
// provider, not the user. The capability check happens at the persist step
// (createAccount above is what the callback ultimately calls).
accountRoutes.get('/google/authorize', requireCapability('connect_mailboxes'), oauthConnectController.googleAuthorize);
accountRoutes.get('/google/callback', oauthConnectController.googleCallback);
accountRoutes.get('/microsoft/authorize', requireCapability('connect_mailboxes'), oauthConnectController.microsoftAuthorize);
accountRoutes.get('/microsoft/callback', oauthConnectController.microsoftCallback);

router.use('/accounts', accountRoutes);

// --- Campaigns ---
const campaignRoutes = Router();
campaignRoutes.get('/', campaignController2.listCampaigns);
// Lead-picker for the suppression modal - MUST come before `/:id` so the
// literal path doesn't get captured as an id parameter.
campaignRoutes.get('/lead-picker', campaignController2.listLeadsForSuppression);
campaignRoutes.get('/:id', campaignController2.getCampaign);
campaignRoutes.get('/:id/leads', campaignController2.listCampaignLeads);
campaignRoutes.get('/:id/suppression', campaignController2.getCampaignSuppression);
campaignRoutes.post('/', requireCapability('create_campaigns'), campaignController2.createCampaign);
campaignRoutes.patch('/:id', requireCapability('edit_sequences'), campaignController2.updateCampaign);
campaignRoutes.delete('/:id', requireCapability('create_campaigns'), campaignController2.deleteCampaign);
campaignRoutes.post('/:id/launch', requireCapability('launch_pause_campaigns'), campaignController2.launchCampaign);
campaignRoutes.post('/:id/pause', requireCapability('launch_pause_campaigns'), campaignController2.pauseCampaign);
campaignRoutes.post('/:id/resume', requireCapability('launch_pause_campaigns'), campaignController2.resumeCampaign);
// Tags. bulk-tag must come BEFORE /:id/tags so Express doesn't treat
// 'bulk-tag' as a campaign id. Distinct method+path so they don't collide.
campaignRoutes.post('/bulk-tag', requireCapability('edit_sequences'), campaignController2.bulkTagCampaigns);
campaignRoutes.put('/:id/tags', requireCapability('edit_sequences'), campaignController2.setCampaignTags);
router.use('/campaigns', campaignRoutes);

// --- Templates ---
const templateRoutes = Router();
templateRoutes.get('/categories', templateController.listCategories);
templateRoutes.get('/', templateController.listTemplates);
templateRoutes.get('/:id', templateController.getTemplate);
templateRoutes.post('/', requireCapability('edit_sequences'), templateController.createTemplate);
templateRoutes.patch('/:id', requireCapability('edit_sequences'), templateController.updateTemplate);
templateRoutes.delete('/:id', requireCapability('edit_sequences'), templateController.deleteTemplate);
templateRoutes.post('/:id/duplicate', requireCapability('edit_sequences'), templateController.duplicateTemplate);
router.use('/templates', templateRoutes);

// --- Mailbox Import (Zapmail / Premium Inboxes / Mission Inbox / Scaled Mail) ---
// Provider-agnostic bulk import - no Google OAuth scopes required for the
// mailboxes themselves. See controllers/mailboxImportController.ts.
const mailboxImportRoutes = Router();
mailboxImportRoutes.get('/providers', mailboxImportController.listProviders);
mailboxImportRoutes.post('/:provider/connect', requireCapability('access_integrations'), mailboxImportController.connectProvider);
mailboxImportRoutes.post('/:provider/disconnect', requireCapability('access_integrations'), mailboxImportController.disconnectProvider);
mailboxImportRoutes.get('/:provider/mailboxes', mailboxImportController.listProviderMailboxes);
mailboxImportRoutes.post('/:provider/import', requireCapability('connect_mailboxes'), mailboxImportController.bulkImport);
router.use('/mailbox-import', mailboxImportRoutes);

// --- Template Folders ---
const templateFolderRoutes = Router();
templateFolderRoutes.get('/', templateFolderController.listFolders);
templateFolderRoutes.post('/', requireCapability('edit_sequences'), templateFolderController.createFolder);
templateFolderRoutes.patch('/:id', requireCapability('edit_sequences'), templateFolderController.renameFolder);
templateFolderRoutes.delete('/:id', requireCapability('edit_sequences'), templateFolderController.deleteFolder);
router.use('/template-folders', templateFolderRoutes);

// --- Infrastructure Providers (for bulk mailbox import) ---
router.get('/infra-providers', infraProvidersController.listInfraProviders);

// --- Zapmail integration (server-orchestrated OAuth via Zapmail Custom OAuth) ---
const zapmailRoutes = Router();
zapmailRoutes.get('/status', zapmailController.status);
zapmailRoutes.post('/connect', requireCapability('access_integrations'), zapmailController.connect);
zapmailRoutes.delete('/connect', requireCapability('access_integrations'), zapmailController.disconnect);
zapmailRoutes.get('/mailboxes', zapmailController.listMailboxes);
zapmailRoutes.post('/import', requireCapability('connect_mailboxes'), zapmailController.importMailboxes);
zapmailRoutes.get('/import/:exportId', zapmailController.importStatus);
router.use('/integrations/zapmail', zapmailRoutes);

// --- Contacts (= leads in the data model) ---
const contactRoutes = Router();
contactRoutes.get('/', contactController.listContacts);
contactRoutes.get('/facets', contactController.getContactFacets);
contactRoutes.post('/', requireCapability('add_leads'), contactController.createContact);
contactRoutes.post('/bulk', requireCapability('add_leads'), contactController.bulkCreateContacts);
contactRoutes.post('/delete', requireCapability('remove_leads'), contactController.deleteContacts);
contactRoutes.post('/validate', requireCapability('add_leads'), contactController.validateContacts);
contactRoutes.post('/validate-preview', contactController.validateLeadsPreview);
contactRoutes.post('/assign-campaign/preview', contactController.previewAssignToCampaign);
contactRoutes.post('/assign-campaign', requireCapability('edit_sequences'), contactController.assignToCampaign);
contactRoutes.get('/export', contactController.exportContacts);
contactRoutes.get('/:id', contactController.getContact);
contactRoutes.patch('/:id/notes', requireCapability('edit_sequences'), contactController.updateContactNotes);
contactRoutes.patch('/:id', requireCapability('edit_sequences'), contactController.updateContactDetails);
contactRoutes.put('/:id/tags', requireCapability('edit_sequences'), contactController.setContactTags);
contactRoutes.post('/bulk-tag', requireCapability('edit_sequences'), contactController.bulkTagContacts);
router.use('/contacts', contactRoutes);

// --- Tags ---
const tagRoutes = Router();
tagRoutes.get('/', tagController.listTags);
tagRoutes.post('/', requireCapability('edit_sequences'), tagController.createTag);
tagRoutes.patch('/:id', requireCapability('edit_sequences'), tagController.updateTag);
tagRoutes.delete('/:id', requireCapability('edit_sequences'), tagController.deleteTag);
router.use('/tags', tagRoutes);

// --- Settings ---
// Sequencer settings are workspace-wide knobs (default sending hours,
// throttle, etc.) - agency owners only. Clients shouldn't be reaching here
// even with edit_sequences; that capability is for content (campaigns/templates).
const settingsRoutes = Router();
settingsRoutes.get('/', sequencerSettingsController.getSettings);
settingsRoutes.patch('/', requireAgencyOwner, sequencerSettingsController.updateSettings);
router.use('/settings', settingsRoutes);

// --- Signatures ---
const signatureRoutes = Router();
signatureRoutes.get('/', signatureController.listSignatures);
signatureRoutes.post('/', requireCapability('edit_sequences'), signatureController.createSignature);
signatureRoutes.patch('/:id', requireCapability('edit_sequences'), signatureController.updateSignature);
signatureRoutes.delete('/:id', requireCapability('edit_sequences'), signatureController.deleteSignature);
router.use('/signatures', signatureRoutes);

// --- Analytics ---
const analyticsRoutes = Router();
analyticsRoutes.get('/', sequencerAnalyticsController.getOverview);
analyticsRoutes.get('/campaigns', sequencerAnalyticsController.getCampaignPerformance);
analyticsRoutes.get('/mailboxes', sequencerAnalyticsController.getMailboxPerformance);
analyticsRoutes.get('/forecast', sequencerAnalyticsController.getSendVolumeForecast);
analyticsRoutes.get('/volume', sequencerAnalyticsController.getDailySendVolume);
analyticsRoutes.get('/reply-quality', sequencerAnalyticsController.getReplyQuality);
router.use('/analytics', analyticsRoutes);

// --- Recipient Preview ---
const previewRoutes = Router();
previewRoutes.get('/clients', recipientPreviewController.listClients);
previewRoutes.post('/', recipientPreviewController.generatePreview);
router.use('/recipient-preview', previewRoutes);

// --- Warmup Pool ---
import * as warmupController from '../controllers/warmupController';
const warmupRoutes = Router();
warmupRoutes.get('/overview', warmupController.getOverview);
warmupRoutes.get('/consent', warmupController.getConsent);
warmupRoutes.post('/consent', warmupController.postConsent);
warmupRoutes.get('/memberships', warmupController.listMemberships);
warmupRoutes.patch('/pool-config', warmupController.patchPoolConfig);
warmupRoutes.post('/memberships/:mid/toggle', warmupController.toggleMembership);
warmupRoutes.patch('/memberships/:mid', warmupController.patchMembershipConfig);
warmupRoutes.get('/memberships/:mid/exchanges', warmupController.listExchanges);
router.use('/warmup', warmupRoutes);

// --- Saved Sequences (reusable multi-step skeletons on the templates page) ---
import * as sequenceController from '../controllers/sequenceController';
const sequenceRoutes = Router();
sequenceRoutes.get('/', sequenceController.list);
// AI generate - register before /:id so the literal path doesn't get
// captured as an id parameter.
sequenceRoutes.post('/generate', requireCapability('edit_sequences'), sequenceController.generate);
sequenceRoutes.get('/:id', sequenceController.get);
sequenceRoutes.post('/', requireCapability('edit_sequences'), sequenceController.create);
sequenceRoutes.patch('/:id', requireCapability('edit_sequences'), sequenceController.update);
sequenceRoutes.delete('/:id', requireCapability('edit_sequences'), sequenceController.remove);
sequenceRoutes.post('/:id/duplicate', requireCapability('edit_sequences'), sequenceController.duplicate);
router.use('/sequences', sequenceRoutes);

// --- Reply Action Configuration ---
// Per-org mapping from reply quality class → automatic action (suppress /
// pause / alert). See replyActionService for action semantics and defaults.
import * as replyActionConfigController from '../controllers/replyActionConfigController';
const replyActionRoutes = Router();
replyActionRoutes.get('/', replyActionConfigController.getRules);
replyActionRoutes.put('/', requireCapability('edit_sequences'), replyActionConfigController.putRule);
router.use('/reply-actions', replyActionRoutes);

export default router;
