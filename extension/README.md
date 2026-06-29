# Shared Browser - Extension

Chrome/Firefox/Edge browser extension for real-time collaborative browsing.

## Quick Install

**Chrome:** Load unpacked from `chrome://extensions` with Developer Mode enabled.  
**Firefox:** Load temporary add-on from `about:debugging` using `manifest-firefox.json`.  
**Edge:** Same as Chrome - load unpacked from `edge://extensions`.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome Manifest V3 |
| `manifest-firefox.json` | Firefox Manifest V2 |
| `background.js` | Service worker - session state, tab event coordination |
| `content.js` | Injected into every page - cursors, sidebar, annotations, socket relay |
| `inject.css` | Styles for injected UI elements |
| `popup.html/js` | Extension popup - create/join sessions |
| `sidebar.html/js` | Side panel - chat, members, annotations, history |
| `icons/` | Extension icons (16, 32, 48, 128px) |

## Architecture

```
popup.js
  └── chrome.runtime.sendMessage → background.js
        └── chrome.tabs.sendMessage → content.js (all active tabs)
              └── WebSocket → server
              └── postMessage → sidebar.js (iframe)
```

The popup creates/joins sessions by updating the session state in `background.js`. The background script broadcasts the state to all content scripts, which then connect to the WebSocket server and inject the sidebar iframe.

## Changing the Server URL

Edit `content.js` line 7:
```js
const SERVER_WS = 'wss://api.b.krl.kr';
```

And `background.js` line 2:
```js
const SERVER_URL = 'wss://api.b.krl.kr';
```

## Permissions Used

| Permission | Why |
|-----------|-----|
| `tabs` | Detect navigation, update tab URLs |
| `activeTab` | Get current page info |
| `storage` | Save session state across restarts |
| `scripting` | Inject content scripts on demand |
| `sidePanel` | Open the side panel on Chrome |
| `<all_urls>` | Inject into any website the user visits |

## Building for Production

To publish to the Chrome Web Store or Firefox Add-ons, you need to:
1. Update the server URL
2. Generate properly-sized icons (the current ones are placeholders)
3. Zip the `extension/` folder
4. Submit to the respective store

For Firefox, rename `manifest-firefox.json` to `manifest.json` before zipping.
