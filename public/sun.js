// Project: Solar Observations
// Author:  Paul Calver <pcalv001@gold.ac.uk>
//
// ── sun.js ────────────────────────────────────────────────────────────────────
// Client-side controller for the solar video panel.
//
// Flow:
//   1. On load, check localStorage for a fresh cached URL (avoids a round-trip
//      to the server if this browser tab has loaded the video in the last 6h)
//   2. If no local cache, call /api/solar-video — the server either returns a
//      cached URL instantly or queues a new Helioviewer render (takes minutes)
//   3. While waiting for generation, cycle loading messages and poll
//      /api/solar-progress every 2s to display a live frame counter
//   4. Once the URL is available, load the mp4 into the <video> element,
//      fade it in, and signal `solarVideoReady` so bluesky.js shows posts
//
// reloadSun() is exposed on window for manual debugging from the console.
// ─────────────────────────────────────────────────────────────────────────────

(function() {
  // ── Configuration ──────────────────────────────────────────
  // Video generation is handled server-side with caching — this file
  // only fetches the resulting URL and manages the playback UI.
  const now = new Date();
  const endTime = new Date(now); // Snapshot of "now" used for display and cache key

  // ── Video-ready signal (consumed by bluesky.js) ───────────
  // bluesky.js waits on this promise before showing posts, so the
  // text overlay doesn't appear before the video is visible.
  let resolveVideoReady;
  window.solarVideoReady = new Promise(r => { resolveVideoReady = r; });

  // ── Loading messages ──────────────────────────────────────
  // Rotated every 3.5 seconds in the status overlay while the server
  // is generating the video — gives the visitor context about the process.
  const LOADING_MESSAGES = [
    'Requesting solar data...',
    'Queuing video from Helioviewer...',
    'Rendering 24 hours of solar activity...',
    'Processing ultraviolet imagery...',
    'Compositing chromosphere frames...'
  ];
  let loadingMsgInterval = null;

  // ── DOM refs ───────────────────────────────────────────────
  const statusOverlay = document.getElementById('status-overlay');
  const statusText = document.getElementById('status-text');
  const videoContainer = document.getElementById('video-container');
  const videoEl = document.getElementById('solar-video');
  const infoBar = document.getElementById('info-bar');
  const infoDate = document.getElementById('info-date');

  // ── State ──────────────────────────────────────────────────
  const currentSourceId = 13; // SDO/AIA 304 Å wavelength (ultraviolet chromosphere)
  let isLoading = false;       // Guard against concurrent load calls
  let progressPollInterval = null; // Handle for the frame-counter polling interval

  // ── Cache helpers ──────────────────────────────────────────
  // Caches the video URL in localStorage so repeat visits within 6 hours
  // skip the server request entirely. Key is per-source and per-day so
  // stale entries from yesterday are naturally superseded.

  function getCacheKey(sourceId, date) {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return `solar-video-${sourceId}-${dateStr}`;
  }

  // Returns cached data if found and less than 6 hours old, else null.
  function getCachedVideo(sourceId) {
    const key = getCacheKey(sourceId, endTime);
    const cached = localStorage.getItem(key);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        const cacheAge = Date.now() - data.timestamp;
        if (cacheAge < 6 * 60 * 60 * 1000) { // 6 hours
          return data;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  // Saves the video URL and current timestamp to localStorage.
  function cacheVideo(sourceId, videoUrl) {
    const key = getCacheKey(sourceId, endTime);
    const data = {
      url: videoUrl,
      timestamp: Date.now(),
      date: endTime.toISOString()
    };
    localStorage.setItem(key, JSON.stringify(data));
  }

  // ── Sizing ─────────────────────────────────────────────────
  // The Helioviewer video is 1080×1080 but the sun disk only fills ~75%
  // of the frame. Scale the container so the disk edge aligns with the
  // viewport edge, making the sun appear to fill the full screen height.
  function getVideoSize() {
    const minDim = window.innerHeight;
    //const minDim = Math.min(window.innerWidth, window.innerHeight);
    const size = minDim * (1080 / 900); // 900 ≈ the visible disk diameter in pixels
    return Math.round(size);
  }

  function applySize() {
    const size = getVideoSize();
    videoContainer.style.width = size + 'px';
    videoContainer.style.height = size + 'px';
  }

  window.addEventListener('resize', applySize);
  applySize(); // Apply immediately on load

  // ── Format date for display ────────────────────────────────
  // Uses UTC values so the displayed date matches the actual solar data
  // range regardless of the visitor's local timezone.
  function formatDisplayDate(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  // ── Load video into player ─────────────────────────────────
  // Sets the video src, waits for canplay (enough data to start), then
  // hides the loading overlay, fades in the container, and resolves
  // solarVideoReady so bluesky.js can begin showing posts.
  function loadVideo(movieUrl) {
    return new Promise((resolve, reject) => {
      videoEl.src = movieUrl;
      videoEl.load();

      videoEl.addEventListener('canplay', function onCanPlay() {
        videoEl.removeEventListener('canplay', onCanPlay);

        statusOverlay.style.display = 'none';
        videoContainer.style.display = 'block';
        videoContainer.classList.remove('fade-in');
        // Removing and re-adding the class only works if the browser
        // has had a chance to recalculate styles — offsetWidth forces that reflow
        void videoContainer.offsetWidth;
        videoContainer.classList.add('fade-in');
        infoBar.classList.add('visible');

        infoDate.textContent = formatDisplayDate(endTime);

        videoEl.play();
        isLoading = false;
        resolveVideoReady(); // Unblock bluesky.js
        resolve();
      }, { once: true });

      videoEl.addEventListener('error', function onError() {
        videoEl.removeEventListener('error', onError);
        isLoading = false;
        reject(new Error('Video failed to load: ' + (videoEl.error?.message || 'unknown error')));
      }, { once: true });
    });
  }

  // ── Queue and load movie ───────────────────────────────────
  // Main entry point. Checks the local cache first, then falls back to
  // the server endpoint. Shows a progress UI while waiting. On failure,
  // displays a friendly error message and still resolves solarVideoReady
  // so bluesky.js shows posts even if the video is unavailable.
  async function loadSolarMovie() {
    if (isLoading) return; // Prevent concurrent calls (e.g. from a resize event)
    isLoading = true;

    // Show loading overlay with spinner
    statusOverlay.style.display = 'flex';
    statusOverlay.innerHTML = `
      <div class="spinner"></div>
      <div id="status-text">Requesting solar data...</div>
      <div id="frame-counter"></div>
    `;
    const statusTextEl = document.getElementById('status-text');
    const frameCounterEl = document.getElementById('frame-counter');
    videoContainer.style.display = 'none';
    infoBar.classList.remove('visible');

    // Check localStorage before hitting the server — fast path for repeat visits
    const cached = getCachedVideo(currentSourceId);
    if (cached && cached.url) {
      console.log('Using client cache:', cached.url);
      statusTextEl.textContent = 'Loading from cache...';
      try {
        await loadVideo(cached.url);
        return;
      } catch (err) {
        // Cached URL may have expired on Helioviewer's CDN — fall through to fetch
        console.warn('Cached video failed, fetching new one:', err);
      }
    }

    try {
      statusTextEl.textContent = 'Requesting solar video...';

      // Rotate loading messages every 3.5s while waiting for the server
      let msgIndex = 0;
      loadingMsgInterval = setInterval(() => {
        msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
        statusTextEl.textContent = LOADING_MESSAGES[msgIndex];
      }, 3500);

      // Poll /api/solar-progress every 2s to show a live frame counter
      // (only visible while the server is actively rendering)
      progressPollInterval = setInterval(async () => {
        try {
          const r = await fetch('/api/solar-progress');
          const d = await r.json();
          if (d.active && d.numFrames > 0) {
            frameCounterEl.textContent = `${d.framesProcessed} / ${d.numFrames} frames`;
          }
        } catch { /* ignore — not critical */ }
      }, 2000);

      // Request the video URL from the server. cache: 'no-store' ensures
      // the browser always reaches the server, which manages its own caching.
      const response = await fetch('/api/solar-video', {
        cache: 'no-store'
      });

      if (!response.ok) {
        let errMsg = `Server error: ${response.status}`;
        try {
          const errData = await response.json();
          if (errData.error) errMsg = errData.error;
        } catch (_) { /* response wasn't JSON */ }
        throw new Error(errMsg);
      }

      const data = await response.json();
      const movieUrl = data.url;

      if (!movieUrl) {
        throw new Error('No video URL returned from server');
      }

      console.log(data.cached ? '[server cache hit]' : '[server generated new]');

      // Helioviewer occasionally returns http:// URLs — upgrade to https
      const secureUrl = movieUrl.startsWith('http://')
        ? movieUrl.replace('http://', 'https://')
        : movieUrl;

      // Save to localStorage for this browser's next visit
      cacheVideo(currentSourceId, secureUrl);

      // Stop the loading message / progress intervals before playing
      if (loadingMsgInterval) clearInterval(loadingMsgInterval);
      if (progressPollInterval) clearInterval(progressPollInterval);
      statusTextEl.textContent = 'Loading video...';
      await loadVideo(secureUrl);

    } catch (err) {
      console.error('Solar movie error:', err);
      if (loadingMsgInterval) clearInterval(loadingMsgInterval);
      if (progressPollInterval) clearInterval(progressPollInterval);
      // Show a user-friendly error rather than a blank screen
      statusOverlay.innerHTML = `
        <div id="error-msg">
          Could not load solar data.<br><br>
          ${err.message}<br><br>
          <span style="color: var(--text-dim); font-size: 10px;">
            The Helioviewer API may be temporarily unavailable.<br>
            Try refreshing in a few minutes.
          </span>
        </div>
      `;
      isLoading = false;
      resolveVideoReady(); // Still unblock bluesky.js so quotes are shown on error
    }
  }

  // ── Reload / reset ─────────────────────────────────────────
  // Clears both the client localStorage cache and the server-side cache,
  // then triggers a fresh load. Useful for debugging or forcing an update.
  // Exposed globally so it can be run from the browser console.
  async function reloadSun() {
    // Clear client-side cache entry for today
    const key = getCacheKey(currentSourceId, endTime);
    localStorage.removeItem(key);
    // Ask server to clear its in-memory and disk cache
    try { await fetch('/api/solar-reset'); } catch { /* ignore */ }
    // Reset state and trigger a fresh load
    isLoading = false;
    loadSolarMovie();
  }

  window.reloadSun = reloadSun;

  console.log('[solar] Run reloadSun() in the console to force-reload the video');

  // ── Start ──────────────────────────────────────────────────
  loadSolarMovie();

})();
