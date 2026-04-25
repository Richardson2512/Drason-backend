import { Router } from 'express';
import * as connectedAccountController from '../controllers/connectedAccountController';
import * as oauthConnectController from '../controllers/oauthConnectController';
import * as infraProvidersController from '../controllers/infraProvidersController';
import * as campaignController2 from '../controllers/campaignController2';
import * as templateController from '../controllers/templateController';
import * as contactController from '../controllers/contactController';
import * as sequencerSettingsController from '../controllers/sequencerSettingsController';
import * as sequencerAnalyticsController from '../controllers/sequencerAnalyticsController';
import * as signatureController from '../controllers/signatureController';
import * as recipientPreviewController from '../controllers/recipientPreviewController';

const router = Router();

// --- Connected Accounts ---
const accountRoutes = Router();
accountRoutes.get('/', connectedAccountController.listAccounts);
accountRoutes.post('/', connectedAccountController.createAccount);
accountRoutes.post('/bulk', connectedAccountController.bulkCreateAccounts);
accountRoutes.delete('/:id', connectedAccountController.deleteAccount);
accountRoutes.patch('/:id', connectedAccountController.updateAccount);
accountRoutes.post('/:id/test', connectedAccountController.testConnection);
accountRoutes.post('/reset-sends', connectedAccountController.resetDailySends);
accountRoutes.get('/tracking-domain/check', connectedAccountController.checkTrackingDomainEndpoint);
accountRoutes.post('/:id/tracking-domain', connectedAccountController.setTrackingDomain);
accountRoutes.post('/:id/tracking-domain/verify', connectedAccountController.verifyTrackingDomain);

// OAuth flows (Google + Microsoft)
accountRoutes.get('/google/authorize', oauthConnectController.googleAuthorize);
accountRoutes.get('/google/callback', oauthConnectController.googleCallback);
accountRoutes.get('/microsoft/authorize', oauthConnectController.microsoftAuthorize);
accountRoutes.get('/microsoft/callback', oauthConnectController.microsoftCallback);

router.use('/accounts', accountRoutes);

// --- Campaigns ---
const campaignRoutes = Router();
campaignRoutes.get('/', campaignController2.listCampaigns);
campaignRoutes.get('/:id', campaignController2.getCampaign);
campaignRoutes.get('/:id/leads', campaignController2.listCampaignLeads);
campaignRoutes.post('/', campaignController2.createCampaign);
campaignRoutes.patch('/:id', campaignController2.updateCampaign);
campaignRoutes.delete('/:id', campaignController2.deleteCampaign);
campaignRoutes.post('/:id/launch', campaignController2.launchCampaign);
campaignRoutes.post('/:id/pause', campaignController2.pauseCampaign);
campaignRoutes.post('/:id/resume', campaignController2.resumeCampaign);
router.use('/campaigns', campaignRoutes);

// --- Templates ---
const templateRoutes = Router();
templateRoutes.get('/categories', templateController.listCategories);
templateRoutes.get('/', templateController.listTemplates);
templateRoutes.get('/:id', templateController.getTemplate);
templateRoutes.post('/', templateController.createTemplate);
templateRoutes.patch('/:id', templateController.updateTemplate);
templateRoutes.delete('/:id', templateController.deleteTemplate);
templateRoutes.post('/:id/duplicate', templateController.duplicateTemplate);
router.use('/templates', templateRoutes);

// --- Infrastructure Providers (for bulk mailbox import) ---
router.get('/infra-providers', infraProvidersController.listInfraProviders);

// --- Contacts ---
const contactRoutes = Router();
contactRoutes.get('/', contactController.listContacts);
contactRoutes.get('/facets', contactController.getContactFacets);
contactRoutes.post('/', contactController.createContact);
contactRoutes.post('/bulk', contactController.bulkCreateContacts);
contactRoutes.post('/delete', contactController.deleteContacts);
contactRoutes.post('/validate', contactController.validateContacts);
contactRoutes.post('/validate-preview', contactController.validateLeadsPreview);
contactRoutes.post('/assign-campaign', contactController.assignToCampaign);
contactRoutes.get('/export', contactController.exportContacts);
router.use('/contacts', contactRoutes);

// --- Settings ---
const settingsRoutes = Router();
settingsRoutes.get('/', sequencerSettingsController.getSettings);
settingsRoutes.patch('/', sequencerSettingsController.updateSettings);
router.use('/settings', settingsRoutes);

// --- Signatures ---
const signatureRoutes = Router();
signatureRoutes.get('/', signatureController.listSignatures);
signatureRoutes.post('/', signatureController.createSignature);
signatureRoutes.patch('/:id', signatureController.updateSignature);
signatureRoutes.delete('/:id', signatureController.deleteSignature);
router.use('/signatures', signatureRoutes);

// --- Analytics ---
const analyticsRoutes = Router();
analyticsRoutes.get('/', sequencerAnalyticsController.getOverview);
analyticsRoutes.get('/campaigns', sequencerAnalyticsController.getCampaignPerformance);
analyticsRoutes.get('/forecast', sequencerAnalyticsController.getSendVolumeForecast);
analyticsRoutes.get('/volume', sequencerAnalyticsController.getDailySendVolume);
analyticsRoutes.get('/reply-quality', sequencerAnalyticsController.getReplyQuality);
router.use('/analytics', analyticsRoutes);

// --- Recipient Preview ---
const previewRoutes = Router();
previewRoutes.get('/clients', recipientPreviewController.listClients);
previewRoutes.post('/', recipientPreviewController.generatePreview);
router.use('/recipient-preview', previewRoutes);

export default router;
