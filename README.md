# Solar Activity Loop Viewer

Displays a smooth looping video of the previous day's solar activity from NASA's Solar Dynamics Observatory (SDO), via the Helioviewer API.

## Setup

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

## How it works

1. A small Express server acts as a proxy for the Helioviewer API (which doesn't support CORS for browser-side requests)
2. The frontend requests a 24-hour timelapse of yesterday's solar activity
3. Helioviewer generates an MP4 server-side (takes 30s to a few minutes)
4. The video plays in a seamless loop with a circular mask

## Wavelengths

Switch between different views of the sun using the buttons:

- **304 Å** — Chromosphere, fiery orange/red
- **171 Å** — Coronal loops, electric blue
- **193 Å** — Corona, teal/green
- **335 Å** — Active regions, deep blue/purple
- **1600 Å** — Transition region, yellow

## Requirements

- Node.js 18+ (uses native `fetch`)
- Internet connection (fetches data from api.helioviewer.org)

## API Reference

- [Helioviewer API v2 Documentation](https://api.helioviewer.org/docs/v2/)
- [SDO Data Sources](https://api.helioviewer.org/docs/v2/appendix/data_sources.html)
