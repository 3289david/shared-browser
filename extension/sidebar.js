(function () {
  'use strict';

  // ── Color palette (matches server assignment order) ────────────────────────
  const COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#22c55e','#14b8a6','#ef4444','#3b82f6'];
  function initials(name) { return (name || '?').charAt(0).toUpperCase(); }
  function colorFor(id) { if (!id) return COLORS[0]; let h=0; for (const c of id) h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length]; }
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtTime(ts) { const d=new Date(ts||Date.now()); return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); }
  function shortUrl(u) { try { const p=new URL(u); return (p.hostname+p.pathname).replace(/\/$/,'').slice(0,50); } catch { return u?.slice(0,50)||''; } }

  // ── State ──────────────────────────────────────────────────────────────────
  let state = { session:null, members:[], chat:[], annotations:[], history:[], splitUsers:[] };
  let unread = 0;
  let activeTab = 'people';
  let drawOn = false;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const codeEl       = $('code-el');
  const shareLinkEl  = $('share-link-el');
  const copyBtn      = $('copy-btn');
  const modeSel      = $('mode-sel');
  const membersList  = $('members-list');
  const splitBtn     = $('split-btn');
  const leaveBtn     = $('leave-btn');
  const messagesEl   = $('messages');
  const chatInput    = $('chat-input');
  const sendBtn      = $('send-btn');
  const chatBadge    = $('chat-badge');
  const toolHighlight= $('tool-highlight');
  const toolDraw     = $('tool-draw');
  const stickyText   = $('sticky-text');
  const addStickyBtn = $('add-sticky-btn');
  const annList      = $('ann-list');
  const historyList  = $('history-list');

  // ── Init: load state from background ─────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
    if (res) { state = res; }
    applyState();
  });

  function applyState() {
    const s = state.session;
    if (!s?.active) return;

    const code = s.roomId || '------';
    codeEl.textContent = code;
    shareLinkEl.textContent = `b.krl.kr/${code}`;

    if (s.mode) modeSel.value = s.mode;

    const isSplit = state.splitUsers?.includes(s.userId);
    splitBtn.classList.toggle('on', !!isSplit);
    splitBtn.textContent = isSplit ? 'Merge' : 'Split';

    renderMembers(state.members || []);
    renderAllChat(state.chat || []);
    renderAnnotations(state.annotations || []);
    renderHistory(state.history || []);
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
      btn.classList.add('on');
      document.getElementById('panel-' + activeTab)?.classList.add('on');
      if (activeTab === 'chat') { unread = 0; chatBadge.style.display = 'none'; chatBadge.textContent = '0'; }
    });
  });

  // ── Copy link ─────────────────────────────────────────────────────────────
  function getLink() { return `https://b.krl.kr/${state.session?.roomId || ''}`; }

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(getLink()).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy Link', 1500);
    }).catch(() => {});
  });

  codeEl.addEventListener('click', () => {
    navigator.clipboard.writeText(getLink()).then(() => {
      const old = codeEl.textContent;
      codeEl.textContent = 'Copied!';
      setTimeout(() => codeEl.textContent = old, 1200);
    }).catch(() => {});
  });

  // ── Mode selector ─────────────────────────────────────────────────────────
  modeSel.addEventListener('change', () => {
    toParent('SET_MODE', { mode: modeSel.value });
  });

  // ── Split / Leave ─────────────────────────────────────────────────────────
  splitBtn.addEventListener('click', () => {
    const myId = state.session?.userId;
    const isSplit = state.splitUsers?.includes(myId);
    if (isSplit) {
      toParent('MERGE');
      state.splitUsers = (state.splitUsers || []).filter(id => id !== myId);
      splitBtn.classList.remove('on');
      splitBtn.textContent = 'Split';
    } else {
      toParent('SPLIT');
      if (!state.splitUsers) state.splitUsers = [];
      if (myId) state.splitUsers.push(myId);
      splitBtn.classList.add('on');
      splitBtn.textContent = 'Merge';
    }
  });

  leaveBtn.addEventListener('click', () => {
    toParent('LEAVE');
  });

  // ── Members ───────────────────────────────────────────────────────────────
  function renderMembers(members) {
    if (!members.length) {
      membersList.innerHTML = '<div class="empty">No one else here yet.<br>Share your link to invite.</div>';
      return;
    }
    const myId = state.session?.userId;
    const leaderId = state.session?.leader;
    membersList.innerHTML = members.map(m => {
      const color = m.color || colorFor(m.id);
      const isMe = m.id === myId;
      const isLeader = m.id === leaderId;
      const url = m.currentUrl ? shortUrl(m.currentUrl) : '';
      return `<div class="member">
        <div class="avatar" style="background:${color}">${esc(initials(m.name))}</div>
        <div class="member-info">
          <div class="member-name">${esc(m.name)}${isMe?' <span class="badge badge-y">You</span>':''}${isLeader?' <span class="badge badge-l">Leader</span>':''}</div>
          ${url ? `<div class="member-url" title="${esc(m.currentUrl)}">${esc(url)}</div>` : ''}
        </div>
        ${!isMe && state.session?.isLeader ? `<button class="icon-btn" title="Make leader" data-setleader="${esc(m.id)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>` : ''}
        ${!isMe ? `<button class="icon-btn" title="Jump to their page" data-jumpto="${esc(m.id)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>` : ''}
      </div>`;
    }).join('');

    membersList.querySelectorAll('[data-setleader]').forEach(btn => {
      btn.addEventListener('click', () => toParent('SET_LEADER', { userId: btn.dataset.setleader }));
    });
    membersList.querySelectorAll('[data-jumpto]').forEach(btn => {
      btn.addEventListener('click', () => toParent('JUMP_TO', { userId: btn.dataset.jumpto }));
    });
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  function renderAllChat(msgs) {
    messagesEl.innerHTML = '';
    msgs.forEach(addMsgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMsgEl(m) {
    const color = m.color || colorFor(m.userId);
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `<div class="msg-hd">
      <div class="msg-av" style="background:${color}">${esc(initials(m.userName))}</div>
      <span class="msg-name" style="color:${color}">${esc(m.userName)}</span>
      <span class="msg-time">${fmtTime(m.timestamp)}</span>
    </div>
    <div class="msg-text">${esc(m.text)}</div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    chatInput.style.height = '';
    toParent('SEND_CHAT', { text });
  }

  sendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
  });

  document.querySelectorAll('.rxn').forEach(btn => {
    btn.addEventListener('click', () => toParent('REACTION', { emoji: btn.dataset.e }));
  });

  // ── Tools ─────────────────────────────────────────────────────────────────
  toolHighlight.addEventListener('click', () => {
    toParent('HIGHLIGHT', { color: '#facc15' });
  });

  toolDraw.addEventListener('click', () => {
    drawOn = !drawOn;
    toolDraw.classList.toggle('on', drawOn);
    toolDraw.textContent = drawOn ? 'Stop Drawing' : 'Draw';
    toParent(drawOn ? 'DRAW_ON' : 'DRAW_OFF');
  });

  addStickyBtn.addEventListener('click', () => {
    const text = stickyText.value.trim();
    if (!text) return;
    toParent('STICKY', { text, x: 120, y: 120 });
    stickyText.value = '';
  });

  // ── Annotations ───────────────────────────────────────────────────────────
  function renderAnnotations(anns) {
    if (!anns.length) {
      annList.innerHTML = '<div class="empty">No annotations yet.</div>';
      return;
    }
    annList.innerHTML = anns.map(a => {
      const color = a.color || colorFor(a.userId);
      const typeLabel = a.type === 'highlight' ? 'Highlight' : a.type === 'sticky' ? 'Note' : 'Drawing';
      const preview = a.type === 'sticky' ? a.text : a.type === 'highlight' ? (a.note || 'Text highlight') : 'Drawing';
      return `<div class="ann-item">
        <div class="ann-dot" style="background:${color}"></div>
        <div class="ann-body">
          <div class="ann-who">${esc(a.userName || '')} &middot; ${typeLabel}</div>
          <div class="ann-txt">${esc(preview)}</div>
        </div>
        <button class="ann-del" data-annid="${esc(a.id)}" title="Remove">&times;</button>
      </div>`;
    }).join('');
    annList.querySelectorAll('.ann-del').forEach(btn => {
      btn.addEventListener('click', () => toParent('REMOVE_ANN', { id: btn.dataset.annid }));
    });
  }

  // ── History ───────────────────────────────────────────────────────────────
  function renderHistory(hist) {
    if (!hist.length) {
      historyList.innerHTML = '<div class="empty">Navigation history will appear here.</div>';
      return;
    }
    historyList.innerHTML = [...hist].reverse().map(h => {
      const color = h.color || colorFor(h.userId);
      const url = shortUrl(h.url || '');
      return `<div class="hist-item">
        <div class="hist-dot" style="background:${color}"></div>
        <div class="hist-body">
          <div class="hist-url" title="${esc(h.url)}">${esc(url)}</div>
          <div class="hist-who">${esc(h.userName || '')} &middot; ${fmtTime(h.timestamp)}</div>
        </div>
        <button class="hist-go" title="Go to page" data-url="${esc(h.url)}">&#8250;</button>
      </div>`;
    }).join('');
    historyList.querySelectorAll('.hist-go').forEach(btn => {
      btn.addEventListener('click', () => toParent('NAVIGATE', { url: btn.dataset.url }));
    });
  }

  // ── Messages from content script ──────────────────────────────────────────
  window.addEventListener('message', e => {
    if (!e.data?.__sb) return;
    const { type } = e.data;

    switch (type) {

      case 'LIVE_CHAT':
        state.chat = [...(state.chat || []), e.data.message];
        addMsgEl(e.data.message);
        if (activeTab !== 'chat') {
          unread++;
          chatBadge.style.display = 'inline-block';
          chatBadge.textContent = unread > 9 ? '9+' : unread;
        }
        break;

      case 'LIVE_MEMBERS':
        state.members = e.data.members || [];
        renderMembers(state.members);
        break;

      case 'LIVE_HISTORY':
        state.history = e.data.history || [];
        renderHistory(state.history);
        break;

      case 'SERVER_MSG': {
        const msg = e.data.msg;
        if (!msg) break;
        if (msg.type === 'mode_changed') {
          if (state.session) state.session.mode = msg.mode;
          modeSel.value = msg.mode;
        } else if (msg.type === 'leader_changed') {
          if (state.session) {
            state.session.leader = msg.userId;
            state.session.isLeader = msg.userId === state.session.userId;
          }
          renderMembers(state.members || []);
        } else if (msg.type === 'user_split') {
          if (!state.splitUsers) state.splitUsers = [];
          if (!state.splitUsers.includes(msg.userId)) state.splitUsers.push(msg.userId);
          updateSplitBtn();
        } else if (msg.type === 'user_merged') {
          state.splitUsers = (state.splitUsers || []).filter(id => id !== msg.userId);
          updateSplitBtn();
        } else if (msg.type === 'created' || msg.type === 'joined') {
          // Full state refresh
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
            if (res) { state = res; applyState(); }
          });
        }
        break;
      }
    }
  });

  function updateSplitBtn() {
    const myId = state.session?.userId;
    const isSplit = state.splitUsers?.includes(myId);
    splitBtn.classList.toggle('on', !!isSplit);
    splitBtn.textContent = isSplit ? 'Merge' : 'Split';
  }

  // ── postMessage to content script ─────────────────────────────────────────
  function toParent(type, data = {}) {
    window.parent.postMessage({ __sbSidebar: true, type, data }, '*');
  }

})();
