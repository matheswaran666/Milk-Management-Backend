const https = require('https');
const querystring = require('querystring');

/**
 * RUN THIS SCRIPT TO GET YOUR REFRESH TOKEN
 * 1. Fill in the values below
 * 2. Run: node get_token.js
 */

const client_id     = 'YOUR_CLIENT_ID';
const client_secret = 'YOUR_CLIENT_SECRET';
const grant_token   = 'THE_CODE_YOU_JUST_GOT';
const region_domain = 'zoho.in'; // Since you are in India

const postData = querystring.stringify({
  code:          grant_token,
  client_id:     client_id,
  client_secret: client_secret,
  grant_type:    'authorization_code'
});

const options = {
  hostname: `accounts.${region_domain}`,
  port: 443,
  path: '/oauth/v2/token',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': postData.length
  }
};

console.log('--- Requesting Refresh Token ---');

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const response = JSON.parse(data);
    if (response.refresh_token) {
      console.log('✅ SUCCESS! Your Refresh Token is:');
      console.log('-----------------------------------');
      console.log(response.refresh_token);
      console.log('-----------------------------------');
      console.log('Copy this into your .env file as CATALYST_REFRESH_TOKEN');
    } else {
      console.log('❌ FAILED to get token. Details:');
      console.log(response);
    }
  });
});

req.on('error', (e) => console.error(`Problem with request: ${e.message}`));
req.write(postData);
req.end();
