require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// roomId -> { mode, leader, users: Map<socketId, user>, state, annotations, chat, history }
const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function getRoomPublicState(room) {
  return {
    mode: room.mode,
    leader: room.leader,
    users: Array.from(room.users.values()).map(u => ({
      id: u.id,
      name: u.name,
      color: u.color,
      currentUrl: u.currentUrl,
      permission: u.permission,
    })),
    state: room.state,
    annotations: room.annotations,
    history: room.history.slice(-50),
  };
}

const USER_COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
];

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUser = null;

  // Create a new session
  socket.on('create_session', ({ name, mode }, callback) => {
    const roomId = generateRoomId();
    const colorIndex = 0;

    currentUser = {
      id: socket.id,
      name: name || 'User',
      color: USER_COLORS[colorIndex],
      currentUrl: null,
      permission: 'control',
      cursor: null,
    };

    rooms.set(roomId, {
      mode: mode || 'follow',
      leader: socket.id,
      users: new Map([[socket.id, currentUser]]),
      state: { url: null, scroll: { x: 0, y: 0 }, inputStates: {} },
      annotations: [],
      chat: [],
      history: [],
      splitUsers: new Map(),
    });

    currentRoomId = roomId;
    socket.join(roomId);

    callback({ success: true, roomId, user: currentUser });
    console.log(`Room ${roomId} created by ${name}`);
  });

  // Join an existing session
  socket.on('join_session', ({ roomId, name }, callback) => {
    const room = getRoom(roomId);
    if (!room) {
      callback({ success: false, error: 'Session not found' });
      return;
    }

    const colorIndex = room.users.size % USER_COLORS.length;
    currentUser = {
      id: socket.id,
      name: name || 'User',
      color: USER_COLORS[colorIndex],
      currentUrl: null,
      permission: 'view',
      cursor: null,
    };

    room.users.set(socket.id, currentUser);
    currentRoomId = roomId;
    socket.join(roomId);

    socket.to(roomId).emit('user_joined', { user: currentUser });
    callback({ success: true, roomId, user: currentUser, room: getRoomPublicState(room) });
    console.log(`${name} joined room ${roomId}`);
  });

  // URL navigation event
  socket.on('navigate', ({ url, title, scroll }) => {
    const room = getRoom(currentRoomId);
    if (!room || !currentUser) return;

    currentUser.currentUrl = url;
    room.users.set(socket.id, currentUser);

    const historyEntry = { userId: socket.id, userName: currentUser.name, url, title, timestamp: Date.now() };
    room.history.push(historyEntry);
    if (room.history.length > 200) room.history.shift();

    if (room.mode === 'follow' && room.leader === socket.id) {
      room.state.url = url;
      room.state.scroll = scroll || { x: 0, y: 0 };
      socket.to(currentRoomId).emit('leader_navigated', { url, title, scroll });
    } else if (room.mode === 'group') {
      room.state.url = url;
      socket.to(currentRoomId).emit('group_navigated', { url, title, userId: socket.id });
    } else {
      socket.to(currentRoomId).emit('user_navigated', { userId: socket.id, url, title });
    }
  });

  // Cursor position sync
  socket.on('cursor_move', ({ x, y, scrollX, scrollY }) => {
    if (!currentRoomId || !currentUser) return;
    const room = getRoom(currentRoomId);
    if (!room) return;

    currentUser.cursor = { x, y, scrollX, scrollY };
    socket.to(currentRoomId).emit('cursor_update', {
      userId: socket.id,
      name: currentUser.name,
      color: currentUser.color,
      x, y, scrollX, scrollY,
    });
  });

  // Scroll sync
  socket.on('scroll', ({ x, y }) => {
    const room = getRoom(currentRoomId);
    if (!room || !currentUser) return;

    if (room.mode === 'follow' && room.leader === socket.id) {
      room.state.scroll = { x, y };
      socket.to(currentRoomId).emit('scroll_sync', { x, y });
    }
  });

  // Add annotation (highlight, sticky note, drawing)
  socket.on('add_annotation', (annotation) => {
    const room = getRoom(currentRoomId);
    if (!room || !currentUser) return;

    const entry = {
      ...annotation,
      id: crypto.randomBytes(8).toString('hex'),
      userId: socket.id,
      userName: currentUser.name,
      color: currentUser.color,
      timestamp: Date.now(),
    };
    room.annotations.push(entry);
    io.to(currentRoomId).emit('annotation_added', entry);
  });

  // Remove annotation
  socket.on('remove_annotation', ({ id }) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    room.annotations = room.annotations.filter(a => a.id !== id);
    io.to(currentRoomId).emit('annotation_removed', { id });
  });

  // Chat message
  socket.on('chat_message', ({ text }) => {
    const room = getRoom(currentRoomId);
    if (!room || !currentUser || !text.trim()) return;

    const message = {
      id: crypto.randomBytes(8).toString('hex'),
      userId: socket.id,
      userName: currentUser.name,
      color: currentUser.color,
      text: text.trim().slice(0, 1000),
      timestamp: Date.now(),
    };
    room.chat.push(message);
    if (room.chat.length > 500) room.chat.shift();
    io.to(currentRoomId).emit('chat_message', message);
  });

  // Reaction
  socket.on('reaction', ({ emoji, x, y }) => {
    if (!currentRoomId || !currentUser) return;
    io.to(currentRoomId).emit('reaction', {
      emoji,
      x, y,
      userId: socket.id,
      userName: currentUser.name,
      color: currentUser.color,
    });
  });

  // Change session mode
  socket.on('set_mode', ({ mode }) => {
    const room = getRoom(currentRoomId);
    if (!room || room.leader !== socket.id) return;
    room.mode = mode;
    io.to(currentRoomId).emit('mode_changed', { mode, by: currentUser.name });
  });

  // Transfer leadership
  socket.on('set_leader', ({ userId }) => {
    const room = getRoom(currentRoomId);
    if (!room || room.leader !== socket.id) return;
    if (!room.users.has(userId)) return;
    room.leader = userId;
    const newLeader = room.users.get(userId);
    io.to(currentRoomId).emit('leader_changed', { userId, userName: newLeader.name });
  });

  // Set user permission
  socket.on('set_permission', ({ userId, permission }) => {
    const room = getRoom(currentRoomId);
    if (!room || room.leader !== socket.id) return;
    const user = room.users.get(userId);
    if (!user) return;
    user.permission = permission;
    room.users.set(userId, user);
    io.to(currentRoomId).emit('permission_changed', { userId, permission });
  });

  // Split browsing - user goes independent temporarily
  socket.on('split', () => {
    const room = getRoom(currentRoomId);
    if (!room || !currentUser) return;
    room.splitUsers.set(socket.id, true);
    socket.to(currentRoomId).emit('user_split', { userId: socket.id, userName: currentUser.name });
  });

  // Merge back to group
  socket.on('merge', () => {
    const room = getRoom(currentRoomId);
    if (!room || !currentUser) return;
    room.splitUsers.delete(socket.id);
    socket.to(currentRoomId).emit('user_merged', { userId: socket.id, userName: currentUser.name });
    // Send current group state to re-joining user
    socket.emit('merge_state', { url: room.state.url, scroll: room.state.scroll });
  });

  // Jump to another user's page
  socket.on('jump_to_user', ({ userId }) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    const targetUser = room.users.get(userId);
    if (!targetUser) return;
    socket.emit('jump', { url: targetUser.currentUrl, userName: targetUser.name });
  });

  // Get chat history
  socket.on('get_chat_history', (callback) => {
    const room = getRoom(currentRoomId);
    if (!room) return;
    callback(room.chat.slice(-100));
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (!currentRoomId || !currentUser) return;
    const room = getRoom(currentRoomId);
    if (!room) return;

    room.users.delete(socket.id);
    room.splitUsers.delete(socket.id);

    if (room.users.size === 0) {
      rooms.delete(currentRoomId);
      console.log(`Room ${currentRoomId} closed`);
      return;
    }

    // If leader left, assign new leader
    if (room.leader === socket.id) {
      const newLeaderId = room.users.keys().next().value;
      room.leader = newLeaderId;
      const newLeader = room.users.get(newLeaderId);
      newLeader.permission = 'control';
      io.to(currentRoomId).emit('leader_changed', { userId: newLeaderId, userName: newLeader.name });
    }

    socket.to(currentRoomId).emit('user_left', { userId: socket.id, userName: currentUser.name });
    console.log(`${currentUser.name} left room ${currentRoomId}`);
  });
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

// Session info (no sensitive data)
app.get('/session/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Session not found' });
  res.json({ exists: true, mode: room.mode, userCount: room.users.size });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Shared Browser server running on port ${PORT}`);
});
