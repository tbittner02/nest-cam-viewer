/**
 * Nest Cam Viewer - Cloud Server (Railway-ready)
 * Config comes from environment variables — no local files needed.
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// ─── CONFIG via environment variables ─────────────────────────────────────
// Set these in Railway's "Variables" tab (see SETUP.md)
const CONFIG = {
  clientId:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  projectId:    process.env.SDM_PROJECT_ID,
  redirectUri:  process.env.REDIRECT_URI,   // e.g. https://your-app.railway.app/oauth/callback
};

// ─── In-memory token store (persists until server restarts) ───────────────
// For permanent storage, set REFRESH_TOKEN env var after first login
let tokens = null;

function initTokens() {
  // If a refresh token was saved as an env var, bootstrap from it
  if (process.env.REFRESH_TOKEN) {
    tokens = {
      access_token: null,
      refresh_token: process.env.REFRESH_TOKEN,
      expiry: 0, // force refresh on first use
    };
    console.log('✅ Loaded refresh token from environment');
  }
}
initTokens();

function saveTokens(t) {
  tokens = t;
  // Print the refresh token to logs so you can save it as an env var
  // (only needed once — after that it persists across restarts)
  if (t.refresh_token) {
    console.log('\n📋 SAVE THIS as REFRESH_TOKEN env var in Railway:');
    console.log(t.refresh_token);
    console.log('');
  }
}

// ── HTTPS helper ───────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Refresh access token ───────────────────────────────────────────────────
async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  const res = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body);

  if (res.body.access_token) {
    tokens = {
      ...tokens,
      access_token: res.body.access_token,
      expiry: Date.now() + (res.body.expires_in * 1000),
    };
  } else {
    throw new Error('Token refresh failed: ' + JSON.stringify(res.body));
  }
}

async function getValidToken() {
  if (!tokens) throw new Error('Not authenticated — visit /auth first');
  if (!tokens.access_token || Date.now() > (tokens.expiry - 60000)) {
    await refreshAccessToken();
  }
  return tokens.access_token;
}

// ── SDM helpers ────────────────────────────────────────────────────────────
async function listDevices() {
  const token = await getValidToken();
  const res = await httpsRequest({
    hostname: 'smartdevicemanagement.googleapis.com',
    path: `/v1/enterprises/${CONFIG.projectId}/devices`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.body.devices || [];
}

async function generateStream(deviceId) {
  const token = await getValidToken();
  const res = await httpsRequest({
    hostname: 'smartdevicemanagement.googleapis.com',
    path: `/v1/${deviceId}:executeCommand`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, JSON.stringify({ command: 'sdm.devices.commands.CameraLiveStream.GenerateRtspStream', params: {} }));
  return res.body.results;
}

async function extendStream(deviceId, streamExtensionToken) {
  const token = await getValidToken();
  const res = await httpsRequest({
    hostname: 'smartdevicemanagement.googleapis.com',
    path: `/v1/${deviceId}:executeCommand`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }, JSON.stringify({
    command: 'sdm.devices.commands.CameraLiveStream.ExtendRtspStream',
    params: { streamExtensionToken }
  }));
  return res.body.results;
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (p === '/auth') {
    const authUrl = `https://nestservices.google.com/partnerconnections/${CONFIG.projectId}/auth?` +
      new URLSearchParams({
        redirect_uri: CONFIG.redirectUri,
        access_type: 'offline',
        prompt: 'consent',
        client_id: CONFIG.clientId,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/sdm.service',
      });
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  if (p === '/oauth/callback') {
    const code = parsed.query.code;
    const body = new URLSearchParams({
      code,
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      redirect_uri: CONFIG.redirectUri,
      grant_type: 'authorization_code',
    }).toString();

    const tokenRes = await httpsRequest({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, body);

    if (tokenRes.body.access_token) {
      saveTokens({
        access_token: tokenRes.body.access_token,
        refresh_token: tokenRes.body.refresh_token,
        expiry: Date.now() + (tokenRes.body.expires_in * 1000),
      });
      res.writeHead(302, { Location: '/?auth=success' });
    } else {
      console.error('OAuth error:', tokenRes.body);
      res.writeHead(302, { Location: '/?auth=error' });
    }
    return res.end();
  }

  if (p === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ authenticated: !!tokens }));
  }

  if (p === '/api/devices') {
    try {
      const devices = await listDevices();
      const cams = devices
        .filter(d => d.type === 'sdm.devices.types.CAMERA' || d.type === 'sdm.devices.types.DOORBELL')
        .map(d => ({
          id: d.name,
          displayName: d.traits?.['sdm.devices.traits.Info']?.customName || 'Unnamed camera',
          type: d.type,
        }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ devices: cams }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (p === '/api/stream' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { deviceId } = JSON.parse(body);
        const stream = await generateStream(deviceId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stream));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (p === '/api/extend' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { deviceId, streamExtensionToken } = JSON.parse(body);
        const result = await extendStream(deviceId, streamExtensionToken);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🎥 Nest Viewer running on port ${PORT}`);
  if (!tokens) {
    console.log(`👉 Visit your app URL + /auth to connect Google\n`);
  } else {
    console.log(`✅ Refresh token loaded — ready to go\n`);
  }
});
