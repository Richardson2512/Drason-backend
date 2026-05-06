-- Track email delivery status for workspace invites so the agency UI can
-- distinguish "sent" vs "bounced" vs "send failed" without polling Resend
-- separately. last_send_status values: 'pending' | 'sent' | 'bounced' | 'failed'.

ALTER TABLE "WorkspaceInvite"
    ADD COLUMN "last_send_status" TEXT,
    ADD COLUMN "last_send_attempted_at" TIMESTAMP(3),
    ADD COLUMN "last_send_error" TEXT;
