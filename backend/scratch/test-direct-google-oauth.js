require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const querystring = require('querystring');

console.log('====================================================');
console.log('[AgosTech] Direct Google OAuth Diagnostics');
console.log('====================================================');
console.log('Client ID:', process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.substring(0, 25) + '...' : 'MISSING');
console.log('Client Secret:', process.env.GOOGLE_CLIENT_SECRET ? 'PRESENT' : 'MISSING');
console.log('Callback URL:', process.env.GOOGLE_CALLBACK_URL || 'MISSING');
console.log('----------------------------------------------------');

// Test 1: Fetch Google OpenID Configuration (DNS + SSL check)
function testOpenIdDiscovery() {
  return new Promise((resolve) => {
    console.log('\n[Test 1/2] Connecting to https://accounts.google.com/.well-known/openid-configuration...');
    const req = https.get('https://accounts.google.com/.well-known/openid-configuration', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`✅ Success! Response Status Code: ${res.statusCode}`);
        try {
          const parsed = JSON.parse(data);
          console.log(`   Issuer: ${parsed.issuer}`);
          console.log(`   Token Endpoint: ${parsed.token_endpoint}`);
        } catch (e) {
          console.log('   Raw response preview:', data.substring(0, 100));
        }
        resolve(true);
      });
    });

    req.on('error', (err) => {
      console.error('❌ [Test 1 Failed] OS-Level Network / SSL Error:');
      console.error('   Message:', err.message);
      console.error('   Code:', err.code);
      console.error('   Syscall:', err.syscall);
      console.error('   Stack:', err.stack);
      resolve(false);
    });

    req.setTimeout(10000, () => {
      console.error('❌ [Test 1 Failed] Request timed out after 10 seconds (ETIMEDOUT)');
      req.destroy();
      resolve(false);
    });
  });
}

// Test 2: Direct Token Endpoint POST request to oauth2.googleapis.com
function testTokenEndpoint() {
  return new Promise((resolve) => {
    console.log('\n[Test 2/2] Sending test POST to https://oauth2.googleapis.com/token...');
    const postData = querystring.stringify({
      code: 'dummy_authorization_code_for_diagnostics',
      client_id: process.env.GOOGLE_CLIENT_ID || 'dummy_id',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || 'dummy_secret',
      redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback',
      grant_type: 'authorization_code'
    });

    const options = {
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`✅ Received HTTP Response Status: ${res.statusCode} ${res.statusMessage}`);
        try {
          const json = JSON.parse(data);
          console.log('   Google OAuth API Response body:');
          console.log(JSON.stringify(json, null, 2));
          if (json.error === 'invalid_grant' || json.error === 'invalid_client') {
            console.log('   ℹ️ Endpoint reachable! (The invalid_grant response is expected because code is a test placeholder).');
          }
        } catch (e) {
          console.log('   Raw body:', data);
        }
        resolve(true);
      });
    });

    req.on('error', (err) => {
      console.error('❌ [Test 2 Failed] OS-Level Network / SSL Error:');
      console.error('   Message:', err.message);
      console.error('   Code:', err.code);
      console.error('   Syscall:', err.syscall);
      console.error('   Stack:', err.stack);
      resolve(false);
    });

    req.setTimeout(10000, () => {
      console.error('❌ [Test 2 Failed] Token endpoint request timed out after 10 seconds');
      req.destroy();
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

async function runDiagnostics() {
  const test1 = await testOpenIdDiscovery();
  const test2 = await testTokenEndpoint();
  console.log('\n====================================================');
  console.log('Diagnostics summary:');
  console.log(`OpenID Discovery: ${test1 ? 'PASSED' : 'FAILED'}`);
  console.log(`Token Endpoint POST: ${test2 ? 'PASSED' : 'FAILED'}`);
  console.log('====================================================');
}

runDiagnostics();
