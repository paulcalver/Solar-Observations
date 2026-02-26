// ── Bluesky Feed Integration ──────────────────────────────────────────────────
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

  // ── Shuffle array (Fisher-Yates) ──────────────────────────
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // ── Fetch filtered posts from server ───────────────────────
  async function fetchPosts() {
    console.log('[bluesky] Fetching filtered posts from server...');
    try {
      const response = await fetch('/api/bluesky/filtered');
      if (!response.ok) {
        console.warn(`[bluesky] Server returned ${response.status}, using fallback`);
        useFallbackPosts();
        return;
      }

      const data = await response.json();

      if (data.posts && data.posts.length > 0) {
        posts = shuffleArray(data.posts);
        currentIndex = 0;
        console.log(`[bluesky] ${posts.length} posts ready`);

        // Wait for solar video before showing first post
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
    posts = shuffleArray(CURATED_POSTS);
    currentIndex = 0;
    if (window.solarVideoReady) {
      window.solarVideoReady.then(() => showCurrentPost());
    } else {
      showCurrentPost();
    }
  }

  // ── Scale text to fit ─────────────────────────────────────
  function scaleTextToFit() {
    const maxSize = 36;
    const minSize = 24;

    const maxWidth = window.innerWidth * 0.85;
    const maxHeight = window.innerHeight * 0.5;

    let fontSize = maxSize;
    postText.style.fontSize = fontSize + 'px';

    while (fontSize > minSize) {
      const textWidth = postText.scrollWidth;
      const textHeight = postText.scrollHeight;

      if (textWidth <= maxWidth && textHeight <= maxHeight) break;

      fontSize -= 2;
      postText.style.fontSize = fontSize + 'px';
    }
  }

  // ── Display current post ───────────────────────────────────
  function showCurrentPost() {
    if (posts.length === 0) return;

    const post = posts[currentIndex];

    overlay.style.opacity = '0';

    setTimeout(() => {
      const displayText = post.text.startsWith('"') ? post.text : `"${post.text}"`;
      postText.textContent = displayText;
      postMeta.textContent = `@${post.author} · ${post.time}`;

      scaleTextToFit();

      overlay.style.opacity = '1';
    }, 300);

    resetAutoRotate();
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
    autoRotateTimer = setTimeout(() => nextPost(), AUTO_ROTATE_INTERVAL);
  }

  // ── Click to advance ───────────────────────────────────────
  overlay.addEventListener('click', () => nextPost());

  // ── Initialize ─────────────────────────────────────────────
  fetchPosts();
  setInterval(fetchPosts, FETCH_INTERVAL);

})();
