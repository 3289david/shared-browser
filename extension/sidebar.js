(function () {
  'use strict';

  const COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#22c55e','#14b8a6','#ef4444','#3b82f6'];
  function setHTML(el, html) { const b = new DOMParser().parseFromString(html, 'text/html').body; el.replaceChildren(...Array.from(b.childNodes)); }
  function initials(n) { return (n||'?').charAt(0).toUpperCase(); }
  function colorFor(id) { if (!id) return COLORS[0]; let h=0; for (const c of id) h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length]; }
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtTime(ts) { const d=new Date(ts||Date.now()); return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); }
  function shortUrl(u) { try { const p=new URL(u); return (p.hostname+p.pathname).replace(/\/$/,'').slice(0,48); } catch { return u?.slice(0,48)||''; } }

  // ── State ──────────────────────────────────────────────────────────────────
  let state = { session:null, members:[], chat:[], annotations:[], history:[], splitUsers:[] };
  let unread = 0;
  let activeTab = 'people';
  let drawOn = false;
  let noteOn = false;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const codeEl      = $('code-el');
  const codeText    = $('code-text');
  const shareUrl    = $('share-url');
  const copyBtn     = $('copy-btn');
  const leaveBtn    = $('leave-btn');
  const modeSel     = $('mode-sel');
  const splitBtn    = $('split-btn');
  const membersList = $('members-list');
  const messagesEl  = $('messages');
  const chatInput   = $('chat-input');
  const sendBtn     = $('send-btn');
  const chatDot     = $('chat-dot');
  const toolHL      = $('tool-highlight');
  const toolDraw    = $('tool-draw');
  const drawLbl     = $('draw-lbl');
  const toolNote    = $('tool-note');
  const noteForm    = $('note-form');
  const noteText    = $('note-text');
  const noteAdd     = $('note-add');
  const annList     = $('ann-list');
  const annCount    = $('ann-count');

  // ── Init ──────────────────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
    if (res) state = res;
    applyState();
  });

  // Backup 1: storage event — content.js writes _sbRoomId when roomId arrives.
  // chrome.storage.onChanged fires reliably in extension pages regardless of
  // postMessage timing, so this is the most reliable delivery path.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes._sbRoomId?.newValue) return;
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, r => {
      if (r?.session?.active) { state = r; applyState(); }
    });
  });

  // Backup 2: poll background directly every 500ms until roomId arrives
  const _bgPoll = setInterval(() => {
    if (state.session?.roomId) { clearInterval(_bgPoll); return; }
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, r => {
      if (r?.session?.roomId) { state = r; applyState(); clearInterval(_bgPoll); }
    });
  }, 500);
  setTimeout(() => clearInterval(_bgPoll), 30000);

  function applyState() {
    const s = state.session;
    if (!s?.active) return;
    const code = s.roomId || '------';
    codeText.textContent = code;
    shareUrl.textContent = `b.krl.kr/${code}`;
    if (s.mode) modeSel.value = s.mode;
    updateSplitBtn();
    renderMembers(state.members || []);
    renderAllChat(state.chat || []);
    renderAnnotations(state.annotations || []);
    renderHistory(state.history || []);
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
      btn.classList.add('on');
      $('panel-' + activeTab)?.classList.add('on');
      if (activeTab === 'chat') {
        unread = 0;
        chatDot.classList.remove('on');
      }
    });
  });

  // ── Copy / share link ─────────────────────────────────────────────────────
  function getLink() { return `https://b.krl.kr/${state.session?.roomId || ''}`; }

  function copyText(text, onDone) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(onDone).catch(() => execCommandCopy(text, onDone));
    } else {
      execCommandCopy(text, onDone);
    }
  }

  function execCommandCopy(text, onDone) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); onDone(); } catch {}
    ta.remove();
  }

  copyBtn.addEventListener('click', () => {
    if (!state.session?.roomId) {
      copyBtn.textContent = 'Not ready...';
      setTimeout(() => copyBtn.textContent = 'Copy Link', 1200);
      return;
    }
    copyText(getLink(), () => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy Link', 1500);
    });
  });

  codeEl.addEventListener('click', () => {
    if (!state.session?.roomId) return;
    copyText(getLink(), () => {
      const old = codeText.textContent;
      codeText.textContent = 'Copied!';
      setTimeout(() => codeText.textContent = old, 1300);
    });
  });

  // ── Leave ─────────────────────────────────────────────────────────────────
  leaveBtn.addEventListener('click', () => toParent('LEAVE'));

  // ── Mode ──────────────────────────────────────────────────────────────────
  modeSel.addEventListener('change', () => toParent('SET_MODE', { mode: modeSel.value }));

  // ── Split ─────────────────────────────────────────────────────────────────
  splitBtn.addEventListener('click', () => {
    const myId = state.session?.userId;
    const isSplit = state.splitUsers?.includes(myId);
    if (isSplit) {
      toParent('MERGE');
      state.splitUsers = (state.splitUsers||[]).filter(id => id !== myId);
    } else {
      toParent('SPLIT');
      if (!state.splitUsers) state.splitUsers = [];
      if (myId) state.splitUsers.push(myId);
    }
    updateSplitBtn();
  });

  function updateSplitBtn() {
    const isSplit = state.splitUsers?.includes(state.session?.userId);
    splitBtn.classList.toggle('on', !!isSplit);
    splitBtn.textContent = isSplit ? 'Merge' : 'Split';
  }

  // ── Members ───────────────────────────────────────────────────────────────
  function renderMembers(members) {
    const myId = state.session?.userId;
    const leaderId = state.session?.leader;

    let html = '';
    if (!members.length) {
      html = '<div class="empty">No one else here yet.<br>Share the link to invite.</div>';
    } else {
      html = members.map(m => {
        const color = m.color || colorFor(m.id);
        const isMe = m.id === myId;
        const isLeader = m.id === leaderId;
        const url = m.currentUrl ? shortUrl(m.currentUrl) : '';
        const acts = !isMe ? `
          <div class="m-acts">
            ${state.session?.isLeader ? `<button class="ic" title="Make leader" data-leader="${esc(m.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>` : ''}
            <button class="ic" title="Jump to their page" data-jump="${esc(m.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>` : '';
        return `<div class="member">
          <div class="av" style="background:${color}">${esc(initials(m.name))}</div>
          <div class="m-info">
            <div class="m-name">
              ${esc(m.name)}
              ${isMe ? '<span class="badge you">You</span>' : ''}
              ${isLeader ? '<span class="badge ldr">Leader</span>' : ''}
            </div>
            ${url ? `<div class="m-url" title="${esc(m.currentUrl)}">${esc(url)}</div>` : ''}
          </div>
          ${acts}
        </div>`;
      }).join('');
    }

    // Append history
    const hist = (state.history || []).slice(-8).reverse();
    if (hist.length) {
      html += '<div class="sec-hd">Recent navigation</div>';
      html += hist.map(h => {
        const color = h.color || colorFor(h.userId);
        const url = shortUrl(h.url || '');
        return `<div class="h-item">
          <div class="h-dot" style="background:${color}"></div>
          <div class="h-body">
            <div class="h-url" title="${esc(h.url)}">${esc(url)}</div>
            <div class="h-who">${esc(h.userName||'')} &middot; ${fmtTime(h.timestamp)}</div>
          </div>
          <button class="h-go" title="Go there" data-url="${esc(h.url)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>`;
      }).join('');
    }

    setHTML(membersList, html);

    membersList.querySelectorAll('[data-leader]').forEach(b =>
      b.addEventListener('click', () => toParent('SET_LEADER', { userId: b.dataset.leader })));
    membersList.querySelectorAll('[data-jump]').forEach(b =>
      b.addEventListener('click', () => toParent('JUMP_TO', { userId: b.dataset.jump })));
    membersList.querySelectorAll('[data-url]').forEach(b =>
      b.addEventListener('click', () => toParent('NAVIGATE', { url: b.dataset.url })));
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  function renderAllChat(msgs) {
    messagesEl.replaceChildren();
    msgs.forEach(appendMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMsg(m) {
    const color = m.color || colorFor(m.userId);
    const div = document.createElement('div');
    div.className = 'msg';
    setHTML(div, `<div class="msg-hd">
      <div class="msg-av" style="background:${color}">${esc(initials(m.userName))}</div>
      <span class="msg-name" style="color:${color}">${esc(m.userName)}</span>
      <span class="msg-time">${fmtTime(m.timestamp)}</span>
    </div>
    <div class="msg-body">${esc(m.text)}</div>`);
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

  document.querySelectorAll('.rxn').forEach(btn =>
    btn.addEventListener('click', () => toParent('REACTION', { emoji: btn.dataset.e })));

  // ── Annotate tools ────────────────────────────────────────────────────────
  toolHL.addEventListener('click', () => {
    toParent('HIGHLIGHT', { color: '#facc15' });
    // brief pulse to confirm
    toolHL.classList.add('on');
    setTimeout(() => toolHL.classList.remove('on'), 600);
  });

  toolDraw.addEventListener('click', () => {
    drawOn = !drawOn;
    toolDraw.classList.toggle('on', drawOn);
    drawLbl.textContent = drawOn ? 'Stop' : 'Draw';
    toParent(drawOn ? 'DRAW_ON' : 'DRAW_OFF');
    // close note form if open
    if (drawOn && noteOn) { noteOn = false; toolNote.classList.remove('on'); noteForm.classList.remove('on'); }
  });

  toolNote.addEventListener('click', () => {
    noteOn = !noteOn;
    toolNote.classList.toggle('on', noteOn);
    noteForm.classList.toggle('on', noteOn);
    if (noteOn) noteText.focus();
  });

  noteAdd.addEventListener('click', () => {
    const text = noteText.value.trim();
    if (!text) { noteText.focus(); return; }
    toParent('STICKY', { text, x: 120, y: 120 });
    noteText.value = '';
    // close form after adding
    noteOn = false;
    toolNote.classList.remove('on');
    noteForm.classList.remove('on');
  });

  // ── Annotations list ──────────────────────────────────────────────────────
  function renderAnnotations(anns) {
    const pageAnns = (anns || []).filter(a => !a.url || a.url === ''); // show all since url context varies
    annCount.textContent = anns.length;

    if (!anns.length) {
      setHTML(annList, '<div class="empty">No annotations yet.<br>Highlight text, draw, or add a sticky note.</div>');
      return;
    }

    setHTML(annList, anns.map(a => {
      const color = a.color || colorFor(a.userId);
      let iconClass = '', iconChar = '', tagStyle = '', typeLabel = '';
      if (a.type === 'highlight') {
        iconClass = 'hl'; iconChar = '🔆'; typeLabel = 'Highlight';
        tagStyle = 'background:rgba(250,204,21,.18);color:#fde047;';
      } else if (a.type === 'drawing') {
        iconClass = 'dk'; iconChar = '✏️'; typeLabel = 'Drawing';
        tagStyle = 'background:rgba(239,68,68,.15);color:#fca5a5;';
      } else {
        iconClass = 'st'; iconChar = '📌'; typeLabel = 'Note';
        tagStyle = 'background:rgba(251,191,36,.15);color:#fcd34d;';
      }
      const preview = a.type === 'sticky' ? a.text
        : a.type === 'highlight' ? (a.note || 'Text highlighted on page')
        : 'Drawing on page';

      return `<div class="ann-card">
        <div class="ann-icon ${iconClass}">${iconChar}</div>
        <div class="ann-body">
          <div class="ann-meta">
            <span class="ann-who">${esc(a.userName||'Unknown')}</span>
            <span class="ann-type-tag" style="${tagStyle}">${typeLabel}</span>
          </div>
          <div class="ann-preview">${esc(preview)}</div>
        </div>
        <button class="ann-del" data-id="${esc(a.id)}" title="Delete annotation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>`;
    }).join(''));

    annList.querySelectorAll('.ann-del').forEach(btn =>
      btn.addEventListener('click', () => toParent('REMOVE_ANN', { id: btn.dataset.id })));
  }

  function renderHistory(hist) {
    // History is now rendered inside renderMembers
    renderMembers(state.members || []);
  }

  // ── Live updates from content script ─────────────────────────────────────
  window.addEventListener('message', e => {
    if (!e.data?.__sb) return;

    switch (e.data.type) {

      case 'SESSION_CHANGED':
        state = { ...state, ...e.data.state };
        applyState();
        break;

      case 'LIVE_CHAT': {
        state.chat = [...(state.chat||[]), e.data.message];
        appendMsg(e.data.message);
        if (activeTab !== 'chat') {
          unread++;
          chatDot.classList.add('on');
        }
        break;
      }

      case 'LIVE_MEMBERS':
        state.members = e.data.members || [];
        renderMembers(state.members);
        break;

      case 'LIVE_HISTORY':
        state.history = e.data.history || [];
        renderMembers(state.members || []);  // history renders inside members panel
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
          state.splitUsers = (state.splitUsers||[]).filter(id => id !== msg.userId);
          updateSplitBtn();
        } else if (msg.type === 'created' || msg.type === 'joined') {
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
              if (res?.session?.active) { state = res; applyState(); }
            });
          }, 150);
        }
        break;
      }

      case 'ANNOTATION_ADDED':
        if (e.data.annotation) {
          state.annotations = [...(state.annotations||[]), e.data.annotation];
          renderAnnotations(state.annotations);
        }
        break;

      case 'ANNOTATION_REMOVED':
        if (e.data.id) {
          state.annotations = (state.annotations||[]).filter(a => a.id !== e.data.id);
          renderAnnotations(state.annotations);
        }
        break;
    }
  });

  // ── Send to content script ────────────────────────────────────────────────
  function toParent(type, data = {}) {
    window.parent.postMessage({ __sbSidebar: true, type, data }, '*');
  }

})();
