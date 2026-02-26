# Solar Observations \*\_\*

A web piece that overlays individuals observations about the sun — sourced live from Bluesky — onto a looping 24-hour timelapse of the solar chromosphere from NASA's Solar Dynamics Observatory.

**Live:** https://solar-quotes.onrender.com/

![Solar_Observations_01](https://github.com/user-attachments/assets/a7e96609-6dbe-485d-9ac0-1dcfefa05f2a)


## How it works

1. An Express server queues a 24-hour solar timelapse via the Helioviewer API (304 Å / extreme ultraviolet, 1080×1080 MP4)
2. While the video renders, cycling status messages keep the viewer informed
3. In parallel, the server fetches 19 search phrases from Bluesky in parallel, collecting real observations people have posted about the sun
4. Posts are filtered in two stages: a fast regex pre-screen removes noise (news, sports, URLs, emoji, date references), then Google Gemini semantically filters for genuine sensory observations of the sun
5. Filtered results are cached server-side for 10 minutes to avoid repeated API calls
6. Once the video is ready, quotes fade in one at a time over the looping sun, auto-rotating every 12 seconds
7. If the Bluesky or Gemini APIs are unavailable, graceful fallbacks ensure quotes are always shown

## Setup

```bash
npm install
npm start
```

Open **http://localhost:3000**.

### Environment variables

Create a `.env` file:

```
BLUESKY_IDENTIFIER=your-handle.bsky.social
BLUESKY_APP_PASSWORD=your-app-password
GEMINI_API_KEY=your-gemini-api-key
REFRESH_TOKEN=optional-secret-for-manual-refresh
```

`GEMINI_API_KEY` is required for semantic filtering. Get a key from [Google AI Studio](https://aistudio.google.com) — a Google Cloud project with billing enabled is required (usage stays within the free tier).

## Architecture

```
server.js          Express server — Helioviewer proxy, Bluesky fetch + Gemini filter, video caching
public/
  index.html       Shell — video container, quote overlay, info bar
  sun.js           Helioviewer video loading, sizing, loading-state feedback
  bluesky.js       Bluesky post display and rotation (fetches from /api/bluesky/filtered)
  style.css        Layout, typography, animations
```

### API endpoints

| Route | Purpose |
|-------|---------|
| `GET /api/solar-video` | Queue + poll a 24-hour solar timelapse, 25-hour server cache |
| `GET /api/solar-progress` | Live frame-render progress during video generation |
| `GET /api/solar-reset` | Clear server video cache (forces fresh generation on next request) |
| `GET /api/bluesky/filtered` | Fetch, pre-screen, and Gemini-filter Bluesky posts — 10-minute server cache |
| `GET /api/bluesky/search` | Raw authenticated proxy to Bluesky `searchPosts` |
| `GET /api/helioviewer/:endpoint` | Generic Helioviewer API proxy |
| `GET /api/refresh?token=` | Manually trigger solar video regeneration (requires `REFRESH_TOKEN`) |

## Requirements

- Node.js 18+ (uses native `fetch`)
- Bluesky account with an app password
- Google AI Studio API key with billing enabled (for Gemini filtering)
- Internet connection (Helioviewer, Bluesky, and Gemini APIs)

## Credits

- Solar imagery: [NASA SDO](https://sdo.gsfc.nasa.gov/) via [Helioviewer](https://helioviewer.org/)
- Quotes: [Bluesky Social](https://bsky.social/)
