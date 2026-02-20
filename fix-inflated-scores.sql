-- Fix Inflated Lead Scores
-- Run this on your production database to cap all scores at 100

-- Update all leads with scores > 100 to 100 (max score)
UPDATE leads
SET
    lead_score = 100,
    updated_at = NOW()
WHERE lead_score > 100;

-- Verify the fix
SELECT
    COUNT(*) AS total_leads,
    COUNT(CASE WHEN lead_score > 100 THEN 1 END) AS leads_over_100,
    MIN(lead_score) AS min_score,
    MAX(lead_score) AS max_score,
    AVG(lead_score) AS avg_score
FROM leads;
