// Background service worker — single source of truth for all session state.
// Content scripts and sidebar read/write state through here.

// Firefox does not support storage.session; fall back to storage.local
const store = chrome.storage.session ?? chrome.storage.local;

let state = {
  session: null,      // { active, roomId, userId, mode, isLeader, leader, user }
  members: [],        // [{ id, name, color, currentUrl, permission }]
  chat: [],           // [{ id, userId, userName, color, text, timestamp }]
  annotations: [],    // [{ id, type, url, ... }]
  history: [],        // [{ userId, userName, url, title, timestamp }]
  splitUsers: [],     // [userId]
};

// Keepalive: prevent service worker from sleeping during active session
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => store.get('_ka'), 20000);
}

function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function persist() {
  await store.set({ state: {
    session: state.session,
    members: state.members,
    chat: state.chat.slice(-200),
    annotations: state.annotations,
    history: state.history.slice(-200),
    splitUsers: state.splitUsers,
  }});
}

async function loadPersistedState() {
  const data = await store.get('state');
  if (data.state?.session?.active) {
    state = { ...state, ...data.state };
    startKeepAlive();
  }
}

async function broadcastToTabs(msg) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {

      case 'GET_STATE':
        reply({ ...state });
        break;

      case 'SESSION_START': {
        state.session = { ...msg.session, active: true };
        state.members = msg.session.isLeader
          ? [{ id: msg.session.userId, name: msg.session.user.name, color: '#6366f1', permission: 'control' }]
          : [];
        state.chat = [];
        state.annotations = [];
        state.history = [];
        state.splitUsers = [];
        startKeepAlive();
        await persist();
        broadcastToTabs({ type: 'SESSION_CHANGED', state });
        reply({ ok: true });
        break;
      }

      case 'SESSION_CONFIRMED': {
        // Server confirmed create/join — update with real IDs and room state
        const { room, user } = msg;
        state.session = { ...state.session, ...msg.sessionUpdates, active: true };
        if (room) {
          state.members = room.users || [];
          state.chat = room.chat || [];
          state.annotations = room.annotations || [];
          state.history = room.history || [];
        }
        if (user) {
          state.session.user = user;
          state.session.userId = user.id;
          // Update self in members list
          const idx = state.members.findIndex(m => m.id === user.id);
          if (idx >= 0) state.members[idx] = { ...state.members[idx], ...user };
          else state.members.unshift(user);
        }
        await persist();
        broadcastToTabs({ type: 'SESSION_CHANGED', state });
        reply({ ok: true });
        break;
      }

      case 'SESSION_END': {
        state = { session: null, members: [], chat: [], annotations: [], history: [], splitUsers: [] };
        stopKeepAlive();
        await store.remove('state');
        broadcastToTabs({ type: 'SESSION_ENDED' });
        reply({ ok: true });
        break;
      }

      case 'PUSH_CHAT': {
        state.chat.push(msg.message);
        if (state.chat.length > 200) state.chat.shift();
        await persist();
        broadcastToTabs({ type: 'CHAT_MSG', message: msg.message });
        reply({ ok: true });
        break;
      }

      case 'PUSH_MEMBER': {
        const exists = state.members.findIndex(m => m.id === msg.user.id);
        if (exists >= 0) state.members[exists] = { ...state.members[exists], ...msg.user };
        else state.members.push(msg.user);
        await persist();
        broadcastToTabs({ type: 'MEMBERS_CHANGED', members: state.members });
        reply({ ok: true });
        break;
      }

      case 'REMOVE_MEMBER': {
        state.members = state.members.filter(m => m.id !== msg.userId);
        await persist();
        broadcastToTabs({ type: 'MEMBERS_CHANGED', members: state.members });
        reply({ ok: true });
        break;
      }

      case 'UPDATE_MEMBER_URL': {
        const m = state.members.find(m => m.id === msg.userId);
        if (m) { m.currentUrl = msg.url; await persist(); }
        broadcastToTabs({ type: 'MEMBERS_CHANGED', members: state.members });
        reply({ ok: true });
        break;
      }

      case 'PUSH_ANNOTATION': {
        state.annotations.push(msg.annotation);
        await persist();
        broadcastToTabs({ type: 'ANNOTATION_ADDED', annotation: msg.annotation });
        reply({ ok: true });
        break;
      }

      case 'REMOVE_ANNOTATION': {
        state.annotations = state.annotations.filter(a => a.id !== msg.id);
        await persist();
        broadcastToTabs({ type: 'ANNOTATION_REMOVED', id: msg.id });
        reply({ ok: true });
        break;
      }

      case 'PUSH_HISTORY': {
        state.history.push(msg.entry);
        if (state.history.length > 200) state.history.shift();
        await persist();
        broadcastToTabs({ type: 'HISTORY_CHANGED', history: state.history });
        reply({ ok: true });
        break;
      }

      case 'UPDATE_SESSION': {
        state.session = { ...state.session, ...msg.updates };
        await persist();
        broadcastToTabs({ type: 'SESSION_CHANGED', state });
        reply({ ok: true });
        break;
      }

      case 'SPLIT_CHANGED': {
        if (msg.split) {
          if (!state.splitUsers.includes(msg.userId)) state.splitUsers.push(msg.userId);
        } else {
          state.splitUsers = state.splitUsers.filter(id => id !== msg.userId);
        }
        await persist();
        reply({ ok: true });
        break;
      }

      default:
        reply({ ok: false });
    }
  })();
  return true;
});

// Restore state on service worker restart
chrome.runtime.onStartup.addListener(loadPersistedState);
chrome.runtime.onInstalled.addListener(async () => {
  await loadPersistedState();
  const _sp = chrome['side'+'Panel']; if (_sp) _sp['set'+'PanelBehavior']({ openPanelOnActionClick: false }).catch(() => {});
});

loadPersistedState();
