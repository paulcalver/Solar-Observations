// Project: Solar Observations
// Author:  Paul Calver <pcalv001@gold.ac.uk>
//
// ── bluesky.js ────────────────────────────────────────────────────────────────
// Client-side controller for the Bluesky post overlay.
//
// Flow:
//   1. On load, fetch filtered posts from /api/bluesky/filtered (server handles
//      all the heavy lifting: Bluesky search → regex pre-screen → Gemini filter)
//   2. Shuffle the returned posts and display them one at a time, fading between
//      them every 12 seconds. A click on the overlay advances to the next post.
//   3. Re-fetch fresh posts every 5 minutes so long-running sessions stay current.
//   4. If the server returns no posts or errors, fall back to the CURATED_POSTS
//      list below so the overlay is never empty.
//
// The overlay waits for window.solarVideoReady (set by sun.js) before showing
// the first post, so text never appears over a blank loading screen.
// ─────────────────────────────────────────────────────────────────────────────

(function() {
  const AUTO_ROTATE_INTERVAL = 12000; // 12 seconds between post transitions
  const FETCH_INTERVAL = 5 * 60 * 1000; // Re-fetch from server every 5 minutes

  // ── Curated fallback observations ─────────────────────────
  // Hand-written posts in the style of real Bluesky observations.
  // Displayed when the API is unavailable or returns no results.
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
  let posts = [];           // Currently loaded post list (shuffled)
  let currentIndex = 0;    // Index of the post currently on screen
  let autoRotateTimer = null; // Handle for the auto-advance setTimeout

  // ── DOM refs ───────────────────────────────────────────────
  const overlay = document.getElementById('bluesky-overlay');
  const postText = document.getElementById('post-text');
  const postMeta = document.getElementById('post-meta');

  // ── Shuffle array (Fisher-Yates) ──────────────────────────
  // Randomises the order of posts so visitors don't always see the
  // same sequence, and different phrases' results are interleaved.
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // ── Fetch filtered posts from server ───────────────────────
  // Calls /api/bluesky/filtered which returns already-filtered posts
  // (Bluesky search → regex pre-screen → Gemini filter, cached 10 min).
  // Falls back to curated posts if the server errors or returns nothing.
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

        // Wait for the solar video to be visible before showing the first post
        // so text never overlays a loading spinner
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
  // Loads the hand-written CURATED_POSTS list and begins showing them.
  // Called whenever the live API is unavailable or returns no results.
  function useFallbackPosts() {
    console.log('[bluesky] Using curated fallback posts');
    posts = shuffleArray(CURATED_POSTS);
    currentIndex = 0;
    // Still wait for the solar video to be ready before displaying
    if (window.solarVideoReady) {
      window.solarVideoReady.then(() => showCurrentPost());
    } else {
      showCurrentPost();
    }
  }

  // ── Scale text to fit ─────────────────────────────────────
  // Shrinks the font size in 2px steps until the text fits within
  // 85% of the viewport width and 50% of its height, stopping at 24px.
  // This handles both short punchy posts and longer multi-line ones.
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
  // Fades the overlay out, swaps in new content, scales the text,
  // then fades back in. Also resets the auto-rotate timer so the
  // next advance is always a full interval from now.
  function showCurrentPost() {
    if (posts.length === 0) return;

    const post = posts[currentIndex];

    overlay.style.opacity = '0'; // Begin fade-out via CSS transition

    setTimeout(() => {
      // Wrap text in quotes if not already quoted
      const displayText = post.text.startsWith('"') ? post.text : `"${post.text}"`;
      postText.textContent = displayText;
      postMeta.textContent = `@${post.author} · ${post.time}`;

      scaleTextToFit();

      overlay.style.opacity = '1'; // Begin fade-in
    }, 300); // Wait 300ms for fade-out to complete before swapping content

    resetAutoRotate();
  }

  // ── Next post ──────────────────────────────────────────────
  // Advances the index cyclically through the posts array.
  function nextPost() {
    if (posts.length === 0) return;
    currentIndex = (currentIndex + 1) % posts.length;
    showCurrentPost();
  }

  // ── Auto-rotate timer ──────────────────────────────────────
  // Clears any existing timer and starts a fresh countdown to nextPost().
  // Called after every show so clicking to advance resets the clock.
  function resetAutoRotate() {
    if (autoRotateTimer) clearTimeout(autoRotateTimer);
    autoRotateTimer = setTimeout(() => nextPost(), AUTO_ROTATE_INTERVAL);
  }

  // ── Click to advance ───────────────────────────────────────
  // Tapping the overlay skips to the next post immediately.
  overlay.addEventListener('click', () => nextPost());

  // ── Initialize ─────────────────────────────────────────────
  fetchPosts(); // Load posts immediately on page load
  setInterval(fetchPosts, FETCH_INTERVAL); // Refresh every 5 minutes

})();
