/**
 * Nest Cam Viewer - Cloud Server with HLS relay
 * RTSP → ffmpeg → HLS segments → browser video via hls.js
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const CONFIG = {
  clientId:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  projectId:    process.env.SDM_PROJECT_ID,
  redirectUri:  process.env.REDIRECT_URI,
};

// ── Token store ────────────────────────────────────────────────────────────
let tokens = null;

function initTokens() {
  if (process.env.REFRESH_TOKEN) {
    tokens = { access_token: null, refresh_token: process.env.REFRESH_TOKEN, expiry: 0 };
    console.log('✅ Loaded refresh token from environment');
  }
}
initTokens();

function saveTokens(t) {
  tokens = t;
  if (t.refresh_token) {
    console.log('\n📋 SAVE THIS as REFRESH_TOKEN env var in Railway:');
    console.log(t.refresh_token);
    console.log('');
  }
}

// ── HLS stream manager ─────────────────────────────────────────────────────
const hlsStreams = {};

function getHlsDir(slotId) {
  return path.join(os.tmpdir(), `hls_${slotId}`);
}

function startHls(slotId, rtspUrl) {
  stopHls(slotId);

  const dir = getHlsDir(slotId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try { fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f))); } catch {}

  console.log(`▶ Starting HLS relay for slot ${slotId}`);

  const ffmpeg = spawn('ffmpeg', [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-c:v', 'copy',
    '-an',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', path.join(dir, 'seg%03d.ts'),
    path.join(dir, 'index.m3u8'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpeg.stderr.on('data', d => {
    const msg = d.toString();
    if (msg.includes('Error') || msg.includes('error') || msg.includes('Failed')) {
      console.error(`ffmpeg [${slotId}]:`, msg.trim());
    }
  });

  ffmpeg.on('exit', (code) => {
    console.log(`ffmpeg [${slotId}] exited with code ${code}`);
    if (hlsStreams[slotId]?.process === ffmpeg) delete hlsStreams[slotId];
  });

  hlsStreams[slotId] = { process: ffmpeg, dir, rtspUrl, startedAt: Date.now() };
}

function stopHls(slotId) {
  if (hlsStreams[slotId]) {
    try { hlsStreams[slotId].process.kill('SIGKILL'); } catch {}
    delete hlsStreams[slotId];
    console.log(`⏹ Stopped HLS relay for slot ${slotId}`);
  }
}

function stopAllHls() {
  Object.keys(hlsStreams).forEach(stopHls);
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
    tokens = { ...tokens, access_token: res.body.access_token, expiry: Date.now() + (res.body.expires_in * 1000) };
  } else {
    throw new Error('Token refresh failed: ' + JSON.stringify(res.body));
  }
}

async function getValidToken() {
  if (!tokens) throw new Error('Not authenticated');
  if (!tokens.access_token || Date.now() > (tokens.expiry - 60000)) await refreshAccessToken();
  return tokens.access_token;
}

// ── SDM API ────────────────────────────────────────────────────────────────
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

  // Serve HLS segments: /hls/0/index.m3u8  or  /hls/1/seg001.ts
  if (p.startsWith('/hls/')) {
    const parts = p.split('/');
    const slotId = parts[2];
    const filename = parts[3];
    const filepath = path.join(getHlsDir(slotId), filename);

    let waited = 0;
    while (!fs.existsSync(filepath) && waited < 8000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }

    if (!fs.existsSync(filepath)) {
      res.writeHead(404); return res.end('Not ready');
    }

    const ext = path.extname(filename);
    res.writeHead(200, {
      'Content-Type': ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Cache-Control': 'no-cache, no-store',
    });
    return res.end(fs.readFileSync(filepath));
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

  // Start HLS stream for a camera slot
  if (p === '/api/stream' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { deviceId, slotId } = JSON.parse(body);
        const stream = await generateStream(deviceId);
        if (!stream?.streamUrls?.rtspUrl) throw new Error('No RTSP URL returned');

        startHls(slotId, stream.streamUrls.rtspUrl);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hlsUrl: `/hls/${slotId}/index.m3u8`,
          streamExtensionToken: stream.streamExtensionToken,
          expiresAt: stream.expiresAt,
        }));
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

  if (p === '/api/stop' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { slotId } = JSON.parse(body);
        stopHls(slotId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stopped: true }));
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
  console.log(`\n🎥 Nest Viewer (HLS) running on port ${PORT}`);
  if (!tokens) console.log(`👉 Visit your app URL + /auth to connect Google\n`);
  else console.log(`✅ Ready\n`);
});

process.on('SIGTERM', stopAllHls);
process.on('SIGINT', stopAllHls);
