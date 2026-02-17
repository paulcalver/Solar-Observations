// ── Bluesky Feed Integration ──────────────────────────────
// Fetches and displays poetic observations about the sun

(function() {
  const BLUESKY_API = '/api/bluesky/search';
  const AUTO_ROTATE_INTERVAL = 12000; // 12 seconds
  const FETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes

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

  // ── Shuffle array (Fisher-Yates) ──────────────────────────
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // ── Fetch posts from Bluesky ───────────────────────────────
  async function fetchPosts() {
    // Try ALL search phrases to gather as many posts as possible
    const maxAttempts = SEARCH_PHRASES.length;
    let attempts = 0;
    let hasShownFirstPost = false;

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
        const url = `${BLUESKY_API}?q=${encodeURIComponent(phrase)}&limit=50&sort=latest&lang=en`;

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
          })).filter(p => {
            // Filter out: empty, too short, too long, or contains links
            if (p.text.length === 0 || p.text.length > 200) return false;
            // Check for URLs (http://, https://, www., or domain patterns)
            if (p.text.match(/https?:\/\/|www\.|[a-z0-9-]+\.(com|org|net|io|co)/i)) return false;
            // Filter out newspaper references and news-style posts
            if (p.text.match(/sun-times|daily sun|the sun newspaper|telegraph|the sun (reports?|says?|published|wrote|exclusive|revealed|claims?)|in the sun|on the sun|from the sun|breaking|headlines?|article|news:/i)) return false;
            // Filter out birthday references
            if (p.text.match(/birthday/i)) return false;
            // Filter out photography hashtags and VRChat
            if (p.text.match(/#photograph|#photo\b|#vrc|vrchat/i)) return false;
            // Filter out posts containing emoji
            if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(p.text)) return false;
            // Filter out inappropriate or off-topic content
            if (p.text.match(/sex|dungeon|nsfw|18\+|explicit|porn|dick|fuck|shit|damn|hell(?!o)|ass(?!ume)|bitch/i)) return false;
            // Filter out hate speech and discriminatory content
            if (p.text.match(/racist|propaganda|racism|antisemitic|antisemitism|islamophob|xenophob|homophob|transphob|bigot|nazi|kkk|white supremac/i)) return false;
            // Filter out sports teams and sports content
            if (p.text.match(/phoenix suns|gold coast suns|jacksonville suns|the suns (win|lose|beat|play|vs|defeat|scored)|suns (game|win|lose|beat|play|vs|defeat|scored)|#nba|#afl|#nfl|#mlb|#nhl|afl grand final|football|basketball|baseball|soccer/i)) return false;
            // Filter out date references (Sunday, Sun 16th, Sun, 22 Feb, Sun, Feb 22, 2026, etc.)
            if (p.text.match(/\bsunday\b|sun[,\s]+\d{1,2}(st|nd|rd|th)?|sun[,\s]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|on sun\b|this sun\b|next sun\b|last sun\b/i)) return false;
            // Must contain sun-related words to avoid false matches
            const hasSunWord = p.text.match(/\b(sun|sunshine|sunlight|sunset|sunrise|golden hour|solar|sunny)\b/i);
            if (!hasSunWord) return false;

            // Prefer posts with sensory/descriptive/observational words
            const hasSensoryWords = p.text.match(/\b(felt|looked|feel|feels|warm|bright|soft|gentle|beautiful|gorgeous|stunning|hot|cold|blazing|pale|golden|orange|red|pink|violet|yellow|glow|glowing|shining|shimmering|light|shadow|sky|clouds|horizon|morning|evening|afternoon|today|yesterday|watching|seeing|saw)\b/i);
            const hasWeatherWords = p.text.match(/\b(sky|cloud|clouds|horizon|atmosphere|air|wind|mist|haze|weather)\b/i);

            // Boost quality: prefer posts with sensory or weather words (but don't require them)
            // This is a soft filter - we keep posts without these words but they're lower quality
            if (!hasSensoryWords && !hasWeatherWords) {
              // Skip posts that have no descriptive quality
              // But keep very short poetic ones (under 50 chars often poetic)
              if (p.text.length > 50) return false;
            }

            return true;
          });

          // Combine with existing posts, deduplicate, and shuffle
          const allPosts = [...posts, ...newPosts];
          const uniquePosts = Array.from(new Map(allPosts.map(p => [p.text, p])).values());
          const shuffledPosts = shuffleArray(uniquePosts);

          posts = shuffledPosts.slice(0, 400); // Keep max 400 posts in rotation (increased from 100 to allow more variety)

          console.log(`[bluesky] Found ${newPosts.length} for "${phrase}", total: ${posts.length}`);

          // Show first post immediately when we get results
          if (!hasShownFirstPost && posts.length > 0) {
            console.log(`[bluesky] Showing first post, will continue gathering more...`);
            currentIndex = 0;
            showCurrentPost();
            hasShownFirstPost = true;
          }
          // Continue to next phrase to gather more posts
        } else {
          console.log(`[bluesky] No posts found for "${phrase}"`);
        }
      } catch (err) {
        console.error(`[bluesky] Fetch error for "${phrase}":`, err.message);
      }
    }

    // After trying all phrases, log final count or fallback
    if (hasShownFirstPost) {
      console.log(`[bluesky] ✓ Completed search, ${posts.length} unique posts in rotation`);
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


  // ── Scale text to fit ─────────────────────────────────────
  function scaleTextToFit() {
    const maxSize = 48;
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
