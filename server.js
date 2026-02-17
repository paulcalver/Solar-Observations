require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Bluesky authentication state ──────────────────────────
let blueskyAccessToken = null;

// ── Solar video cache ─────────────────────────────────────
let videoCache = {
  url: null,
  timestamp: null,
  expiresIn: 6 * 60 * 60 * 1000 // 6 hours
};

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

// ── Solar video generation endpoint ───────────────────────
app.get('/api/solar-video', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // Check cache first
  if (videoCache.url && videoCache.timestamp) {
    const age = Date.now() - videoCache.timestamp;
    if (age < videoCache.expiresIn) {
      console.log(`[solar] Cache hit (age: ${Math.floor(age / 60000)}m)`);
      return res.json({ url: videoCache.url, cached: true });
    }
  }

  console.log('[solar] Cache miss, generating new video...');

  try {
    // Calculate 24-hour period
    const now = new Date();
    const endTime = new Date(now);
    const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const formatISO = d => d.toISOString().replace('.000Z', 'Z');

    // Queue movie request (URL built manually to preserve brackets in layers param)
    const queueUrl = `https://api.helioviewer.org/v2/queueMovie/?` +
      `startTime=${formatISO(startTime)}` +
      `&endTime=${formatISO(endTime)}` +
      `&layers=[13,1,100]` +
      `&events=` +
      `&eventsLabels=false` +
      `&imageScale=2.42` +
      `&x0=0&y0=0&x1=-1306.8&y1=-1306.8&x2=1306.8&y2=1306.8` +
      `&width=1080` +
      `&height=1080` +
      `&format=mp4` +
      `&frameRate=15` +
      `&cadence=120` +
      `&maxFrames=720`;
    console.log('[solar] Queueing movie...');

    const queueResponse = await fetch(queueUrl);
    if (!queueResponse.ok) {
      throw new Error(`Helioviewer queue error: ${queueResponse.status}`);
    }
    const queueData = await queueResponse.json();

    if (!queueData.id) {
      throw new Error('Failed to queue movie');
    }

    const movieId = queueData.id;
    console.log(`[solar] Movie queued: ${movieId}`);

    // Poll for completion
    const maxPolls = 120;
    const pollInterval = 3000;
    let polls = 0;
    let videoUrl = null;

    while (polls < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      polls++;

      const statusUrl = `https://api.helioviewer.org/v2/getMovieStatus/?id=${movieId}&format=mp4&verbose=true`;
      const statusResponse = await fetch(statusUrl);
      if (!statusResponse.ok) {
        console.warn(`[solar] Poll error: ${statusResponse.status}`);
        continue;
      }
      const statusData = await statusResponse.json();

      console.log(`[solar] Poll ${polls}/${maxPolls}: ${statusData.statusLabel} (${Math.round((statusData.progress || 0) * 100)}%)`);

      if (statusData.status === 2) {
        // Complete
        videoUrl = statusData.url;
        break;
      } else if (statusData.status === 3) {
        // Error
        throw new Error(statusData.error || 'Movie generation failed');
      }
    }

    if (!videoUrl) {
      throw new Error('Movie generation timed out');
    }

    // Cache the result
    videoCache.url = videoUrl;
    videoCache.timestamp = Date.now();

    console.log('[solar] ✓ Video generated and cached');
    res.json({ url: videoUrl, cached: false });

  } catch (err) {
    console.error('[solar] Generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy endpoint for Bluesky API ────────────────────────────
app.get('/api/bluesky/search', async (req, res) => {
  const fullUrl = req.originalUrl;
  const qsIndex = fullUrl.indexOf('?');
  const rawQuery = qsIndex !== -1 ? fullUrl.substring(qsIndex) : '';

  // Use authenticated endpoint (bsky.social) instead of public endpoint
  const url = `https://bsky.social/xrpc/app.bsky.feed.searchPosts${rawQuery}`;

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

      // Return empty result instead of error - let client handle fallback
      console.log('[bluesky] API error, returning empty result for fallback');
      return res.json({ posts: [] });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[proxy] Bluesky error:', err.message);
    // Return empty result for fallback instead of 500 error
    res.json({ posts: [] });
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