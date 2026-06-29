require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static landing page from ../docs
const DOCS = path.resolve(__dirname, '../../docs');
app.use(express.static(DOCS));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Session state ----
const rooms = new Map();

const COLORS = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#EC4899','#06B6D4','#84CC16'];

function uid() { return crypto.randomBytes(4).toString('hex'); }

function genRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

function send(ws, type, data = {}) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function broadcast(roomId, type, data = {}, exclude = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify({ type, ...data });
  for (const user of room.users.values()) {
    if (user.ws !== exclude && user.ws.readyState === user.ws.OPEN) {
      user.ws.send(msg);
    }
  }
}

function broadcastAll(roomId, type, data = {}) {
  broadcast(roomId, type, data, null);
}

function publicRoom(room) {
  return {
    mode: room.mode,
    leader: room.leader,
    state: room.state,
    users: Array.from(room.users.values()).map(u => ({
      id: u.id, name: u.name, color: u.color,
      currentUrl: u.currentUrl, permission: u.permission,
    })),
    annotations: room.annotations,
    history: room.history.slice(-50),
    chat: room.chat.slice(-100),
  };
}

// ---- WebSocket handler ----

wss.on('connection', (ws, req) => {
  const userId = uid();
  let currentRoomId = null;
  let userName = null;
  let userColor = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, ...data } = msg;

    switch (type) {

      case 'create': {
        const id = genRoomId();
        userName = (data.name || 'User').slice(0, 30);
        userColor = COLORS[0];

        rooms.set(id, {
          mode: data.mode || 'follow',
          leader: userId,
          state: { url: null, scroll: { x: 0, y: 0 } },
          users: new Map([[userId, {
            id: userId, ws, name: userName, color: userColor,
            currentUrl: null, permission: 'control',
          }]]),
          annotations: [],
          chat: [],
          history: [],
          splitUsers: new Set(),
        });

        currentRoomId = id;
        send(ws, 'created', {
          roomId: id,
          user: { id: userId, name: userName, color: userColor, permission: 'control' },
          room: publicRoom(rooms.get(id)),
        });
        console.log(`[${id}] Created by "${userName}"`);
        break;
      }

      case 'join': {
        const id = (data.roomId || '').toUpperCase().trim();
        const room = rooms.get(id);
        if (!room) { send(ws, 'error', { message: 'Session not found. Check your room code.' }); return; }

        userName = (data.name || 'User').slice(0, 30);
        userColor = COLORS[room.users.size % COLORS.length];

        room.users.set(userId, {
          id: userId, ws, name: userName, color: userColor,
          currentUrl: null, permission: 'view',
        });
        currentRoomId = id;

        broadcast(id, 'user_joined', {
          user: { id: userId, name: userName, color: userColor, permission: 'view' },
        }, ws);

        send(ws, 'joined', {
          roomId: id,
          user: { id: userId, name: userName, color: userColor, permission: 'view' },
          room: publicRoom(room),
        });
        console.log(`[${id}] "${userName}" joined (${room.users.size} total)`);
        break;
      }

      case 'navigate': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const user = room.users.get(userId);
        if (!user) return;

        user.currentUrl = data.url;
        room.history.push({ userId, userName, color: userColor, url: data.url, title: data.title, timestamp: Date.now() });
        if (room.history.length > 500) room.history.shift();

        if ((room.mode === 'follow' && room.leader === userId) || room.mode === 'group') {
          room.state = { url: data.url, scroll: data.scroll || { x: 0, y: 0 } };
          broadcast(currentRoomId, 'navigate', { url: data.url, title: data.title, scroll: data.scroll }, ws);
        } else {
          broadcast(currentRoomId, 'user_navigated', { userId, userName, color: userColor, url: data.url, title: data.title }, ws);
        }
        break;
      }

      case 'scroll': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.mode === 'follow' && room.leader === userId) {
          room.state.scroll = { x: data.x, y: data.y };
          broadcast(currentRoomId, 'scroll', { x: data.x, y: data.y }, ws);
        }
        break;
      }

      case 'cursor': {
        if (!currentRoomId) return;
        broadcast(currentRoomId, 'cursor', {
          userId, name: userName, color: userColor,
          x: data.x, y: data.y, scrollX: data.scrollX, scrollY: data.scrollY,
        }, ws);
        break;
      }

      case 'chat': {
        const room = rooms.get(currentRoomId);
        if (!room || !data.text?.trim()) return;
        const message = {
          id: uid(), userId, userName, color: userColor,
          text: data.text.trim().slice(0, 1000), timestamp: Date.now(),
        };
        room.chat.push(message);
        if (room.chat.length > 500) room.chat.shift();
        broadcastAll(currentRoomId, 'chat', message);
        break;
      }

      case 'reaction': {
        if (!currentRoomId) return;
        broadcastAll(currentRoomId, 'reaction', {
          emoji: data.emoji, userId, userName, color: userColor,
          x: data.x, y: data.y,
        });
        break;
      }

      case 'annotation_add': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const annotation = {
          ...data.annotation,
          id: uid(), userId, userName, color: userColor, timestamp: Date.now(),
        };
        room.annotations.push(annotation);
        broadcastAll(currentRoomId, 'annotation_added', { annotation });
        break;
      }

      case 'annotation_remove': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        room.annotations = room.annotations.filter(a => a.id !== data.id);
        broadcastAll(currentRoomId, 'annotation_removed', { id: data.id });
        break;
      }

      case 'set_mode': {
        const room = rooms.get(currentRoomId);
        if (!room || room.leader !== userId) return;
        room.mode = data.mode;
        broadcastAll(currentRoomId, 'mode_changed', { mode: data.mode, by: userName });
        break;
      }

      case 'set_leader': {
        const room = rooms.get(currentRoomId);
        if (!room || room.leader !== userId) return;
        const target = room.users.get(data.userId);
        if (!target) return;
        room.leader = data.userId;
        target.permission = 'control';
        broadcastAll(currentRoomId, 'leader_changed', { userId: data.userId, userName: target.name });
        break;
      }

      case 'set_permission': {
        const room = rooms.get(currentRoomId);
        if (!room || room.leader !== userId) return;
        const target = room.users.get(data.userId);
        if (!target) return;
        target.permission = data.permission;
        broadcastAll(currentRoomId, 'permission_changed', { userId: data.userId, permission: data.permission });
        break;
      }

      case 'split': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        room.splitUsers.add(userId);
        broadcast(currentRoomId, 'user_split', { userId, userName }, ws);
        break;
      }

      case 'merge': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        room.splitUsers.delete(userId);
        broadcast(currentRoomId, 'user_merged', { userId, userName }, ws);
        if (room.state?.url) send(ws, 'navigate', { url: room.state.url, scroll: room.state.scroll });
        break;
      }

      case 'jump_to': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const target = room.users.get(data.userId);
        if (target?.currentUrl) send(ws, 'navigate', { url: target.currentUrl });
        break;
      }

      case 'ping':
        send(ws, 'pong');
        break;
    }
  });

  ws.on('close', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.users.delete(userId);
    room.splitUsers.delete(userId);

    if (room.users.size === 0) {
      rooms.delete(currentRoomId);
      console.log(`[${currentRoomId}] Closed (empty)`);
      return;
    }

    if (room.leader === userId) {
      const newLeaderId = room.users.keys().next().value;
      room.leader = newLeaderId;
      const newLeader = room.users.get(newLeaderId);
      newLeader.permission = 'control';
      broadcastAll(currentRoomId, 'leader_changed', { userId: newLeaderId, userName: newLeader.name });
    }

    broadcast(currentRoomId, 'user_left', { userId, userName });
    console.log(`[${currentRoomId}] "${userName}" left (${room.users.size} remaining)`);
  });

  ws.on('error', () => {});
});

// ---- HTTP API ----

app.get('/health', (_, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: Math.floor(process.uptime()) });
});

app.get('/session/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Session not found' });
  res.json({ exists: true, mode: room.mode, userCount: room.users.size });
});

// All other routes → index.html (handles /ROOMCODE join links)
app.get('*', (_, res) => {
  res.sendFile(path.join(DOCS, 'index.html'));
});

// ---- Start ----

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Shared Browser on port ${PORT}`));
