const https = require('https');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

/**
 * REFRESH TOKEN CALIBRATOR (No-Dependency Version)
 * Use this to generate a fresh Refresh Token for your Zoho Catalyst account.
 */

// Load .env manually to avoid dependency
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) env[key.trim()] = value.trim();
});

const clientId = env.CATALYST_CLIENT_ID;
const clientSecret = env.CATALYST_CLIENT_SECRET;
const accountsHost = 'accounts.zoho.in'; // India Region

console.log('--- Zoho Catalyst Token Calibrator ---');
console.log('1. Go to: https://api-console.zoho.in/');
console.log('2. Select your Self-Client.');
console.log('3. Go to "Generate Code" tab.');
console.log('4. Copy and Paste this EXACT Scope:');
console.log('   ZohoCatalyst.tables.rows.READ,ZohoCatalyst.tables.rows.CREATE,ZohoCatalyst.tables.rows.UPDATE,ZohoCatalyst.tables.rows.DELETE,ZohoCatalyst.zcql.CREATE');
console.log('\n5. Duration: 10 minutes.');
console.log('6. CLICK GENERATE and COPY the CODE.');
console.log('--------------------------------------');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\nPASTE THE GENERATED CODE HERE: ', (code) => {
  console.log('\nExchanging code for Refresh Token...');
  
  const params = new URLSearchParams({
    code: code.trim(),
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code'
  }).toString();

  const options = {
    hostname: accountsHost,
    path: `/oauth/v2/token?${params}`,
    method: 'POST'
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        if (response.refresh_token) {
          console.log('\n✅ SUCCESS! NEW REFRESH TOKEN:\n');
          console.log(response.refresh_token);
        } else {
          console.error('\n❌ FAILED:', response);
          if (response.error === 'oauth_app_blocked') {
             console.log('\n💡 TIP: Your API Client is blocked. Please DELETE it in the Zoho API Console and create a NEW one.');
          }
        }
      } catch (e) {
        console.error('\n❌ Error parsing response:', data);
      }
      rl.close();
    });
  });

  req.on('error', (error) => {
    console.error('\n❌ Connection Error:', error.message);
    rl.close();
  });

  req.end();
});
