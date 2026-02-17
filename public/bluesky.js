// ── Bluesky Feed Integration ──────────────────────────────
// Fetches and displays poetic observations about the sun

(function() {
  const BLUESKY_API = '/api/bluesky/search';
  const AUTO_ROTATE_INTERVAL = 10000; // 10 seconds
  const FETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes

  const SEARCH_PHRASES = [
    'sun',
    'sunshine',
    'golden hour',
    'sunset',
    'sunrise',
    'sunlight'
  ];

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
  let currentPhraseIndex = 0;
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

  // ── Fetch posts from Bluesky ───────────────────────────────
  async function fetchPosts() {
    // Try ALL search phrases to gather as many posts as possible
    const maxAttempts = SEARCH_PHRASES.length;
    let attempts = 0;
    let foundAny = false;

    while (attempts < maxAttempts) {
      const phrase = SEARCH_PHRASES[currentPhraseIndex];
      currentPhraseIndex = (currentPhraseIndex + 1) % SEARCH_PHRASES.length;
      attempts++;

      // Add delay between requests to avoid rate limiting (except first request)
      if (attempts > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }

      try {
        // Call through authenticated proxy
        const url = `${BLUESKY_API}?q=${encodeURIComponent(phrase)}&limit=25&sort=latest&lang=en`;

        console.log(`[bluesky] Fetching: "${phrase}" (attempt ${attempts}/${maxAttempts})`);

        const response = await fetch(url);

        if (!response.ok) {
          console.warn(`[bluesky] API returned ${response.status} for "${phrase}"`);
          // Try next phrase
          continue;
        }

        const data = await response.json();

        if (data.posts && data.posts.length > 0) {
          // Extract and format posts
          const newPosts = data.posts.map(post => ({
            text: post.record?.text || '',
            author: post.author?.handle?.replace('.bsky.social', '') || 'unknown',
            time: formatRelativeTime(post.record?.createdAt || new Date().toISOString())
          })).filter(p => p.text.length > 0 && p.text.length < 200); // Filter too short/long

          // Combine with existing posts, deduplicate
          const allPosts = [...posts, ...newPosts];
          const uniquePosts = Array.from(new Map(allPosts.map(p => [p.text, p])).values());

          posts = uniquePosts.slice(0, 50); // Keep max 50 posts in rotation (increased from 30)

          console.log(`[bluesky] Found ${newPosts.length} for "${phrase}", total: ${posts.length}`);
          foundAny = true;
          // Continue to next phrase to gather more posts
        } else {
          console.log(`[bluesky] No posts found for "${phrase}"`);
        }
      } catch (err) {
        console.error(`[bluesky] Fetch error for "${phrase}":`, err.message);
      }
    }

    // After trying all phrases, display results or fallback
    if (foundAny && posts.length > 0) {
      console.log(`[bluesky] ✓ Completed search, ${posts.length} unique posts in rotation`);
      currentIndex = 0;
      showCurrentPost();
    } else {
      console.log(`[bluesky] No posts found after trying all ${maxAttempts} phrases, using fallback`);
      useFallbackPosts();
    }
  }

  // ── Use curated posts as fallback ──────────────────────────
  function useFallbackPosts() {
    console.log('[bluesky] Using curated fallback posts');
    posts = [...CURATED_POSTS].sort(() => Math.random() - 0.5);
    currentIndex = 0;
    showCurrentPost();
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
