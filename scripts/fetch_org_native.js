
async function main() {
    try {
        console.log('Fetching organization...');
        const res = await fetch('http://localhost:3001/api/organization');
        console.log('Status:', res.status);
        if (res.ok) {
            const data = await res.json();
            console.log('Data:', JSON.stringify(data, null, 2));
        } else {
            const text = await res.text();
            console.log('Error Response:', text);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
