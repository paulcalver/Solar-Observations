(function() {
  // ── Configuration ──────────────────────────────────────────
  // All API calls go through our local proxy to avoid CORS
  const API_BASE = '/api/helioviewer';
  const POLL_INTERVAL = 3000;
  const MAX_POLLS = 120;

  // Calculate 24-hour period from now (most recent 24 hours)
  const now = new Date();
  const endTime = new Date(now); // Current time
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

  const formatISO = d => d.toISOString().replace('.000Z', 'Z');

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
    const minDim = Math.min(window.innerWidth, window.innerHeight);
    const size = minDim * 2;
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
    `;
    const statusTextEl = document.getElementById('status-text');
    videoContainer.style.display = 'none';
    infoBar.classList.remove('visible');

    // Check cache first
    const cached = getCachedVideo(currentSourceId);
    if (cached && cached.url) {
      console.log('Using cached video:', cached.url);
      statusTextEl.textContent = 'Loading from cache...';
      try {
        await loadVideo(cached.url);
        return;
      } catch (err) {
        console.warn('Cached video failed, fetching new one:', err);
        // Continue to fetch new video if cached one fails
      }
    }

    // Build query params
    // With cadence=120 (2 min), 24hrs = 720 frames. At 15fps = 48 second video
    const params = new URLSearchParams({
      startTime: formatISO(startTime),
      endTime: formatISO(endTime),
      layers: `[${currentSourceId},1,100]`,
      events: '',
      eventsLabels: false,
      imageScale: 2.42,   // Adjusted for 4K (2160x2160)
      x0: 0,
      y0: 0,
      width: 1080,        // 4K resolution
      height: 1080,       // 4K resolution
      format: 'mp4',
      frameRate: 15,      // 15 fps for smoother, longer playback
      cadence: 120,       // Sample 1 image every 120 seconds (2 min)
      maxFrames: 720,     // 24hrs / 2min = 720 frames
      watermark: false,
      scale: false
      // movieLength removed - duration determined by frames/frameRate (~48 sec)
    });

    try {
      // 1. Queue the movie via our proxy
      statusTextEl.textContent = 'Queuing movie generation...';
      const queueRes = await fetch(`${API_BASE}/queueMovie?${params}`);

      if (!queueRes.ok) {
        const errText = await queueRes.text();
        throw new Error(`Queue request failed (${queueRes.status}): ${errText}`);
      }

      const queueData = await queueRes.json();
      const movieId = queueData.id;

      if (!movieId) {
        throw new Error('No movie ID returned from API');
      }

      statusTextEl.textContent = `Queued — estimated ${Math.round(queueData.eta)}s wait...`;

      // 2. Poll for completion via our proxy
      let polls = 0;
      let movieUrl = null;

      while (polls < MAX_POLLS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        polls++;

        const statusParams = new URLSearchParams({
          id: movieId,
          format: 'mp4',
          verbose: true
        });

        const statusRes = await fetch(`${API_BASE}/getMovieStatus?${statusParams}`);
        const statusData = await statusRes.json();

        if (statusData.status === 2) {
          // Completed — use the direct Helioviewer URL for the video
          // Video files are served with proper headers from their CDN
          movieUrl = statusData.url;
          if (movieUrl && movieUrl.startsWith('http://')) {
            movieUrl = movieUrl.replace('http://', 'https://');
          }
          break;
        } else if (statusData.status === 3) {
          throw new Error('Movie generation failed on the server');
        } else if (statusData.status === 1) {
          statusTextEl.textContent = 'Generating solar timelapse...';
        } else {
          const eta = statusData.eta ? ` (~${Math.round(statusData.eta)}s)` : '';
          statusTextEl.textContent = `In queue${eta}...`;
        }
      }

      if (!movieUrl) {
        throw new Error('Timed out waiting for movie generation');
      }

      // Cache the video URL
      cacheVideo(currentSourceId, movieUrl);

      // 3. Load and play the video
      statusTextEl.textContent = 'Loading video...';
      await loadVideo(movieUrl);

    } catch (err) {
      console.error('Solar movie error:', err);
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
    }
  }

  // ── Start ──────────────────────────────────────────────────
  loadSolarMovie();

})();
