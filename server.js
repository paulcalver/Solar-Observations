require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Bluesky authentication state ──────────────────────────
let blueskyAccessToken = null;

// ── Proxy endpoint for Helioviewer API ───────────────────────
// Declared BEFORE static files so it takes priority.
// Uses raw query string to preserve bracket characters
// that Express's query parser would mangle.
app.get('/api/helioviewer/:endpoint', async (req, res) => {
  const endpoint = req.params.endpoint;

  // Extract raw query string to preserve brackets etc.
  const fullUrl = req.originalUrl;
  const qsIndex = fullUrl.indexOf('?');
  const rawQuery = qsIndex !== -1 ? fullUrl.substring(qsIndex) : '';

  const url = `https://api.helioviewer.org/v2/${endpoint}/${rawQuery}`;

  console.log(`[proxy] ${endpoint} → ${url}`);

  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    console.log(`[proxy] Response status: ${response.status}`);
    console.log(`[proxy] Content-Type: ${contentType}`);
    console.log(`[proxy] Body preview: ${body.substring(0, 200)}...`);

    // Try to parse as JSON
    try {
      const data = JSON.parse(body);
      res.json(data);
    } catch {
      // Not JSON, send as-is
      console.log('[proxy] ⚠️  Response is not JSON, sending as-is');
      res.set('Content-Type', contentType || 'text/plain');
      res.send(body);
    }
  } catch (err) {
    console.error('[proxy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Authenticate with Bluesky ─────────────────────────────
async function authenticateBluesky() {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;

  if (!identifier || !password) {
    console.warn('[bluesky] ⚠️  No credentials found in .env - running unauthenticated');
    return null;
  }

  try {
    console.log('[bluesky] Authenticating...');
    const response = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Auth failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('[bluesky] ✓ Authenticated successfully');
    return data.accessJwt;
  } catch (err) {
    console.error('[bluesky] Authentication error:', err.message);
    return null;
  }
}

// ── Proxy endpoint for Bluesky API ────────────────────────────
app.get('/api/bluesky/search', async (req, res) => {
  const fullUrl = req.originalUrl;
  const qsIndex = fullUrl.indexOf('?');
  const rawQuery = qsIndex !== -1 ? fullUrl.substring(qsIndex) : '';

  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts${rawQuery}`;

  console.log(`[proxy] bluesky → ${url}`);

  try {
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };

    // Add authorization if we have a token
    if (blueskyAccessToken) {
      headers['Authorization'] = `Bearer ${blueskyAccessToken}`;
    }

    const response = await fetch(url, { headers });

    console.log(`[proxy] Bluesky status: ${response.status}`);

    if (!response.ok) {
      const body = await response.text();
      console.log(`[proxy] Bluesky error response: ${body.substring(0, 300)}`);

      // If 401 (unauthorized), try to re-authenticate
      if (response.status === 401) {
        console.log('[bluesky] Token expired, re-authenticating...');
        blueskyAccessToken = await authenticateBluesky();

        // Retry request with new token
        if (blueskyAccessToken) {
          headers['Authorization'] = `Bearer ${blueskyAccessToken}`;
          const retryResponse = await fetch(url, { headers });
          const retryData = await retryResponse.json();
          return res.json(retryData);
        }
      }

      throw new Error(`Bluesky API returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[proxy] Bluesky error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve static files AFTER api routes ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, async () => {
  console.log(`\n  Solar Loop Viewer running at:`);
  console.log(`  → http://localhost:${PORT}\n`);

  // Authenticate with Bluesky on startup
  blueskyAccessToken = await authenticateBluesky();
});