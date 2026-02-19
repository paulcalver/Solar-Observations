(function() {
  // ── Configuration ──────────────────────────────────────────
  // Video generation now handled server-side with caching
  const now = new Date();
  const endTime = new Date(now); // Current time for display

  // ── Video-ready signal (consumed by bluesky.js) ───────────
  let resolveVideoReady;
  window.solarVideoReady = new Promise(r => { resolveVideoReady = r; });

  // ── Loading messages ──────────────────────────────────────
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
  const currentSourceId = 13; // 304 Å wavelength
  let isLoading = false;
  let progressPollInterval = null;

  // ── Cache helpers ──────────────────────────────────────────
  function getCacheKey(sourceId, date) {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return `solar-video-${sourceId}-${dateStr}`;
  }

  function getCachedVideo(sourceId) {
    const key = getCacheKey(sourceId, endTime);
    const cached = localStorage.getItem(key);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        // Check if cache is less than 6 hours old (since we're using "now")
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
  function getVideoSize() {
    // Sun disk fills ~75% of the video frame (810/1080).
    // Scale container so the disk edge aligns with the viewport edge.
    const minDim = window.innerHeight;
    //const minDim = Math.min(window.innerWidth, window.innerHeight);
    const size = minDim * (1080 / 900);
    return Math.round(size);
  }

  function applySize() {
    const size = getVideoSize();
    videoContainer.style.width = size + 'px';
    videoContainer.style.height = size + 'px';
  }

  window.addEventListener('resize', applySize);
  applySize();

  // ── Format date for display ────────────────────────────────
  function formatDisplayDate(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  // ── Load video into player ─────────────────────────────────
  function loadVideo(movieUrl) {
    return new Promise((resolve, reject) => {
      videoEl.src = movieUrl;
      videoEl.load();

      videoEl.addEventListener('canplay', function onCanPlay() {
        videoEl.removeEventListener('canplay', onCanPlay);

        statusOverlay.style.display = 'none';
        videoContainer.style.display = 'block';
        videoContainer.classList.remove('fade-in');
        // Force reflow to restart animation
        void videoContainer.offsetWidth;
        videoContainer.classList.add('fade-in');
        infoBar.classList.add('visible');

        infoDate.textContent = formatDisplayDate(endTime);

        videoEl.play();
        isLoading = false;
        resolveVideoReady();
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
  async function loadSolarMovie() {
    if (isLoading) return;
    isLoading = true;

    // Show loading state
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

    // Check localStorage cache first (client-side)
    const cached = getCachedVideo(currentSourceId);
    if (cached && cached.url) {
      console.log('Using client cache:', cached.url);
      statusTextEl.textContent = 'Loading from cache...';
      try {
        await loadVideo(cached.url);
        return;
      } catch (err) {
        console.warn('Cached video failed, fetching new one:', err);
        // Continue to fetch new video if cached one fails
      }
    }

    try {
      // Call server endpoint (handles caching server-side)
      statusTextEl.textContent = 'Requesting solar video...';

      // Cycle through loading messages while waiting
      let msgIndex = 0;
      loadingMsgInterval = setInterval(() => {
        msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
        statusTextEl.textContent = LOADING_MESSAGES[msgIndex];
      }, 3500);

      // Poll server for frame-level progress
      progressPollInterval = setInterval(async () => {
        try {
          const r = await fetch('/api/solar-progress');
          const d = await r.json();
          if (d.active && d.numFrames > 0) {
            frameCounterEl.textContent = `${d.framesProcessed} / ${d.numFrames} frames`;
          }
        } catch { /* ignore */ }
      }, 2000);

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

      // Ensure HTTPS
      const secureUrl = movieUrl.startsWith('http://')
        ? movieUrl.replace('http://', 'https://')
        : movieUrl;

      // Cache in localStorage for this client
      cacheVideo(currentSourceId, secureUrl);

      // Load and play the video
      if (loadingMsgInterval) clearInterval(loadingMsgInterval);
      if (progressPollInterval) clearInterval(progressPollInterval);
      statusTextEl.textContent = 'Loading video...';
      await loadVideo(secureUrl);

    } catch (err) {
      console.error('Solar movie error:', err);
      if (loadingMsgInterval) clearInterval(loadingMsgInterval);
      if (progressPollInterval) clearInterval(progressPollInterval);
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
      resolveVideoReady(); // Still show quotes on error
    }
  }

  // ── Reload / reset ─────────────────────────────────────────
  async function reloadSun() {
    // Clear client-side cache for today
    const key = getCacheKey(currentSourceId, endTime);
    localStorage.removeItem(key);
    // Clear server-side cache (memory + disk)
    try { await fetch('/api/solar-reset'); } catch { /* ignore */ }
    // Reset state and reload
    isLoading = false;
    loadSolarMovie();
  }

  window.reloadSun = reloadSun;

  console.log('[solar] Run reloadSun() in the console to force-reload the video');

  // ── Start ──────────────────────────────────────────────────
  loadSolarMovie();

})();
