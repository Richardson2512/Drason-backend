/**
 * Tracking Service
 *
 * Injects the open pixel, wraps outbound links for click tracking, and appends
 * an unsubscribe footer into a campaign email's HTML body before send.
 *
 * All emitted URLs carry an HMAC-signed token produced by trackingToken.ts so
 * that anyone scraping a CampaignLead ID cannot forge requests against our
 * tracking endpoints. Tokens bind leadId + timestamp (+ optional url for clicks)
 * and expire after MAX_TRACKING_AGE_MS (180d). See utils/trackingToken.ts.
 *
 * Requires BACKEND_URL to be publicly reachable (not localhost) for email
 * clients to actually fire the tracking endpoints. In staging with localhost
 * the injection happens but Gmail/Outlook can't resolve the pixel host, so
 * opens/clicks won't register until the backend is deployed.
 */

import { signTrackingToken } from '../utils/trackingToken';

export interface TrackingOptions {
    leadId: string;
    trackOpens: boolean;
    trackClicks: boolean;
    includeUnsubscribe: boolean;
    trackingDomain?: string | null; // per-campaign override, e.g. track.clientdomain.com
}

function getTrackingBase(override?: string | null): string {
    if (override && override.trim()) {
        const t = override.trim().replace(/\/+$/, '');
        return t.startsWith('http://') || t.startsWith('https://') ? t : `https://${t}`;
    }
    return (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

/**
 * Append a 1×1 transparent open pixel to the body.
 * The pixel endpoint (/t/o/:token) increments CampaignLead.opened_count,
 * SendCampaign.total_opened, and mirrors to Lead.emails_opened after verifying
 * the HMAC token.
 */
function injectOpenPixel(html: string, base: string, leadId: string): string {
    const token = signTrackingToken({ leadId });
    const pixel = `<img src="${base}/t/o/${token}" alt="" width="1" height="1" style="display:none;border:0;outline:none;text-decoration:none;" />`;
    // Prefer inserting before </body> when present, else append.
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, `${pixel}</body>`);
    }
    return html + pixel;
}

/**
 * Wrap every <a href="..."> URL in a click-tracking redirect.
 * Skips mailto:, tel:, anchor (#), and already-tracked links.
 * The signed token carries both leadId and the destination URL, so the controller
 * does not need to decode a base64 JSON blob — tampered tokens are rejected.
 */
function wrapClicks(html: string, base: string, leadId: string): string {
    return html.replace(/<a\b([^>]*?)\shref=(["'])([^"']+)\2([^>]*)>/gi, (match, preAttrs, quote, url, postAttrs) => {
        // Skip non-http links and links we've already wrapped
        if (!/^https?:\/\//i.test(url)) return match;
        if (url.startsWith(`${base}/t/c/`) || url.startsWith(`${base}/t/u/`) || url.startsWith(`${base}/t/o/`)) return match;

        const token = signTrackingToken({ leadId, url });
        const wrapped = `${base}/t/c/${token}`;
        return `<a${preAttrs} href=${quote}${wrapped}${quote}${postAttrs}>`;
    });
}

/**
 * Append a CAN-SPAM § 5(a)(5)-compliant footer:
 *   - signed-token unsubscribe link (RFC 8058 one-click compatible)
 *   - sender's physical postal address (CAN-SPAM requirement)
 *   - optional ePrivacy tracking disclosure when euComplianceMode=true
 *
 * Uses a signed token pointing at /t/u/:token so recipients can unsubscribe
 * with a single click without enabling forged unsubscribes for arbitrary
 * CampaignLead IDs.
 */
function appendUnsubscribeFooter(
    html: string,
    base: string,
    leadId: string,
    options: { mailingAddress?: string | null; euComplianceMode?: boolean } = {},
): string {
    const token = signTrackingToken({ leadId });
    const url = `${base}/t/u/${token}`;

    // Escape the postal address (customer-supplied; treat as untrusted) before
    // concatenating into HTML so a malformed address can't break the footer.
    const safeAddress = options.mailingAddress
        ? String(options.mailingAddress)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
        : '';

    const trackingDisclosure = options.euComplianceMode
        ? `<div style="margin-top:6px;font-size:10px;color:#bbb;">This email is sent without engagement tracking pixels.</div>`
        : '';

    const addressLine = safeAddress
        ? `<div style="margin-top:6px;font-size:10px;color:#bbb;">${safeAddress}</div>`
        : '';

    const footer = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e5e5;font-size:11px;color:#999;font-family:sans-serif;">`
        + `If you'd rather not hear from us, <a href="${url}" style="color:#999;text-decoration:underline;">unsubscribe here</a>.`
        + addressLine
        + trackingDisclosure
        + `</div>`;

    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, `${footer}</body>`);
    }
    return html + footer;
}

/**
 * Main entry point. Applies enabled transforms in order: click wrap → unsubscribe → open pixel.
 * (Pixel last so it sits below the footer and isn't inside a wrapped link.)
 *
 * EU compliance mode (campaign-level toggle): when true, the open pixel is
 * suppressed and the unsubscribe footer carries an explicit tracking-disclosure
 * line. Aligns with ePrivacy Directive Art. 5(3) for jurisdictions that treat
 * pixel opens as "storage of or access to information" requiring opt-in.
 */
export function applyTracking(html: string, options: TrackingOptions & {
    euComplianceMode?: boolean;
    mailingAddress?: string | null;
}): string {
    const base = getTrackingBase(options.trackingDomain);
    let output = html;
    if (options.trackClicks) output = wrapClicks(output, base, options.leadId);
    if (options.includeUnsubscribe) {
        output = appendUnsubscribeFooter(output, base, options.leadId, {
            mailingAddress: options.mailingAddress,
            euComplianceMode: options.euComplianceMode,
        });
    }
    // Open pixel suppressed in EU compliance mode (recipient may not have
    // consented to engagement tracking under ePrivacy).
    if (options.trackOpens && !options.euComplianceMode) {
        output = injectOpenPixel(output, base, options.leadId);
    }
    return output;
}

/**
 * Build the canonical one-click unsubscribe URL for a lead. Used by the send
 * services to populate the List-Unsubscribe + List-Unsubscribe-Post headers
 * (RFC 2369 + RFC 8058) — required by Gmail's bulk-sender requirements
 * (Feb 2024) and Yahoo's parallel rules for senders >5K msgs/day.
 */
export function buildUnsubscribeUrl(leadId: string, trackingDomain?: string | null): string {
    const base = getTrackingBase(trackingDomain);
    const token = signTrackingToken({ leadId });
    return `${base}/t/u/${token}`;
}
