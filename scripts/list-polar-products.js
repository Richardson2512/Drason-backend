/**
 * List all Polar products with their IDs, prices, and recurrence so you
 * can map them to the POLAR_*_PRODUCT_ID env vars in Railway.
 *
 * Run locally:
 *   POLAR_ACCESS_TOKEN=<your-token> node scripts/list-polar-products.js
 *
 * Or in Railway shell (POLAR_ACCESS_TOKEN is already in env):
 *   node scripts/list-polar-products.js
 */

const https = require('https');

const token = process.env.POLAR_ACCESS_TOKEN;
if (!token) {
    console.error('POLAR_ACCESS_TOKEN env var is required');
    process.exit(1);
}

function get(path) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'api.polar.sh',
                path,
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            reject(new Error(`Bad JSON from ${path}: ${body.slice(0, 200)}`));
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode} from ${path}: ${body.slice(0, 400)}`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    try {
        // Polar paginates. 100 should be more than enough for most accounts.
        const data = await get('/v1/products?limit=100&is_archived=false');
        const items = data.items || data.result?.items || data.data || [];

        if (items.length === 0) {
            console.log('No active products found in this Polar account.');
            return;
        }

        console.log(`Found ${items.length} active product(s):\n`);
        for (const p of items) {
            const prices = (p.prices || []).filter((pr) => !pr.is_archived);
            const priceLabel = prices.length === 0
                ? '(no price)'
                : prices.map((pr) => {
                    if (pr.amount_type === 'fixed') {
                        const dollars = (pr.price_amount || 0) / 100;
                        const interval = pr.recurring_interval || 'one-time';
                        return `$${dollars.toFixed(2)} ${(pr.price_currency || '').toUpperCase()} / ${interval}`;
                    }
                    return pr.amount_type;
                }).join(', ');

            console.log('  ID:        ' + p.id);
            console.log('  Name:      ' + p.name);
            console.log('  Price:     ' + priceLabel);
            console.log('  Recurring: ' + (p.is_recurring ? 'yes' : 'no'));
            if (p.description) {
                console.log('  Desc:      ' + p.description.slice(0, 80) + (p.description.length > 80 ? '…' : ''));
            }
            console.log('');
        }
    } catch (err) {
        console.error('ERROR:', err.message);
        process.exit(1);
    }
})();
