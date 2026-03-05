import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import * as ticketService from '../services/ticketService';
import { logger } from '../services/observabilityService';

export const createTicket = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const userId = req.orgContext?.userId;
        const { subject, description, category } = req.body;

        if (!subject || !description) {
            return res.status(400).json({ success: false, error: 'Subject and description are required' });
        }

        if (!userId) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
        if (!user) {
            return res.status(401).json({ success: false, error: 'User not found' });
        }

        const ticket = await ticketService.createTicket({
            organizationId: orgId,
            userId,
            userEmail: user.email,
            userName: user.name || user.email,
            subject,
            description,
            category: category || 'general',
        });

        return res.json({
            success: true,
            data: {
                id: ticket.id,
                ticket_id: ticket.ticket_id,
                subject: ticket.subject,
                category: ticket.category,
                status: ticket.status,
                created_at: ticket.created_at,
            },
        });
    } catch (error) {
        logger.error('Error creating support ticket:', error as Error);
        return res.status(500).json({ success: false, error: 'Failed to create ticket' });
    }
};

export const getTickets = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const tickets = await ticketService.getTickets(orgId);
        return res.json({ success: true, data: tickets });
    } catch (error) {
        logger.error('Error fetching tickets:', error as Error);
        return res.status(500).json({ success: false, error: 'Failed to fetch tickets' });
    }
};
