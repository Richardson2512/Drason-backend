import axios from 'axios';

const API_URL = 'http://localhost:3001/api';

async function main() {
    console.log('--- Starting End-to-End Autonomous Flow Verification ---');

    // 1. Create a Routing Rule
    try {
        console.log('1. Creating Routing Rule...');
        await axios.post(`${API_URL}/dashboard/routing-rules`, {
            persona: 'CTO',
            min_score: 50,
            target_campaign_id: 'camp_123', // Ensure this matches the seeded campaign
            priority: 10
        });
        console.log('   Rule Created: CTO (score > 50) -> camp_123');
    } catch (e: any) {
        console.log('   Rule might already exist or error:', e.message);
    }

    // 2. Ingest a Lead that Matches
    console.log('2. Ingesting Matching Lead...');
    const leadRes = await axios.post(`${API_URL}/ingest`, {
        email: 'target_cto@example.com',
        persona: 'CTO',
        lead_score: 85,
        source: 'verification_script'
    });
    console.log('   Ingest Response:', leadRes.data);
    const leadId = leadRes.data.leadId;

    if (!leadRes.data.assignedCampaignId) {
        console.error('❌ Lead was NOT assigned a campaign! Check routing logic.');
        return;
    }

    // 3. Wait for Processor
    console.log('3. Waiting 15s for Processor to pick up Held -> Active...');
    await new Promise(r => setTimeout(r, 15000));

    // 4. Check Status
    console.log('4. Checking Final Status...');
    // We can check via the dashboard API or just trust the console logs if we are running locally, 
    // but let's query the specific lead if we can, or just list leads.
    const leadsRes = await axios.get(`${API_URL}/dashboard/leads`);
    const myLead = leadsRes.data.find((l: any) => l.id === leadId);

    if (myLead) {
        console.log(`   Final Lead Status: ${myLead.status.toUpperCase()}`);
        if (myLead.status === 'active') {
            console.log('✅ SUCCESS: Lead moved from Ingest -> Route -> Held -> Processor -> Active');
        } else {
            console.log('❌ FAIL: Lead is still', myLead.status);
        }
    } else {
        console.log('❌ FAIL: Lead not found in dashboard list.');
    }
}

main();
