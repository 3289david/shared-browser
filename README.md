# Shared Browser

Browse the web together in real-time.

Not screen sharing. Not a video call overlay. The actual browsing experience, synchronized between participants.

**Website:** https://b.krl.kr

## What it does

- Live cursors - see everyone's cursor position on the page, labeled with names
- Synchronized navigation - follow a leader or browse as a group
- Annotations - highlights, sticky notes, and drawings visible to all
- Real-time chat - sidebar chat without leaving the browser
- Shared history - full timeline of every page visited in the session
- Split & Merge - break off independently, merge back with one click
- Session recording - events, not video. Tiny file size, full replay

## Session Modes

| Mode | Description |
|------|-------------|
| Follow | All participants follow the leader's navigation |
| Free | Everyone browses independently, can jump to others |
| Group | Any navigation moves everyone |
| Presentation | Audience follows presenter, cannot change the view |

## Project Structure

```
shared-browser/
├── extension/          Chrome/Firefox extension (WebExtension API)
│   ├── manifest.json   Chrome Manifest V3
│   ├── manifest-firefox.json  Firefox Manifest V2
│   ├── background.js   Service worker
│   ├── content.js      Page injection (cursors, annotations, sidebar)
│   ├── popup.html/js   Extension popup
│   ├── sidebar.html/js Sidebar panel
│   └── icons/          Extension icons
├── server/             Node.js real-time server
│   └── src/index.js    Socket.io server
└── docs/               Landing page (GitHub Pages)
    ├── index.html
    ├── css/style.css
    └── js/main.js
```

## Setup

### Server

```bash
cd server
npm install
cp .env.example .env
npm start
```

Runs on port 3001 by default. Deploy this to your server and update the `SERVER_WS` URL in `extension/content.js` and `extension/background.js`.

### Extension (Chrome)

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder

### Extension (Firefox)

1. Open Firefox and go to `about:debugging`
2. Click "This Firefox" > "Load Temporary Add-on"
3. Select `extension/manifest-firefox.json`

## Configuration

The WebSocket server URL is set in `extension/content.js`:

```js
const SERVER_WS = 'wss://api.b.krl.kr';
```

Change this to your deployed server URL before building for production.

## Deployment

### Server

Any Node.js host works: Railway, Fly.io, DigitalOcean, etc.

```bash
cd server
npm install --production
PORT=3001 node src/index.js
```

### Landing Page

The `docs/` folder is configured for GitHub Pages. Enable GitHub Pages in repository settings, set source to `docs/` folder.

## License

MIT
