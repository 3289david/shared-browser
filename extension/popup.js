const SERVER_HTTP = 'https://api.b.krl.kr';

const viewIdle = document.getElementById('view-idle');
const viewActive = document.getElementById('view-active');
const nameInput = document.getElementById('name-input');
const createBtn = document.getElementById('create-btn');
const joinInput = document.getElementById('join-input');
const joinBtn = document.getElementById('join-btn');
const errorMsg = document.getElementById('error-msg');
const roomIdDisplay = document.getElementById('room-id-display');
const sessionMeta = document.getElementById('session-meta');
const copyLinkBtn = document.getElementById('copy-link-btn');
const membersList = document.getElementById('members-list');
const modeDisplay = document.getElementById('mode-display');
const roleBadge = document.getElementById('role-badge');
const openSidebarBtn = document.getElementById('open-sidebar-btn');
const leaveBtn = document.getElementById('leave-btn');

let selectedMode = 'follow';
let currentSession = null;

// Restore saved name
chrome.storage.local.get('userName', (data) => {
  if (data.userName) nameInput.value = data.userName;
});

// Mode selection
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
  });
});

// Check existing session
chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (res) => {
  if (res?.session?.active) {
    currentSession = res.session;
    showActiveView();
  }
});

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
  setTimeout(() => errorMsg.classList.add('hidden'), 4000);
}

function showActiveView() {
  viewIdle.classList.add('hidden');
  viewActive.classList.remove('hidden');
  updateActiveView();
}

function showIdleView() {
  viewActive.classList.add('hidden');
  viewIdle.classList.remove('hidden');
}

function updateActiveView() {
  if (!currentSession) return;
  roomIdDisplay.textContent = currentSession.roomId;

  const modeNames = {
    follow: 'Follow Mode',
    free: 'Free Mode',
    group: 'Group Mode',
    presentation: 'Presentation Mode',
  };
  modeDisplay.textContent = modeNames[currentSession.mode] || 'Follow Mode';

  roleBadge.textContent = currentSession.isLeader ? 'Leader' : 'Member';
  roleBadge.style.background = currentSession.isLeader ? '#1e3a5f' : '#1a2e1a';
  roleBadge.style.color = currentSession.isLeader ? '#7dd3fc' : '#86efac';

  const members = currentSession.members || [];
  sessionMeta.textContent = `${members.length} member${members.length !== 1 ? 's' : ''} connected`;

  membersList.innerHTML = members.map(m => `
    <div class="member-item">
      <div class="member-dot" style="background:${m.color}"></div>
      <span class="member-name">${escapeHtml(m.name)}</span>
      ${currentSession.leader === m.id ? '<span class="member-badge">Leader</span>' : ''}
    </div>
  `).join('');
}

async function createSession() {
  const name = nameInput.value.trim();
  if (!name) { showError('Please enter your name'); nameInput.focus(); return; }

  chrome.storage.local.set({ userName: name });
  createBtn.disabled = true;
  createBtn.textContent = 'Creating...';

  try {
    const res = await fetchWithTimeout(`${SERVER_HTTP}/socket.io/`, { method: 'HEAD' }, 3000).catch(() => null);
    // If server unreachable, show error with helpful message
    if (!res) {
      showError('Cannot connect to server. Is the server running?');
      createBtn.disabled = false;
      createBtn.textContent = 'Start Session';
      return;
    }
  } catch (e) {}

  // Open sidebar which handles the actual socket connection
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showError('No active tab found');
    createBtn.disabled = false;
    createBtn.textContent = 'Start Session';
    return;
  }

  // Generate a room ID client-side for immediate feedback, server will validate
  const roomId = generateRoomId();

  currentSession = {
    active: true,
    roomId,
    user: { name, id: null },
    mode: selectedMode,
    isLeader: true,
    members: [{ name, color: '#6366f1', id: 'self' }],
    pendingCreate: true,
  };

  chrome.runtime.sendMessage({
    type: 'SESSION_CREATED',
    session: currentSession,
  });

  showActiveView();
  createBtn.disabled = false;
  createBtn.textContent = 'Start Session';
}

async function joinSession() {
  const name = nameInput.value.trim();
  const code = joinInput.value.trim().toUpperCase();

  if (!name) { showError('Please enter your name'); nameInput.focus(); return; }
  if (!code || code.length < 4) { showError('Please enter a valid room code'); joinInput.focus(); return; }

  chrome.storage.local.set({ userName: name });
  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining...';

  currentSession = {
    active: true,
    roomId: code,
    user: { name, id: null },
    mode: 'follow',
    isLeader: false,
    members: [],
    pendingJoin: true,
  };

  chrome.runtime.sendMessage({
    type: 'SESSION_JOINED',
    session: currentSession,
  });

  showActiveView();
  joinBtn.disabled = false;
  joinBtn.textContent = 'Join Session';
}

function leaveSession() {
  chrome.runtime.sendMessage({ type: 'SESSION_ENDED' });
  currentSession = null;
  showIdleView();
}

function copyInviteLink() {
  if (!currentSession) return;
  const link = `https://b.krl.kr/${currentSession.roomId}`;
  navigator.clipboard.writeText(link).then(() => {
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => { copyLinkBtn.textContent = 'Copy invite link'; }, 2000);
  });
}

function openSidebar() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) chrome.sidePanel.open({ windowId: tab.windowId });
  });
}

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  arr.forEach(b => { id += chars[b % chars.length]; });
  return id;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Event listeners
createBtn.addEventListener('click', createSession);
joinBtn.addEventListener('click', joinSession);
copyLinkBtn.addEventListener('click', copyInviteLink);
leaveBtn.addEventListener('click', leaveSession);
openSidebarBtn.addEventListener('click', openSidebar);

joinInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createSession();
});

joinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinSession();
});
