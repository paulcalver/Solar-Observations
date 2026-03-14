// Project: Solar Observations
// Author:  Paul Calver <pcalv001@gold.ac.uk>
//
// ── server.js ─────────────────────────────────────────────────────────────────
// Express backend for the Solar Loop installation.
//
// Responsibilities:
//   1. Proxy requests to the Helioviewer API (avoids CORS issues in the browser)
//   2. Queue and poll a 24-hour solar timelapse from Helioviewer, then cache it
//      so multiple visitors share one render rather than each triggering their own
//   3. Fetch Bluesky posts about the sun, run them through a regex pre-screen,
//      then a Gemini semantic filter, and serve the curated results
//   4. Log kept posts to Airtable for review
//   5. Authenticate with Bluesky and silently refresh the token before it expires
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Bluesky authentication state ──────────────────────────
// Stored in memory; refreshed every 90 minutes (tokens expire after ~2 hours)
let blueskyAccessToken = null;


// ── Solar video cache ─────────────────────────────────────
// The cache persists across server restarts by writing to solar-cache.json.
// TTL is 25 hours so the daily scheduler always has a valid video to serve
// even if the scheduled refresh runs slightly late.
const CACHE_FILE = path.join(__dirname, 'solar-cache.json');
const CACHE_TTL = 25 * 60 * 60 * 1000; // 25 hours — safety net between daily refreshes

// In-memory cache: populated from disk on startup, updated after each generation
let videoCache = {
  url: null,       // full URL of the mp4 on Helioviewer's CDN
  timestamp: null  // Date.now() when the URL was obtained
};

// Read a previously saved cache file into memory on startup.
// Silently ignores missing or malformed files.
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

// Persist the current in-memory cache to disk so it survives server restarts.
function saveCacheToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ url: videoCache.url, timestamp: videoCache.timestamp }));
  } catch (err) {
    console.warn('[solar] Could not save disk cache:', err.message);
  }
}

// ── Solar generation progress (shared across requests) ────
// Updated live during generateSolarVideo() so the browser can poll
// /api/solar-progress and show a frame counter to the visitor.
let solarProgress = {
  active: false,        // true while a generation is in flight
  progress: 0,          // 0–1 fraction reported by Helioviewer
  framesProcessed: 0,   // absolute frame count (displayed in UI)
  numFrames: 720,       // total frames in the requested movie
  statusLabel: ''       // human-readable status string from Helioviewer
};

// ── Solar progress endpoint ───────────────────────────────
// Polled every 2 seconds by sun.js while a video is generating.
app.get('/api/solar-progress', (req, res) => {
  res.json(solarProgress);
});

// ── Proxy endpoint for Helioviewer API ───────────────────────
// Declared BEFORE static files so it takes priority.
// Uses raw query string to preserve bracket characters
// that Express's query parser would mangle (e.g. layers=[13,1,100]).
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

    // Try to parse as JSON; fall back to forwarding raw text if not valid JSON
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
// Uses the AT Protocol createSession endpoint to exchange credentials
// for a short-lived JWT. Returns the token, or null if auth fails/
// credentials are missing (the app still works unauthenticated, just
// with tighter API rate limits).
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
    return data.accessJwt; // JWT used as Bearer token in subsequent requests
  } catch (err) {
    console.error('[bluesky] Authentication error:', err.message);
    return null;
  }
}

// ── Solar video generation (shared by endpoint + scheduler) ──
// Queues a 24-hour solar timelapse on Helioviewer, then polls until it is
// ready (status 2) or failed (status 3). Updates solarProgress throughout
// so the browser can show a live frame counter. Saves the resulting URL
// to both in-memory and disk cache before returning.
async function generateSolarVideo() {
  const now = new Date();
  const endTime = new Date(now);
  // Go back exactly 24 hours for a full-day timelapse
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Helioviewer expects ISO 8601 without milliseconds
  const formatISO = d => d.toISOString().replace('.000Z', 'Z');

  // Build the queue URL:
  //   layers=[13,1,100]  → SDO/AIA 304 Å (ultraviolet, chromosphere)
  //   imageScale=2.42    → arcseconds per pixel
  //   x1/y1/x2/y2       → bounding box in arcseconds (full-disk)
  //   cadence=120        → one frame every 2 minutes
  //   maxFrames=720      → 720 frames × 2 min = 24 hours
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

  // Poll every 3 seconds for up to 6 minutes (120 × 3s)
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
    // Update shared progress so the /api/solar-progress endpoint stays current
    solarProgress = {
      active: true,
      progress,
      framesProcessed: statusData.framesProcessed ?? Math.round(progress * numFrames),
      numFrames,
      statusLabel: statusData.statusLabel || ''
    };

    console.log(`[solar] Poll ${polls}/${maxPolls}: ${statusData.statusLabel} (${Math.round(progress * 100)}%)`);

    if (statusData.status === 2) {
      // Status 2 = complete; grab the URL and stop polling
      videoUrl = statusData.url;
      break;
    } else if (statusData.status === 3) {
      // Status 3 = error reported by Helioviewer
      throw new Error(statusData.error || 'Movie generation failed');
    }
  }

  // Reset progress state now that generation is done
  solarProgress = { active: false, progress: 1, framesProcessed: 0, numFrames: 0, statusLabel: '' };

  if (!videoUrl) throw new Error('Movie generation timed out');

  // Persist URL so future requests skip generation entirely
  videoCache.url = videoUrl;
  videoCache.timestamp = Date.now();
  saveCacheToDisk();

  console.log('[solar] ✓ Video generated and cached');
  return videoUrl;
}

// ── Daily midnight scheduler ───────────────────────────────
// Calculates the milliseconds until the next UTC midnight and sets a
// one-shot timeout. When it fires it regenerates the video, then
// schedules itself again for the following midnight — so this keeps
// running indefinitely without drift accumulating over multiple days.
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
// Wipes both in-memory and disk cache. The next request to /api/solar-video
// will trigger a fresh generation.
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
// REFRESH_TOKEN is optional; omit it in .env to allow unauthenticated access.
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
// Main endpoint called by sun.js on page load.
// Returns a cached URL immediately if one exists and is fresh.
// Otherwise generates a new video (which may take several minutes).
// On any generation failure, falls back to the local backup video
// so the installation never shows an empty screen.
app.get('/api/solar-video', async (req, res) => {
  // Prevent the browser from caching this response — we manage caching ourselves
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
    console.error('[solar] Generation error:', err.message, err.cause ? `— cause: ${err.cause?.message || err.cause}` : '');
    // Serve the bundled backup so the screen stays active during API outages
    console.log('[solar] Using local backup video');
    res.json({ url: '/backup_sun_movie.mp4', cached: false });
  }
});

// ── Bluesky: search phrases ────────────────────────────────
// Each phrase is searched independently in parallel. They are chosen to
// surface genuine first-person observations about the physical sun and light,
// rather than news, sports, or metaphorical uses of the word "sun".
const SEARCH_PHRASES = [
  'the sun felt',
  'the sun looked',
  'sunlight on',
  'watching the sunset',
  'sunrise this morning',
  'sun on my',
  'beams of light',
  'sunshine was',
  'beautiful sun',
  'the light today',
  'the sky was',
  'warm glow',
  'light through',
  'the sun was so',
  'rays of sun',
  'sunset tonight',
  'morning light',
  'golden hour',
  'sun hitting'
];

// ── Bluesky: fetch posts for one phrase ───────────────────
// Searches Bluesky for a single phrase, returning up to 50 recent
// English posts. Automatically retries with a fresh token if the
// current JWT has expired.
async function fetchPhrase(phrase) {
  const url = `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(phrase)}&limit=50&sort=latest&lang=en`;
  const headers = {
    'Accept': 'application/json',
    // Mimic a real browser to avoid being blocked by bot-detection
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };
  if (blueskyAccessToken) headers['Authorization'] = `Bearer ${blueskyAccessToken}`;

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const body = await response.text();
    // Handle expired/invalid token — re-auth and retry once
    let isAuthError = response.status === 401;
    if (!isAuthError) {
      try { isAuthError = JSON.parse(body).error === 'ExpiredToken'; } catch {}
    }
    if (isAuthError) {
      blueskyAccessToken = await authenticateBluesky();
      if (blueskyAccessToken) {
        headers['Authorization'] = `Bearer ${blueskyAccessToken}`;
        const retry = await fetch(url, { headers });
        if (retry.ok) return (await retry.json()).posts || [];
      }
    }
    return []; // Return empty on any unrecoverable error
  }

  const data = await response.json();
  return data.posts || [];
}

// ── Bluesky: pre-screen with fast regex ───────────────────
// First-pass filter applied before sending posts to Gemini.
// Removes obvious noise cheaply (duplicates, URLs, sports, news,
// date refs, offensive content) so Gemini sees only plausible candidates.
function preScreenPosts(rawPosts) {
  const seen = new Set(); // deduplicate by exact text
  const results = [];

  for (const post of rawPosts) {
    const text = post.record?.text || '';
    // Skip empty posts and anything longer than a standard tweet
    if (!text || text.length === 0 || text.length > 280) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    // Must contain a sun-related word
    if (!/\b(sun|sunshine|sunlight|sunset|sunrise|golden hour|solar|sunny)\b/i.test(text)) continue;
    // No URLs — suggests promotional or article-sharing content
    if (/https?:\/\/|www\.|[a-z0-9-]+\.(com|org|net|io|co)/i.test(text)) continue;
    // Max one hashtag — more than one suggests a marketing post
    if ((text.match(/#/g) || []).length > 1) continue;
    // No newspaper / news-style content
    if (/sun-times|daily sun|the sun newspaper|telegraph|the sun (reports?|says?|published|wrote|exclusive|revealed|claims?)|in the sun|on the sun|from the sun|breaking|headlines?|article|news:/i.test(text)) continue;
    // No sports
    if (/phoenix suns|gold coast suns|jacksonville suns|the suns (win|lose|beat|play|vs|defeat|scored)|suns (game|win|lose|beat|play|vs|defeat|scored)|#nba|#afl|#nfl|#mlb|#nhl|afl grand final|football|basketball|baseball|soccer/i.test(text)) continue;
    // No date references (Sunday, Sun 16th, etc.) — "sun" here is short for Sunday
    if (/\bsunday\b|sun[,\s]+\d{1,2}(st|nd|rd|th)?|sun[,\s]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|on sun\b|this sun\b|next sun\b|last sun\b/i.test(text)) continue;
    // No explicit / offensive content
    if (/sex|dungeon|nsfw|18\+|explicit|porn|dick|cock|cumshot|fuck|shit|damn|hell(?!o)|ass(?!ume)|bitch/i.test(text)) continue;
    // No hate speech
    if (/racist|propaganda|racism|antisemitic|antisemitism|islamophob|xenophob|homophob|transphob|bigot|nazi|kkk|white supremac/i.test(text)) continue;
    // No emoji — keeps the display clean and text-focused
    if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(text)) continue;
    // No birthday mentions
    if (/birthday/i.test(text)) continue;
    // No photography hashtags or VRChat references
    if (/#photograph|#photo\b|#vrc|vrchat/i.test(text)) continue;

    results.push({
      text,
      // Strip the .bsky.social suffix so the author handle reads cleanly in the UI
      author: post.author?.handle?.replace('.bsky.social', '') || 'unknown',
      time: post.record?.createdAt || new Date().toISOString()
    });
  }

  return results;
}

// ── Airtable: track already-logged posts to avoid duplicates
// In-memory set; resets on server restart, but that's acceptable
// since the table is primarily used for archival review.
const loggedTexts = new Set();

// ── Airtable: log kept posts (one row per post) ───────────
// Called after Gemini filtering to record which posts were displayed.
// Sends records in batches of 10 to comply with the Airtable API limit.
// Silently skips if credentials are missing.
async function logToAirtable(sentPosts, keptIndices) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) return;

  const keptSet = new Set(keptIndices);
  // Only log posts that Gemini kept AND that haven't been logged this session
  const keptPosts = sentPosts
    .filter((_, i) => keptSet.has(i))
    .filter(p => !loggedTexts.has(p.text));
  if (keptPosts.length === 0) return;

  const batchTime = new Date().toISOString();

  // Airtable allows max 10 records per request — send in batches
  const BATCH_SIZE = 10;
  let logged = 0;

  for (let i = 0; i < keptPosts.length; i += BATCH_SIZE) {
    const batch = keptPosts.slice(i, i + BATCH_SIZE);
    try {
      const response = await fetch(`https://api.airtable.com/v0/${baseId}/GeminiLog`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          records: batch.map(p => ({
            fields: {
              'Batch Time': batchTime,
              'Text': p.text,
              'Author': p.author,
              'Post Time': p.time,
              'Verdict': 'kept'
            }
          }))
        })
      });

      if (!response.ok) {
        const err = await response.text();
        console.warn(`[airtable] Log failed ${response.status}: ${err.substring(0, 200)}`);
        break; // Stop on first batch error to avoid flooding with failures
      }
      batch.forEach(p => loggedTexts.add(p.text)); // Mark as logged
      logged += batch.length;
    } catch (err) {
      console.warn('[airtable] Log error:', err.message);
      break;
    }
  }

  if (logged > 0) console.log(`[airtable] ✓ Logged ${logged} kept posts`);
}

// ── Gemini: semantic filter ────────────────────────────────
// Second-pass filter using Google Gemini 2.5 Flash to understand
// the meaning of posts — catches nuanced cases that regex misses
// (e.g. metaphors that passed the keyword check, subtle sports refs).
// Falls back to returning all pre-screened posts if the API is
// unavailable or over quota.
async function geminiFilter(posts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[gemini] No API key — skipping semantic filter');
    return posts;
  }

  if (posts.length === 0) return posts;

  // Number each post so Gemini can reference them by index in its response
  const numbered = posts.map((p, i) => `${i + 1}. ${p.text}`).join('\n');

  const prompt = `You are filtering social media posts for an art installation that displays poetic, sensory observations about the physical sun and sunlight.

Keep a post ONLY if it is a genuine first-person or observational account of:
- The physical sun in the sky (its appearance, warmth, light, colour)
- Sunrise or sunset as a natural phenomenon
- The quality of sunlight (soft, bright, golden, harsh, gentle, etc.)
- The feeling of sunlight on the body or surroundings

Reject posts that are:
- About newspapers, media outlets, or news stories
- Sports references (teams, games, scores)
- Metaphors or idioms where "sun" doesn't refer to the actual sun
- Promotional, commercial, or spam content
- Philosophical or political commentary that uses the sun as a symbol only
- Birthday or celebration mentions
- Vague or unrelated to direct solar/sunlight experience
- Explicit, offensive, or hate speech

Posts:
${numbered}

Reply with ONLY a JSON array of the numbers to KEEP, e.g. [1, 3, 7]. No explanation.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    console.log(`[gemini] Calling API (gemini-2.5-flash) with ${posts.length} posts (key: ${apiKey.substring(0, 8)}...)`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // temperature: 0 for deterministic output; thinkingBudget: 0 disables
        // chain-of-thought reasoning to reduce latency and token usage
        generationConfig: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } }
      })
    });

    console.log(`[gemini] Response status: ${response.status}`);

    if (!response.ok) {
      const err = await response.text();
      if (response.status === 429) {
        console.warn(`[gemini] ⚠️  Quota exceeded (429 TooManyRequests) — falling back to pre-screened posts\n[gemini] Detail: ${err}`);
      } else {
        console.warn(`[gemini] API error ${response.status}: ${err}`);
      }
      return posts; // fallback: show pre-screened posts rather than nothing
    }

    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[gemini] Raw response: ${raw.trim()}`);

    // Extract the JSON array from the response (e.g. "[1, 3, 7]")
    const match = raw.match(/\[[\d,\s]+\]/);
    if (!match) {
      console.warn('[gemini] Could not parse response, keeping all pre-screened posts');
      return posts;
    }

    const keptIndices = JSON.parse(match[0]).map(n => n - 1); // convert 1-based to 0-based
    const keepSet = new Set(keptIndices);
    const filtered = posts.filter((_, i) => keepSet.has(i));
    console.log(`[gemini] ✓ Filtering complete — kept ${filtered.length}/${posts.length} posts`);

    // Log to Airtable fire-and-forget — errors here should not block the API response
    logToAirtable(posts, keptIndices).catch(() => {});

    return filtered;
  } catch (err) {
    console.error('[gemini] Error:', err.message);
    return posts; // fallback on any unexpected error
  }
}

// ── Filtered posts cache (avoids hammering Gemini) ────────
// Gemini has generous but finite daily quotas. Caching for 10 minutes
// means a busy installation makes at most ~144 Gemini calls per day.
const POSTS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let postsCache = { posts: null, timestamp: null };

// ── Filtered Bluesky endpoint ──────────────────────────────
// Full pipeline: fetch all search phrases in parallel → regex pre-screen
// → shuffle and cap at 80 → Gemini semantic filter → format timestamps.
// Results are cached for 10 minutes to stay within Gemini rate limits.
// On error, returns stale cache if available so the UI always has content.
app.get('/api/bluesky/filtered', async (_req, res) => {
  // Return cached result if still fresh
  if (postsCache.posts && postsCache.timestamp && (Date.now() - postsCache.timestamp) < POSTS_CACHE_TTL) {
    const age = Math.floor((Date.now() - postsCache.timestamp) / 1000);
    console.log(`[bluesky] Cache hit (age: ${age}s), returning ${postsCache.posts.length} posts`);
    return res.json({ posts: postsCache.posts });
  }

  console.log('[bluesky] /api/bluesky/filtered — fetching all phrases in parallel...');

  try {
    // Fetch all search phrases simultaneously — using allSettled so one
    // failed phrase doesn't abort the entire batch
    const results = await Promise.allSettled(
      SEARCH_PHRASES.map(phrase => fetchPhrase(phrase))
    );

    // Flatten fulfilled results; silently drop rejected ones
    const allRaw = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    console.log(`[bluesky] ${allRaw.length} raw posts from ${SEARCH_PHRASES.length} phrases`);

    // Pre-screen with regex (fast, removes obvious junk)
    const preScreened = preScreenPosts(allRaw);
    console.log(`[bluesky] ${preScreened.length} posts after pre-screen`);

    // Shuffle before capping so we don't always send the same phrases' posts
    // to Gemini. Cap at 80 to stay comfortably within token limits.
    const shuffled = preScreened.sort(() => Math.random() - 0.5).slice(0, 80);

    // Semantic filter with Gemini
    const filtered = await geminiFilter(shuffled);

    // Convert ISO timestamps to human-readable relative strings for the UI
    const now = Date.now();
    const formatted = filtered.map(p => {
      const then = new Date(p.time).getTime();
      const diffMs = now - then;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);
      let timeStr;
      if (diffMins < 1) timeStr = 'just now';
      else if (diffMins < 60) timeStr = `${diffMins}m ago`;
      else if (diffHours < 24) timeStr = `${diffHours}h ago`;
      else timeStr = `${diffDays}d ago`;

      return { text: p.text, author: p.author, time: timeStr };
    });

    // Store in cache
    postsCache = { posts: formatted, timestamp: Date.now() };

    console.log(`[bluesky] Returning ${formatted.length} filtered posts (cached for ${POSTS_CACHE_TTL / 60000} min)`);
    res.json({ posts: formatted });
  } catch (err) {
    console.error('[bluesky] /api/bluesky/filtered error:', err.message);
    // Return stale cache rather than an empty array — keeps the UI populated
    if (postsCache.posts) {
      console.log('[bluesky] Returning stale cache after error');
      return res.json({ posts: postsCache.posts });
    }
    res.json({ posts: [] });
  }
});

// ── Proxy endpoint for Bluesky API ────────────────────────────
// General-purpose proxy for raw Bluesky search requests. Handles
// token expiry with a transparent re-auth + retry, and returns an
// empty posts array on failure so the client can fall back gracefully.
app.get('/api/bluesky/search', async (req, res) => {
  const fullUrl = req.originalUrl;
  const qsIndex = fullUrl.indexOf('?');
  const rawQuery = qsIndex !== -1 ? fullUrl.substring(qsIndex) : '';

  // Use authenticated endpoint (bsky.social) instead of the public endpoint
  // for higher rate limits and access to more results
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

        // Retry the original request with the new token
        if (blueskyAccessToken) {
          headers['Authorization'] = `Bearer ${blueskyAccessToken}`;
          const retryResponse = await fetch(url, { headers });
          const retryData = await retryResponse.json();
          return res.json(retryData);
        }
      }

      // Return empty result instead of propagating the error — let the
      // client fall back to curated posts rather than showing an error state
      console.log('[bluesky] API error, returning empty result for fallback');
      return res.json({ posts: [] });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[proxy] Bluesky error:', err.message);
    // Return empty result for fallback instead of a 500 error
    res.json({ posts: [] });
  }
});

// ── Serve static files AFTER api routes ──────────────────────
// Order matters: API routes above take priority over anything in /public
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, async () => {
  console.log(`\n  Solar Loop Viewer running at:`);
  console.log(`  → http://localhost:${PORT}\n`);

  // On startup: restore disk cache, kick off the daily scheduler,
  // and authenticate with Bluesky
  loadCacheFromDisk();
  scheduleDailyRefresh();
  blueskyAccessToken = await authenticateBluesky();

  // Confirm Airtable credentials are present
  const atToken = process.env.AIRTABLE_TOKEN;
  const atBase = process.env.AIRTABLE_BASE_ID;
  if (atToken && atBase) {
    console.log(`[airtable] Configured — base: ${atBase.substring(0, 6)}...${atBase.slice(-4)}, token: ${atToken.substring(0, 6)}...`);
  } else {
    console.warn('[airtable] No credentials — logging disabled');
  }

  // Bluesky access tokens expire after ~2 hours — refresh every 90 minutes
  // to stay ahead of expiry without interrupting live requests
  setInterval(async () => {
    console.log('[bluesky] Proactive token refresh...');
    blueskyAccessToken = await authenticateBluesky();
  }, 90 * 60 * 1000);
});