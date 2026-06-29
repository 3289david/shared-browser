# Shared Browser - Server

WebSocket + REST API server. Deployed on a VPS at `api.b.krl.kr`.  
The landing page (`docs/`) is separate and lives on GitHub Pages at `b.krl.kr`.

## What this server does

- Accepts WebSocket connections from the browser extension at `/ws`
- Manages session rooms, user presence, and real-time message relay
- Exposes `/health` and `/session/:id` REST endpoints
- Does NOT serve any HTML or static files

## Deploy on VPS

### Option A — Docker (recommended)

```bash
# Clone the repo on your VPS
git clone https://github.com/3289david/shared-browser.git /opt/shared-browser
cd /opt/shared-browser/server

# Start
docker compose up -d

# Logs
docker compose logs -f
```

### Option B — systemd (bare Node.js)

```bash
# On your VPS
git clone https://github.com/3289david/shared-browser.git /opt/shared-browser
cd /opt/shared-browser/server
npm install --production

# Install the service
cp shared-browser.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable shared-browser
systemctl start shared-browser

# Check it's running
systemctl status shared-browser
curl http://localhost:3001/health
```

### Nginx + SSL

```bash
# Install nginx + certbot
apt install nginx certbot python3-certbot-nginx

# Copy the nginx config
cp /opt/shared-browser/server/nginx.conf /etc/nginx/sites-available/shared-browser
ln -s /etc/nginx/sites-available/shared-browser /etc/nginx/sites-enabled/

# Get SSL cert
certbot --nginx -d api.b.krl.kr

# Reload nginx
nginx -t && systemctl reload nginx
```

### DNS

Point `api.b.krl.kr` at your VPS IP address (A record).

```
api.b.krl.kr.   A   YOUR_VPS_IP
```

## Environment variables

```bash
PORT=3001   # default
```

## Local development

```bash
npm install
npm run dev   # uses nodemon for auto-reload
```

Test it:
```bash
curl http://localhost:3001/health
# {"status":"ok","rooms":0,"uptime":5}
```

## WebSocket protocol

All messages are JSON: `{ "type": "...", ...data }`.

### Client → Server

| type | payload | description |
|------|---------|-------------|
| `create` | `{ name, mode }` | Create a new session |
| `join` | `{ roomId, name }` | Join an existing session |
| `navigate` | `{ url, title, scroll }` | Report navigation |
| `cursor` | `{ x, y, scrollX, scrollY }` | Cursor position |
| `scroll` | `{ x, y }` | Scroll position (leader only) |
| `chat` | `{ text }` | Send a chat message |
| `reaction` | `{ emoji, x, y }` | Send a reaction |
| `annotation_add` | `{ annotation }` | Add annotation |
| `annotation_remove` | `{ id }` | Remove annotation |
| `set_mode` | `{ mode }` | Change session mode |
| `set_leader` | `{ userId }` | Transfer leader role |
| `split` | — | Go independent |
| `merge` | — | Rejoin the group |
| `jump_to` | `{ userId }` | Navigate to user's page |
| `ping` | — | Keepalive |

### Server → Client

| type | description |
|------|-------------|
| `created` | Session created, includes roomId and full room state |
| `joined` | Successfully joined, includes full room state |
| `navigate` | Leader/group navigated, follow this URL |
| `scroll` | Scroll position update |
| `cursor` | Another user's cursor position |
| `chat` | New chat message |
| `reaction` | Emoji reaction |
| `annotation_added` | New annotation |
| `annotation_removed` | Annotation deleted |
| `user_joined` | New user entered the session |
| `user_left` | User disconnected |
| `mode_changed` | Session mode changed |
| `leader_changed` | New leader assigned |
| `permission_changed` | User permission updated |
| `user_split` | User went independent |
| `user_merged` | User rejoined group |
| `error` | Something went wrong |
| `pong` | Keepalive response |
