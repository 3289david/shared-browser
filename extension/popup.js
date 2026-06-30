const $ = id => document.getElementById(id);
function setHTML(el, html) { const b = new DOMParser().parseFromString(html, 'text/html').body; el.replaceChildren(...Array.from(b.childNodes)); }
const viewIdle    = $('view-idle');
const viewActive  = $('view-active');
const nameInput   = $('name-input');
const createBtn   = $('create-btn');
const joinInput   = $('join-input');
const joinBtn     = $('join-btn');
const errorMsg    = $('error-msg');
const roomIdEl    = $('room-id-display');
const sessionMeta = $('session-meta');
const copyLinkBtn = $('copy-link-btn');
const membersEl   = $('members-list');
const modeEl      = $('mode-display');
const roleBadge   = $('role-badge');
const sidebarBtn  = $('open-sidebar-btn');
const leaveBtn    = $('leave-btn');

let selectedMode = 'follow';
let fullState = null;

// Restore saved name
chrome.storage.local.get(['sbName'], d => { if (d.sbName) nameInput.value = d.sbName; });

// Check existing session on open
chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
  if (res?.session?.active) { fullState = res; showActive(); }
});

// Mode buttons
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
  });
});

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
  setTimeout(() => errorMsg.classList.add('hidden'), 4000);
}

function showActive() {
  viewIdle.classList.add('hidden');
  viewActive.classList.remove('hidden');
  if (!fullState?.session) return;
  const s = fullState.session;
  roomIdEl.textContent = s.roomId || '------';
  const ms = fullState.members || [];
  sessionMeta.textContent = `${ms.length} member${ms.length !== 1 ? 's' : ''} in session`;
  const modeNames = { follow:'Follow Mode', free:'Free Mode', group:'Group Mode', presentation:'Presentation Mode' };
  modeEl.textContent = modeNames[s.mode] || 'Follow Mode';
  roleBadge.textContent = s.isLeader ? 'Leader' : 'Member';
  roleBadge.style.background = s.isLeader ? '#1e3a5f' : '#1a2e1a';
  roleBadge.style.color = s.isLeader ? '#7dd3fc' : '#86efac';
  setHTML(membersEl, ms.map(m => `
    <div class="member-item">
      <div class="member-dot" style="background:${m.color||'#6366f1'}"></div>
      <span class="member-name">${esc(m.name)}</span>
      ${s.leader === m.id ? '<span class="member-badge">Leader</span>' : ''}
    </div>`).join(''));
}

// Create session
createBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) { showError('Enter your name'); nameInput.focus(); return; }
  chrome.storage.local.set({ sbName: name });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showError('No active tab'); return; }

  createBtn.disabled = true;
  createBtn.textContent = 'Starting...';

  chrome.runtime.sendMessage({
    type: 'SESSION_START',
    session: { active: true, user: { name }, mode: selectedMode, isLeader: true, pendingCreate: true, userId: null },
  }, () => {
    chrome.tabs.sendMessage(tab.id, { type: 'SB_CREATE', name, mode: selectedMode }, () => {
      createBtn.disabled = false;
      createBtn.textContent = 'Start Session';
      window.close();
    });
  });
});

// Join session
joinBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  const code = joinInput.value.trim().toUpperCase();
  if (!name) { showError('Enter your name'); nameInput.focus(); return; }
  if (!code || code.length < 4) { showError('Enter a valid room code'); joinInput.focus(); return; }
  chrome.storage.local.set({ sbName: name });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showError('No active tab'); return; }

  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining...';

  chrome.runtime.sendMessage({
    type: 'SESSION_START',
    session: { active: true, roomId: code, user: { name }, mode: 'follow', isLeader: false, pendingJoin: true, userId: null },
  }, () => {
    chrome.tabs.sendMessage(tab.id, { type: 'SB_JOIN', roomId: code, name }, () => {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join Session';
      window.close();
    });
  });
});

// Copy link
copyLinkBtn.addEventListener('click', () => {
  const code = fullState?.session?.roomId;
  if (!code) return;
  navigator.clipboard.writeText(`https://b.krl.kr/${code}`).then(() => {
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => copyLinkBtn.textContent = 'Copy invite link', 2000);
  }).catch(() => {});
});

// Open sidebar
sidebarBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab && chrome.sidePanel) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  });
});

// Leave
leaveBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SESSION_END' }, () => {
    fullState = null;
    viewActive.classList.add('hidden');
    viewIdle.classList.remove('hidden');
  });
});

// Input cleanup
joinInput.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
joinInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
