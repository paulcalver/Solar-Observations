require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Bluesky authentication state ──────────────────────────
let blueskyAccessToken = null;

// ── Solar video cache ─────────────────────────────────────
const CACHE_FILE = path.join(__dirname, 'solar-cache.json');
const CACHE_TTL = 25 * 60 * 60 * 1000; // 25 hours — safety net between daily refreshes

let videoCache = {
  url: null,
  timestamp: null
};

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (data.url && data.timestamp && (Date.now() - data.timestamp) < CACHE_TTL) {
        videoCache = { url: data.url, timestamp: data.timestamp };
        console.log(`[solar] Loaded disk cache (age: ${Math.floor((Date.now() - data.timestamp) / 60000)}m)`);
      }
    }
  } catch (err) {
    console.warn('[solar] Could not load disk cache:', err.message);
  }
}

function saveCacheToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ url: videoCache.url, timestamp: videoCache.timestamp }));
  } catch (err) {
    console.warn('[solar] Could not save disk cache:', err.message);
  }
}

// ── Solar generation progress (shared across requests) ────
let solarProgress = {
  active: false,
  progress: 0,
  framesProcessed: 0,
  numFrames: 720,
  statusLabel: ''
};

// ── Solar progress endpoint ───────────────────────────────
app.get('/api/solar-progress', (req, res) => {
  res.json(solarProgress);
});

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

// ── Solar video generation (shared by endpoint + scheduler) ──
async function generateSolarVideo() {
  const now = new Date();
  const endTime = new Date(now);
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const formatISO = d => d.toISOString().replace('.000Z', 'Z');

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
  if (!queueResponse.ok) throw new Error(`Helioviewer queue error: ${queueResponse.status}`);
  const queueData = await queueResponse.json();
  if (!queueData.id) throw new Error('Failed to queue movie');

  const movieId = queueData.id;
  console.log(`[solar] Movie queued: ${movieId}`);

  const maxPolls = 120;
  const pollInterval = 3000;
  let polls = 0;
  let videoUrl = null;

  solarProgress = { active: true, progress: 0, framesProcessed: 0, numFrames: 720, statusLabel: 'Queued' };

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

    const progress = statusData.progress || 0;
    const numFrames = statusData.numFrames || 720;
    solarProgress = {
      active: true,
      progress,
      framesProcessed: statusData.framesProcessed ?? Math.round(progress * numFrames),
      numFrames,
      statusLabel: statusData.statusLabel || ''
    };

    console.log(`[solar] Poll ${polls}/${maxPolls}: ${statusData.statusLabel} (${Math.round(progress * 100)}%)`);

    if (statusData.status === 2) {
      videoUrl = statusData.url;
      break;
    } else if (statusData.status === 3) {
      throw new Error(statusData.error || 'Movie generation failed');
    }
  }

  solarProgress = { active: false, progress: 1, framesProcessed: 0, numFrames: 0, statusLabel: '' };

  if (!videoUrl) throw new Error('Movie generation timed out');

  videoCache.url = videoUrl;
  videoCache.timestamp = Date.now();
  saveCacheToDisk();

  console.log('[solar] ✓ Video generated and cached');
  return videoUrl;
}

// ── Daily midnight scheduler ───────────────────────────────
function scheduleDailyRefresh() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  ));
  const ms = nextMidnight.getTime() - now.getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  console.log(`[solar] Daily refresh scheduled in ${h}h ${m}m (next UTC midnight)`);

  setTimeout(async () => {
    console.log('[solar] Running scheduled daily video generation...');
    try {
      await generateSolarVideo();
    } catch (err) {
      console.error('[solar] Scheduled generation failed:', err.message);
    }
    scheduleDailyRefresh(); // schedule next day regardless
  }, ms);
}

// ── Reset cache endpoint (clears cache without regenerating) ──
// Trigger with: GET /api/solar-reset (or reloadSun() in the browser console)
app.get('/api/solar-reset', (_req, res) => {
  videoCache = { url: null, timestamp: null };
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  } catch (err) {
    console.warn('[solar] Could not delete disk cache:', err.message);
  }
  console.log('[solar] Cache cleared — next request will generate a fresh video');
  res.json({ ok: true });
});

// ── Manual refresh endpoint (for external cron services) ──
// Trigger with: GET /api/refresh?token=YOUR_REFRESH_TOKEN
app.get('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_TOKEN;
  if (secret && req.query.token !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.log('[solar] Manual refresh triggered');
  try {
    await generateSolarVideo();
    res.json({ ok: true, url: videoCache.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Solar video endpoint ───────────────────────────────────
app.get('/api/solar-video', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (videoCache.url && videoCache.timestamp) {
    const age = Date.now() - videoCache.timestamp;
    if (age < CACHE_TTL) {
      console.log(`[solar] Cache hit (age: ${Math.floor(age / 60000)}m)`);
      return res.json({ url: videoCache.url, cached: true });
    }
  }

  console.log('[solar] Cache miss, generating new video...');
  try {
    const url = await generateSolarVideo();
    res.json({ url, cached: false });
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

      // Bluesky returns 400 for ExpiredToken and 401 for InvalidToken
      let isAuthError = response.status === 401;
      if (!isAuthError) {
        try { isAuthError = JSON.parse(body).error === 'ExpiredToken'; } catch {}
      }

      if (isAuthError) {
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

  loadCacheFromDisk();
  scheduleDailyRefresh();
  blueskyAccessToken = await authenticateBluesky();

  // Bluesky access tokens expire after ~2 hours — refresh every 90 minutes
  setInterval(async () => {
    console.log('[bluesky] Proactive token refresh...');
    blueskyAccessToken = await authenticateBluesky();
  }, 90 * 60 * 1000);
});