# Shared Browser - Server

Real-time WebSocket server powering collaborative browsing sessions.

## Stack

- **Node.js** with **Socket.io** v4 for real-time events
- **Express** for HTTP routes
- Stateless sessions stored in memory (restart = sessions cleared)

## Setup

```bash
npm install
cp .env.example .env
npm start          # production
npm run dev        # development with auto-reload
```

Server runs on port `3001` by default. Set `PORT` in `.env` to change.

## API

### HTTP

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server status and room count |
| `GET /session/:roomId` | Check if a session exists (mode, user count) |

### WebSocket Events (Client → Server)

| Event | Payload | Description |
|-------|---------|-------------|
| `create_session` | `{ name, mode }` | Create a new session |
| `join_session` | `{ roomId, name }` | Join existing session |
| `navigate` | `{ url, title, scroll }` | Report page navigation |
| `cursor_move` | `{ x, y, scrollX, scrollY }` | Send cursor position |
| `scroll` | `{ x, y }` | Send scroll position (leader only) |
| `add_annotation` | `{ type, url, ... }` | Add highlight/sticky/drawing |
| `remove_annotation` | `{ id }` | Remove an annotation |
| `chat_message` | `{ text }` | Send chat message |
| `reaction` | `{ emoji, x, y }` | Send reaction |
| `set_mode` | `{ mode }` | Change session mode (leader only) |
| `set_leader` | `{ userId }` | Transfer leadership |
| `set_permission` | `{ userId, permission }` | Change user permission |
| `split` | — | Go independent (Split mode) |
| `merge` | — | Re-join the group |
| `jump_to_user` | `{ userId }` | Navigate to another user's page |
| `get_chat_history` | — | Get last 100 messages |

### WebSocket Events (Server → Client)

| Event | Description |
|-------|-------------|
| `leader_navigated` | Leader changed URL (Follow mode) |
| `group_navigated` | Someone navigated (Group mode) |
| `user_navigated` | A user changed pages (Free mode) |
| `scroll_sync` | Leader scrolled |
| `cursor_update` | Another user's cursor moved |
| `annotation_added` | New annotation on the page |
| `annotation_removed` | Annotation was deleted |
| `chat_message` | New chat message |
| `reaction` | Emoji reaction |
| `user_joined` | New user joined the session |
| `user_left` | User disconnected |
| `mode_changed` | Session mode was changed |
| `leader_changed` | New leader assigned |
| `permission_changed` | User permission updated |
| `user_split` | User went independent |
| `user_merged` | User re-joined the group |
| `merge_state` | Current state sent to merging user |
| `jump` | Navigate to a user's page |

## Session Modes

| Mode | Navigation behavior |
|------|-------------------|
| `follow` | Only leader's navigation syncs to everyone |
| `free` | Navigation is independent; others can see where you are |
| `group` | Any user's navigation moves everyone |
| `presentation` | Same as follow but leader-only annotation |

## Deployment

### Railway / Fly.io / DigitalOcean

```bash
# Set environment variables
PORT=3001

# Run
node src/index.js
```

### With nginx (recommended for WSS)

```nginx
server {
    listen 443 ssl;
    server_name api.b.krl.kr;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Scaling

The current implementation stores sessions in memory. For multiple server instances, replace the `rooms` Map with Redis using `socket.io-redis` adapter.
