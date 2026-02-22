#!/bin/bash
curl -X POST http://localhost:3001/api/monitor/emailbison-webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mock-test-token" \
  -d '{
    "events": [
      {
        "id": "test_bounce_123",
        "type": "email_bounced",
        "email_account_id": "99",
        "campaign_id": "55",
        "recipient_email": "bad@example.com",
        "smtp_response": "550 Message rejected as spam"
      }
    ]
  }'
