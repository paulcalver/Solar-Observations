# Solar

A web piece that overlays individuals observations about the sun — sourced live from Bluesky — onto a looping 24-hour timelapse of the solar chromosphere from NASA's Solar Dynamics Observatory.

**Live:** https://solar-quotes.onrender.com/

## How it works

1. An Express server queues a 24-hour solar timelapse via the Helioviewer API (304 Å / extreme ultraviolet, 1080×1080 MP4)
2. While the video renders, cycling status messages keep the viewer informed
3. In parallel, the server proxies authenticated searches against the Bluesky API, gathering real observations people have posted about the sun
4. Once the video is ready, quotes fade in one at a time over the looping sun, auto-rotating every 12 seconds
5. If the Bluesky API is unavailable, a set of curated poetic fallbacks is used instead

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
```

## Architecture

```
server.js          Express server — Helioviewer proxy, Bluesky auth + search proxy, video caching
public/
  index.html       Shell — video container, quote overlay, info bar
  sun.js           Helioviewer video loading, sizing, loading-state feedback
  bluesky.js       Bluesky post fetching, filtering, display rotation
  style.css        Layout, typography, animations
```

### API endpoints

| Route | Purpose |
|-------|---------|
| `GET /api/solar-video` | Queue + poll a 24-hour solar timelapse, 6-hour server cache |
| `GET /api/bluesky/search` | Authenticated proxy to Bluesky `searchPosts` |
| `GET /api/helioviewer/:endpoint` | Generic Helioviewer API proxy |

## Requirements

- Node.js 18+ (uses native `fetch`)
- Bluesky account with an app password
- Internet connection (Helioviewer + Bluesky APIs)

## Credits

- Solar imagery: [NASA SDO](https://sdo.gsfc.nasa.gov/) via [Helioviewer](https://helioviewer.org/)
- Quotes: [Bluesky Social](https://bsky.social/)
