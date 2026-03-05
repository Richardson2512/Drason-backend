import { prisma } from '../index';
import nodemailer from 'nodemailer';
import { logger } from './observabilityService';

function generateTicketId(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 4; i++) {
        suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `SUP-${dateStr}-${suffix}`;
}

function getTransporter() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
        logger.warn('SMTP not configured — ticket emails will be skipped');
        return null;
    }

    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
    });
}

export async function createTicket(params: {
    organizationId: string;
    userId: string;
    userEmail: string;
    userName: string;
    subject: string;
    description: string;
    category: string;
}) {
    const ticketId = generateTicketId();

    const ticket = await prisma.supportTicket.create({
        data: {
            ticket_id: ticketId,
            organization_id: params.organizationId,
            user_id: params.userId,
            user_email: params.userEmail,
            subject: params.subject,
            description: params.description,
            category: params.category,
        },
    });

    // Send email notification (fire and forget)
    sendTicketEmail(ticket, params.userName).catch(err =>
        logger.error('Failed to send ticket email:', err)
    );

    return ticket;
}

async function sendTicketEmail(
    ticket: { ticket_id: string; user_email: string; subject: string; description: string; category: string; created_at: Date },
    userName: string
) {
    const transporter = getTransporter();
    if (!transporter) return;

    const recipient = process.env.SUPPORT_EMAIL || 'richardson@superkabe.com';
    const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER || 'support@superkabe.com';

    await transporter.sendMail({
        from: `"Superkabe Support" <${fromAddress}>`,
        to: recipient,
        subject: `[${ticket.ticket_id}] ${ticket.subject}`,
        html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #4F46E5, #7C3AED); padding: 24px; border-radius: 12px 12px 0 0;">
                    <h2 style="color: #fff; margin: 0; font-size: 20px;">New Support Ticket</h2>
                    <p style="color: #E0E7FF; margin: 4px 0 0; font-size: 14px;">Ticket ID: ${ticket.ticket_id}</p>
                </div>
                <div style="background: #fff; padding: 24px; border: 1px solid #E5E7EB; border-top: none; border-radius: 0 0 12px 12px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <tr><td style="padding: 8px 0; color: #6B7280; width: 120px;">From:</td><td style="padding: 8px 0; color: #111827; font-weight: 600;">${userName} (${ticket.user_email})</td></tr>
                        <tr><td style="padding: 8px 0; color: #6B7280;">Category:</td><td style="padding: 8px 0; color: #111827;">${ticket.category}</td></tr>
                        <tr><td style="padding: 8px 0; color: #6B7280;">Subject:</td><td style="padding: 8px 0; color: #111827; font-weight: 600;">${ticket.subject}</td></tr>
                        <tr><td style="padding: 8px 0; color: #6B7280;">Created:</td><td style="padding: 8px 0; color: #111827;">${ticket.created_at.toISOString()}</td></tr>
                    </table>
                    <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 16px 0;" />
                    <h3 style="font-size: 14px; color: #374151; margin: 0 0 8px;">Description</h3>
                    <div style="background: #F9FAFB; padding: 16px; border-radius: 8px; color: #374151; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${ticket.description}</div>
                </div>
            </div>
        `,
    });

    logger.info(`Ticket email sent for ${ticket.ticket_id}`);
}

export async function getTickets(organizationId: string) {
    return prisma.supportTicket.findMany({
        where: { organization_id: organizationId },
        orderBy: { created_at: 'desc' },
        take: 50,
    });
}
