/**
 * Infrastructure Providers Controller
 *
 * Returns the catalog of pre-configured SMTP/IMAP provider presets used in the
 * bulk mailbox import modal. Centralizing this list means updating a provider's
 * endpoints doesn't require a frontend deploy.
 */

import { Request, Response } from 'express';

const PROVIDERS = [
    { id: 'zapmail', name: 'Zapmail', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'scaledmail', name: 'Scaledmail', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'premiuminboxes', name: 'Premium Inboxes', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'missioninbox', name: 'MissionInbox', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'infraforge', name: 'Infraforge', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'mailforge', name: 'Mailforge', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'maildoso', name: 'Maildoso', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'google', name: 'Google Workspace (direct)', smtpHost: 'smtp.gmail.com', smtpPort: '587', imapHost: 'imap.gmail.com', imapPort: '993', type: 'google' },
    { id: 'outlook', name: 'Microsoft 365 / Outlook', smtpHost: 'smtp.office365.com', smtpPort: '587', imapHost: 'outlook.office365.com', imapPort: '993', type: 'microsoft' },
    { id: 'zoho', name: 'Zoho Mail', smtpHost: 'smtp.zoho.com', smtpPort: '587', imapHost: 'imap.zoho.com', imapPort: '993', type: 'smtp' },
    { id: 'other', name: 'Other / Custom SMTP', smtpHost: '', smtpPort: '587', imapHost: '', imapPort: '993', type: 'smtp' },
];

export const listInfraProviders = async (_req: Request, res: Response): Promise<Response> => {
    return res.json({ success: true, providers: PROVIDERS });
};
