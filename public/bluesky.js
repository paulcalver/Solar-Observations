// ── Bluesky Feed Integration ──────────────────────────────
// Fetches and displays poetic observations about the sun

(function() {
  const AUTO_ROTATE_INTERVAL = 12000; // 12 seconds
  const FETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // ── Curated fallback observations ─────────────────────────
  const CURATED_POSTS = [
    { text: "the sun felt like a warm hug on my face this morning", author: "observer", time: "2h ago" },
    { text: "golden hour hit different today, everything looked like honey", author: "skygazer", time: "4h ago" },
    { text: "the light today was so soft and pale, like looking through wax paper", author: "wanderer", time: "6h ago" },
    { text: "sunshine today was aggressive, sharp shadows everywhere", author: "photographer", time: "8h ago" },
    { text: "the sun looked orange and fat sitting on the horizon", author: "witness", time: "1d ago" },
    { text: "warm sun on my shoulders felt like being held", author: "nomad", time: "1d ago" },
    { text: "the sun was so bright this morning it hurt to look at anything white", author: "cyclist", time: "2d ago" },
    { text: "pink light coming through the clouds made everything look unreal", author: "dreamer", time: "2d ago" },
    { text: "the sun felt gentle today, like it was trying not to wake anyone up", author: "earlybird", time: "3d ago" },
    { text: "blazing sun at noon, everything felt bleached and quiet", author: "desert", time: "3d ago" },
    { text: "the sun looked violet through the smoke", author: "witness", time: "4d ago" },
    { text: "late afternoon sun made the dust visible in the air", author: "seeker", time: "4d ago" },
    { text: "the light today was cathedral light, all beams and columns", author: "poet", time: "5d ago" },
    { text: "sun hit the water and it looked like someone spilled mercury", author: "sailor", time: "5d ago" },
    { text: "the sun felt like it was reading my thoughts today, following me", author: "walker", time: "6d ago" }
  ];

  // ── State ──────────────────────────────────────────────────
  let posts = [];
  let currentIndex = 0;
  let autoRotateTimer = null;

  // ── DOM refs ───────────────────────────────────────────────
  const overlay = document.getElementById('bluesky-overlay');
  const postText = document.getElementById('post-text');
  const postMeta = document.getElementById('post-meta');

  // ── Format relative time ───────────────────────────────────
  function formatRelativeTime(isoString) {
    const now = new Date();
    const then = new Date(isoString);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  }

  // ── Shuffle array (Fisher-Yates) ──────────────────────────
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // ── Loading state ──────────────────────────────────────────
  function showLoading() {
    overlay.style.opacity = '0';
    setTimeout(() => {
      postText.style.fontSize = '24px';
      postText.textContent = 'Fetching observations…';
      postMeta.textContent = '';
      overlay.style.opacity = '1';
    }, 300);
  }

  // ── Fetch posts from Bluesky ───────────────────────────────
  async function fetchPosts() {
    // First load: show loading text only after solar video UI clears, to avoid overlap.
    // Background refreshes (posts already showing): update silently.
    if (posts.length === 0 && window.solarVideoReady) {
      window.solarVideoReady.then(() => {
        if (posts.length === 0) showLoading();
      });
    }
    try {
      console.log('[bluesky] Fetching filtered posts...');
      const response = await fetch('/api/bluesky/filtered');

      if (!response.ok) {
        console.warn(`[bluesky] API returned ${response.status}`);
        useFallbackPosts();
        return;
      }

      const data = await response.json();

      if (data.posts && data.posts.length > 0) {
        const newPosts = data.posts.map(post => ({
          text: post.record?.text || '',
          author: post.author?.handle?.replace('.bsky.social', '') || 'unknown',
          time: formatRelativeTime(post.record?.createdAt || new Date().toISOString())
        }));

        posts = shuffleArray(newPosts).slice(0, 400);
        currentIndex = 0;
        console.log(`[bluesky] ✓ ${posts.length} filtered posts loaded`);

        if (window.solarVideoReady) {
          window.solarVideoReady.then(() => showCurrentPost());
        } else {
          showCurrentPost();
        }
      } else {
        console.log('[bluesky] No posts returned, using fallback');
        useFallbackPosts();
      }
    } catch (err) {
      console.error('[bluesky] Fetch error:', err.message);
      useFallbackPosts();
    }
  }

  // ── Use curated posts as fallback ──────────────────────────
  function useFallbackPosts() {
    console.log('[bluesky] Using curated fallback posts');
    posts = [...CURATED_POSTS].sort(() => Math.random() - 0.5);
    currentIndex = 0;
    // Wait for the solar video to be ready before showing quotes
    if (window.solarVideoReady) {
      window.solarVideoReady.then(() => {
        console.log(`[bluesky] Video ready, showing fallback post`);
        showCurrentPost();
      });
    } else {
      showCurrentPost();
    }
  }


  // ── Scale text to fit ─────────────────────────────────────
  function scaleTextToFit() {
    const maxSize = 36;
    const minSize = 24;

    // Use viewport dimensions for more reliable sizing
    const maxWidth = window.innerWidth * 0.85; // 85% of viewport width
    const maxHeight = window.innerHeight * 0.5; // 50% of viewport height

    let fontSize = maxSize;
    postText.style.fontSize = fontSize + 'px';

    // Check if text overflows by comparing scroll vs client dimensions
    while (fontSize > minSize) {
      const textWidth = postText.scrollWidth;
      const textHeight = postText.scrollHeight;

      if (textWidth <= maxWidth && textHeight <= maxHeight) {
        break; // Fits, stop scaling down
      }

      fontSize -= 2;
      postText.style.fontSize = fontSize + 'px';
    }
  }

  // ── Display current post ───────────────────────────────────
  function showCurrentPost() {
    if (posts.length === 0) {
      showError('No posts available');
      return;
    }

    const post = posts[currentIndex];

    // Fade out
    overlay.style.opacity = '0';

    setTimeout(() => {
      // Don't add quotes if text already has them
      const displayText = post.text.startsWith('"') ? post.text : `"${post.text}"`;
      postText.textContent = displayText;
      postMeta.textContent = `@${post.author} · ${post.time}`;

      // Scale text to fit container
      scaleTextToFit();

      // Fade in
      overlay.style.opacity = '1';
    }, 300);

    resetAutoRotate();
  }

  // ── Show error message ─────────────────────────────────────
  function showError(message) {
    overlay.style.opacity = '0';
    setTimeout(() => {
      postText.textContent = message;
      postMeta.textContent = '';
      overlay.style.opacity = '1';
    }, 300);
  }

  // ── Next post ──────────────────────────────────────────────
  function nextPost() {
    if (posts.length === 0) return;
    currentIndex = (currentIndex + 1) % posts.length;
    showCurrentPost();
  }

  // ── Auto-rotate timer ──────────────────────────────────────
  function resetAutoRotate() {
    if (autoRotateTimer) clearTimeout(autoRotateTimer);
    autoRotateTimer = setTimeout(() => {
      nextPost();
    }, AUTO_ROTATE_INTERVAL);
  }

  // ── Click to advance ───────────────────────────────────────
  overlay.addEventListener('click', () => {
    nextPost();
  });

  // ── Initialize ─────────────────────────────────────────────
  fetchPosts();
  setInterval(fetchPosts, FETCH_INTERVAL);

})();
