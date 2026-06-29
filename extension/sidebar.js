// Sidebar script - runs inside the sidebar iframe

let session = null;
let annotations = [];
let history = [];
let selectedTool = 'highlight';
let isSplit = false;
let unreadChat = 0;
let activeTab = 'people';

const roomIdEl = document.getElementById('room-id');
const membersContainer = document.getElementById('members-container');
const modeSelect = document.getElementById('mode-select');
const splitBtn = document.getElementById('split-btn');
const mergeBtn = document.getElementById('merge-btn');
const leaveBtn = document.getElementById('leave-btn');
const messagesContainer = document.getElementById('messages-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const chatBadge = document.getElementById('chat-badge');
const annotationsContainer = document.getElementById('annotations-container');
const historyContainer = document.getElementById('history-container');
const addAnnotationBtn = document.getElementById('add-annotation-btn');
const stickyModal = document.getElementById('sticky-modal');
const stickyText = document.getElementById('sticky-text');
const stickyCancel = document.getElementById('sticky-cancel');
const stickyOk = document.getElementById('sticky-ok');

// Tab switching
document.querySelectorAll('.sb-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sb-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sb-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    document.getElementById(`panel-${activeTab}`).classList.add('active');

    if (activeTab === 'chat') {
      unreadChat = 0;
      chatBadge.classList.add('hidden');
      scrollChat();
    }
  });
});

// Tool selection
document.querySelectorAll('.sb-tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sb-tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedTool = btn.dataset.tool;
    updateAddBtn();
  });
});

function updateAddBtn() {
  if (selectedTool === 'highlight') {
    addAnnotationBtn.textContent = 'Add Selected Text as Highlight';
  } else if (selectedTool === 'sticky') {
    addAnnotationBtn.textContent = 'Add Sticky Note to Page';
  } else {
    addAnnotationBtn.textContent = 'Start Drawing (click to toggle)';
  }
}

// Add annotation button
addAnnotationBtn.addEventListener('click', () => {
  if (selectedTool === 'highlight') {
    post('ADD_HIGHLIGHT', { note: '', color: userColor() });
  } else if (selectedTool === 'sticky') {
    stickyText.value = '';
    stickyModal.classList.remove('hidden');
    stickyText.focus();
  }
});

// Sticky modal
stickyCancel.addEventListener('click', () => stickyModal.classList.add('hidden'));
stickyOk.addEventListener('click', () => {
  const text = stickyText.value.trim();
  if (!text) return;
  post('ADD_STICKY', {
    text,
    x: 100,
    y: 100,
    color: '#fef08a',
  });
  stickyModal.classList.add('hidden');
});

// Mode change
modeSelect.addEventListener('change', () => {
  post('SET_MODE', { mode: modeSelect.value });
});

// Split/Merge
splitBtn.addEventListener('click', () => {
  isSplit = true;
  post('SPLIT');
  splitBtn.classList.add('hidden');
  mergeBtn.classList.remove('hidden');
});

mergeBtn.addEventListener('click', () => {
  isSplit = false;
  post('MERGE');
  mergeBtn.classList.add('hidden');
  splitBtn.classList.remove('hidden');
});

// Leave
leaveBtn.addEventListener('click', () => {
  if (confirm('Leave this session?')) {
    post('LEAVE_SESSION');
  }
});

// Room ID copy
roomIdEl.addEventListener('click', () => {
  if (!session) return;
  const link = `https://b.krl.kr/join/${session.roomId}`;
  navigator.clipboard.writeText(link).then(() => {
    const orig = roomIdEl.textContent;
    roomIdEl.textContent = 'Copied!';
    setTimeout(() => { roomIdEl.textContent = orig; }, 1500);
  });
});

// Chat
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
});

sendBtn.addEventListener('click', sendMessage);

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  post('SEND_CHAT', { text });
  chatInput.value = '';
  chatInput.style.height = 'auto';
}

// Reactions
document.querySelectorAll('.sb-reaction-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    post('REACTION', { emoji: btn.dataset.emoji });
  });
});

// ---- Render functions ----

function renderMembers() {
  if (!session) { membersContainer.innerHTML = ''; return; }
  const members = session.members || [];

  if (!members.length) {
    membersContainer.innerHTML = '<div class="sb-empty">No members yet</div>';
    return;
  }

  membersContainer.innerHTML = members.map(m => {
    const isYou = m.id === session.user?.id;
    const isLeader = m.id === session.leader;
    const initial = (m.name || '?').charAt(0).toUpperCase();

    return `
      <div class="sb-member" style="margin-bottom:6px">
        <div class="sb-member-avatar" style="background:${m.color}">${initial}</div>
        <div class="sb-member-info">
          <div class="sb-member-name">
            ${escapeHtml(m.name)}
            ${isYou ? '<span class="sb-badge sb-badge-you" style="margin-left:4px">You</span>' : ''}
            ${isLeader ? '<span class="sb-badge sb-badge-leader" style="margin-left:4px">Leader</span>' : ''}
          </div>
          <div class="sb-member-url">${m.currentUrl ? trimUrl(m.currentUrl) : 'No page'}</div>
        </div>
        <div class="sb-member-actions">
          ${!isYou ? `<button class="sb-icon-btn" onclick="jumpTo('${m.id}')" title="Jump to their page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>
            </svg>
          </button>` : ''}
          ${session.isLeader && !isYou ? `<button class="sb-icon-btn" onclick="makeLeader('${m.id}')" title="Make leader">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

window.jumpTo = (userId) => post('JUMP_TO_USER', { userId });
window.makeLeader = (userId) => post('SET_LEADER', { userId });

function appendMessage(msg) {
  const el = document.createElement('div');
  el.className = 'sb-message';
  el.dataset.id = msg.id;
  const initial = (msg.userName || '?').charAt(0).toUpperCase();
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  el.innerHTML = `
    <div class="sb-message-header">
      <div class="sb-message-avatar" style="background:${msg.color}">${initial}</div>
      <span class="sb-message-name" style="color:${msg.color}">${escapeHtml(msg.userName)}</span>
      <span class="sb-message-time">${time}</span>
    </div>
    <div class="sb-message-text">${escapeHtml(msg.text)}</div>
  `;

  messagesContainer.appendChild(el);

  if (activeTab !== 'chat') {
    unreadChat++;
    chatBadge.textContent = unreadChat > 9 ? '9+' : unreadChat;
    chatBadge.classList.remove('hidden');
  }
}

function scrollChat() {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

function renderAnnotations() {
  if (!annotations.length) {
    annotationsContainer.innerHTML = '<div class="sb-empty">No annotations yet</div>';
    return;
  }

  annotationsContainer.innerHTML = annotations.map(a => `
    <div class="sb-annotation-item" style="margin-bottom:6px">
      <div class="sb-annotation-color" style="background:${a.color}"></div>
      <div class="sb-annotation-body">
        <div class="sb-annotation-who">${escapeHtml(a.userName)} - ${a.type}</div>
        <div class="sb-annotation-text">${escapeHtml(a.text || a.note || trimUrl(a.url) || '')}</div>
      </div>
      <button class="sb-annotation-del" onclick="removeAnnotation('${a.id}')" title="Remove">x</button>
    </div>
  `).join('');
}

window.removeAnnotation = (id) => post('REMOVE_ANNOTATION', { id });

function renderHistory() {
  if (!history.length) {
    historyContainer.innerHTML = '<div class="sb-empty">No browsing history yet</div>';
    return;
  }

  historyContainer.innerHTML = history.slice().reverse().map(h => {
    const member = session?.members?.find(m => m.id === h.userId);
    const color = member?.color || '#6366f1';
    const time = new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="sb-history-item" style="margin-bottom:4px">
        <div class="sb-history-dot" style="background:${color}"></div>
        <div class="sb-history-info">
          <div class="sb-history-url">${trimUrl(h.url)}</div>
          <div class="sb-history-who">${escapeHtml(h.userName)} - ${time}</div>
        </div>
        <button class="sb-history-goto" onclick="gotoUrl('${escapeHtml(h.url)}')" title="Go to this URL">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </button>
      </div>
    `;
  }).join('');
}

window.gotoUrl = (url) => post('NAVIGATE', { url });

// ---- Messages from content script ----

window.addEventListener('message', (event) => {
  if (!event.data || event.data.source !== 'shared-browser') return;
  const { type } = event.data;

  switch (type) {
    case 'INIT':
      session = event.data.session;
      annotations = event.data.annotations || [];
      updateUI();
      break;

    case 'SESSION_UPDATED':
      session = event.data.session;
      renderMembers();
      if (session?.mode) modeSelect.value = session.mode;
      break;

    case 'CHAT_MESSAGE':
      appendMessage(event.data.message);
      if (activeTab === 'chat') scrollChat();
      break;

    case 'SERVER_EVENT': {
      const { event: ev, data } = event.data;

      if (ev === 'user_joined' && session) {
        const u = data.user || data;
        if (u && !session.members.find(m => m.id === u.id)) session.members.push(u);
        renderMembers();
      }

      if (ev === 'user_left' && session) {
        session.members = session.members.filter(m => m.id !== (data.userId || data.id));
        renderMembers();
      }

      if (ev === 'mode_changed' && session) {
        session.mode = data.mode;
        modeSelect.value = data.mode;
      }

      if (ev === 'leader_changed' && session) {
        session.leader = data.userId;
        session.isLeader = data.userId === session.user?.id;
        renderMembers();
      }

      if (ev === 'user_navigated' && session) {
        const member = session.members.find(m => m.id === data.userId);
        if (member) { member.currentUrl = data.url; renderMembers(); }
        history.push({ userId: data.userId, userName: data.userName || '?', url: data.url, timestamp: Date.now() });
        renderHistory();
      }

      if (ev === 'annotation_added') {
        annotations.push(data.annotation || data);
        renderAnnotations();
      }

      if (ev === 'annotation_removed') {
        annotations = annotations.filter(a => a.id !== (data.id));
        renderAnnotations();
      }
      break;
    }

    case 'TEXT_SELECTED':
      if (selectedTool === 'highlight') {
        addAnnotationBtn.textContent = `Highlight: "${event.data.text.slice(0, 30)}..."`;
      }
      break;
  }
});

function updateUI() {
  if (!session) return;
  roomIdEl.textContent = session.roomId || '------';
  if (session.mode) modeSelect.value = session.mode;
  renderMembers();
  renderAnnotations();
  renderHistory();
}

// ---- Utils ----

function post(type, data) {
  window.parent.postMessage({ source: 'shared-browser-sidebar', type, data }, '*');
}

function userColor() {
  return session?.user?.color || '#6366f1';
}

function trimUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 30) : '');
  } catch {
    return url.slice(0, 40);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
