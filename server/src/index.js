require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// rooms: Map<roomId, Room>
// Room: { mode, leader, users: Map<socketId, User>, annotations, chat, history, splitUsers: Set }
const rooms = new Map();

const COLORS = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#EC4899','#06B6D4','#84CC16'];

function uid() { return crypto.randomBytes(4).toString('hex'); }
function roomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  arr.forEach(b => { id += chars[b % chars.length]; });
  return id;
}

// Send JSON to a single client
function send(ws, type, data) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

// Broadcast to all in room except optional excluded socket
function broadcast(roomId, type, data, exclude = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify({ type, ...data });
  for (const [, user] of room.users) {
    if (user.ws !== exclude && user.ws.readyState === user.ws.OPEN) {
      user.ws.send(msg);
    }
  }
}

// Broadcast to everyone including sender
function broadcastAll(roomId, type, data) {
  broadcast(roomId, type, data, null);
}

function roomPublicState(room) {
  return {
    mode: room.mode,
    leader: room.leader,
    users: Array.from(room.users.values()).map(u => ({
      id: u.id, name: u.name, color: u.color,
      currentUrl: u.currentUrl, permission: u.permission,
    })),
    annotations: room.annotations,
    history: room.history.slice(-50),
    chat: room.chat.slice(-100),
  };
}

wss.on('connection', (ws) => {
  let currentRoomId = null;
  let userId = uid();
  let userName = null;
  let userColor = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, ...data } = msg;

    switch (type) {
      case 'create': {
        const id = roomId();
        const color = COLORS[0];
        userName = (data.name || 'User').slice(0, 30);
        userColor = color;

        rooms.set(id, {
          mode: data.mode || 'follow',
          leader: userId,
          users: new Map([[userId, {
            id: userId, ws, name: userName, color,
            currentUrl: null, permission: 'control', cursor: null,
          }]]),
          annotations: [],
          chat: [],
          history: [],
          splitUsers: new Set(),
        });

        currentRoomId = id;
        send(ws, 'created', {
          roomId: id,
          user: { id: userId, name: userName, color, permission: 'control' },
          room: roomPublicState(rooms.get(id)),
        });
        console.log(`[${id}] Created by ${userName}`);
        break;
      }

      case 'join': {
        const roomIdUpper = (data.roomId || '').toUpperCase().trim();
        const room = rooms.get(roomIdUpper);
        if (!room) { send(ws, 'error', { message: 'Session not found' }); return; }

        const color = COLORS[room.users.size % COLORS.length];
        userName = (data.name || 'User').slice(0, 30);
        userColor = color;

        const user = { id: userId, ws, name: userName, color, currentUrl: null, permission: 'view', cursor: null };
        room.users.set(userId, user);
        currentRoomId = roomIdUpper;

        // Tell everyone else
        broadcast(roomIdUpper, 'user_joined', {
          user: { id: userId, name: userName, color, permission: 'view' },
        }, ws);

        // Send full state to joiner
        send(ws, 'joined', {
          roomId: roomIdUpper,
          user: { id: userId, name: userName, color, permission: 'view' },
          room: roomPublicState(room),
        });
        console.log(`[${roomIdUpper}] ${userName} joined`);
        break;
      }

      case 'navigate': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const user = room.users.get(userId);
        if (!user) return;
        user.currentUrl = data.url;

        const entry = { userId, userName, url: data.url, title: data.title, timestamp: Date.now() };
        room.history.push(entry);
        if (room.history.length > 500) room.history.shift();

        if (room.mode === 'follow' && room.leader === userId) {
          room.state = { url: data.url, scroll: data.scroll };
          broadcast(currentRoomId, 'navigate', { url: data.url, title: data.title, scroll: data.scroll }, ws);
        } else if (room.mode === 'group') {
          room.state = { url: data.url, scroll: data.scroll };
          broadcast(currentRoomId, 'navigate', { url: data.url, title: data.title, scroll: data.scroll }, ws);
        } else {
          broadcast(currentRoomId, 'user_navigated', { userId, url: data.url, title: data.title }, ws);
        }
        break;
      }

      case 'cursor': {
        if (!currentRoomId || !userName) return;
        broadcast(currentRoomId, 'cursor', {
          userId, name: userName, color: userColor,
          x: data.x, y: data.y, scrollX: data.scrollX, scrollY: data.scrollY,
        }, ws);
        break;
      }

      case 'scroll': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.mode === 'follow' && room.leader === userId) {
          broadcast(currentRoomId, 'scroll', { x: data.x, y: data.y }, ws);
        }
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
          emoji: data.emoji, userId, userName, color: userColor, x: data.x, y: data.y,
        });
        break;
      }

      case 'annotation_add': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const annotation = {
          ...data.annotation, id: uid(), userId, userName, color: userColor, timestamp: Date.now(),
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
        if (room.state?.url) {
          send(ws, 'navigate', { url: room.state.url, scroll: room.state.scroll });
        }
        break;
      }

      case 'jump_to': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const target = room.users.get(data.userId);
        if (target?.currentUrl) {
          send(ws, 'navigate', { url: target.currentUrl });
        }
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

    // Reassign leader if needed
    if (room.leader === userId) {
      const newLeaderId = room.users.keys().next().value;
      room.leader = newLeaderId;
      const newLeader = room.users.get(newLeaderId);
      newLeader.permission = 'control';
      broadcastAll(currentRoomId, 'leader_changed', { userId: newLeaderId, userName: newLeader.name });
    }

    broadcast(currentRoomId, 'user_left', { userId, userName }, null);
    console.log(`[${currentRoomId}] ${userName} left`);
  });

  ws.on('error', () => {});
});

app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

app.get('/session/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Session not found' });
  res.json({ exists: true, mode: room.mode, userCount: room.users.size });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Shared Browser server on port ${PORT}`));
