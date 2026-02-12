
const fetch = require('node-fetch');

async function main() {
    try {
        const res = await fetch('http://localhost:3001/api/organization');
        const data = await res.json();
        console.log('Status:', res.status);
        console.log('Data:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
