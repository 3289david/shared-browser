// Shared Browser - content script
// Injected into every page. Handles: live cursors, sidebar, annotations, WebSocket.

(function () {
  if (window.__sharedBrowserInjected) return;
  window.__sharedBrowserInjected = true;

  // ---- Config ----
  const SERVER_WS = 'wss://b.krl.kr';
  const JOIN_HOSTS = ['b.krl.kr'];

  // ---- State ----
  let ws = null;
  let session = null;
  let sidebarFrame = null;
  let overlay = null;
  let cursorThrottle = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let isSplit = false;

  // ---- WebSocket connection (raw WS, no socket.io) ----

  function connect(onOpen) {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(SERVER_WS + '/ws');
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      clearTimeout(reconnectTimer);
      startPing();
      if (onOpen) onOpen();
      else if (session) rejoin();
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMsg(msg);
    };

    ws.onclose = () => {
      stopPing();
      scheduleReconnect();
    };

    ws.onerror = () => { ws.close(); };
  }

  function send(type, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type, ...data }));
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send('ping'), 25000);
  }

  function stopPing() {
    clearInterval(pingTimer);
    pingTimer = null;
  }

  function scheduleReconnect() {
    if (!session?.active) return;
    reconnectTimer = setTimeout(() => connect(() => rejoin()), 3000);
  }

  function rejoin() {
    if (!session) return;
    if (session.pendingCreate) {
      send('create', { name: session.user.name, mode: session.mode });
    } else {
      send('join', { roomId: session.roomId, name: session.user.name });
    }
  }

  // ---- Message handler ----

  function handleMsg(msg) {
    switch (msg.type) {
      case 'created':
        session = { ...session, roomId: msg.roomId, user: msg.user, isLeader: true, pendingCreate: false };
        chrome.runtime.sendMessage({ type: 'UPDATE_SESSION', updates: { roomId: msg.roomId, user: msg.user, isLeader: true, members: msg.room.users } });
        postSidebar({ type: 'INIT', session, annotations: msg.room.annotations || [], history: msg.room.history || [] });
        loadChatHistory(msg.room.chat || []);
        break;

      case 'joined':
        session = { ...session, roomId: msg.roomId, user: msg.user, isLeader: false, pendingJoin: false };
        chrome.runtime.sendMessage({ type: 'UPDATE_SESSION', updates: { roomId: msg.roomId, user: msg.user, isLeader: false, members: msg.room.users } });
        postSidebar({ type: 'INIT', session, annotations: msg.room.annotations || [], history: msg.room.history || [] });
        loadChatHistory(msg.room.chat || []);
        // In follow mode, navigate to the leader's page
        if (msg.room.state?.url && msg.room.state.url !== window.location.href) {
          window.location.href = msg.room.state.url;
        }
        break;

      case 'error':
        showToast(msg.message || 'Error', '#ef4444');
        break;

      case 'navigate':
        if (!isSplit && msg.url && msg.url !== window.location.href) {
          window.location.href = msg.url;
        }
        break;

      case 'scroll':
        if (!isSplit && !session?.isLeader && session?.mode === 'follow') {
          window.scrollTo(msg.x, msg.y);
        }
        break;

      case 'cursor':
        renderRemoteCursor(msg);
        break;

      case 'chat':
        postSidebar({ type: 'CHAT_MESSAGE', message: msg });
        showChatToast(msg);
        break;

      case 'reaction':
        showReaction(msg);
        break;

      case 'annotation_added':
        postSidebar({ type: 'SERVER_EVENT', event: 'annotation_added', data: msg.annotation });
        renderAnnotation(msg.annotation);
        break;

      case 'annotation_removed':
        document.querySelectorAll(`[data-ann-id="${msg.id}"]`).forEach(el => el.remove());
        postSidebar({ type: 'SERVER_EVENT', event: 'annotation_removed', data: { id: msg.id } });
        break;

      case 'user_joined':
      case 'user_left':
      case 'user_navigated':
      case 'mode_changed':
      case 'leader_changed':
      case 'permission_changed':
      case 'user_split':
      case 'user_merged':
        postSidebar({ type: 'SERVER_EVENT', event: msg.type, data: msg });
        if (msg.type === 'mode_changed' && session) session.mode = msg.mode;
        if (msg.type === 'leader_changed' && session) {
          session.isLeader = msg.userId === session.user?.id;
        }
        break;

      case 'pong':
        break;
    }
  }

  // ---- Sidebar ----

  function injectSidebar() {
    if (sidebarFrame || document.getElementById('sb-sidebar-container')) return;

    const container = document.createElement('div');
    container.id = 'sb-sidebar-container';
    container.style.cssText = `
      position: fixed; top: 0; right: 0; width: 320px; height: 100vh;
      z-index: 2147483647; pointer-events: none;
    `;

    sidebarFrame = document.createElement('iframe');
    sidebarFrame.src = chrome.runtime.getURL('sidebar.html');
    sidebarFrame.style.cssText = `
      width: 100%; height: 100%; border: none; pointer-events: all;
      box-shadow: -4px 0 32px rgba(0,0,0,0.2);
    `;

    container.appendChild(sidebarFrame);
    document.body.appendChild(container);
    document.body.style.marginRight = '320px';
    document.body.style.transition = 'margin-right 0.25s ease';

    sidebarFrame.onload = () => {
      setTimeout(() => {
        postSidebar({ type: 'INIT', session, annotations: [], history: [] });
      }, 150);
    };
  }

  function removeSidebar() {
    document.getElementById('sb-sidebar-container')?.remove();
    sidebarFrame = null;
    document.body.style.marginRight = '';
  }

  function postSidebar(msg) {
    sidebarFrame?.contentWindow?.postMessage({ source: 'shared-browser', ...msg }, '*');
  }

  function loadChatHistory(messages) {
    messages.forEach(m => postSidebar({ type: 'CHAT_MESSAGE', message: m }));
  }

  // ---- Cursor overlay ----

  function ensureOverlay() {
    if (overlay && document.contains(overlay)) return;
    overlay = document.createElement('div');
    overlay.id = 'sb-cursor-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.body.appendChild(overlay);
  }

  function renderRemoteCursor({ userId, name, color, x, y, scrollX, scrollY }) {
    ensureOverlay();
    const id = `sb-cur-${userId}`;
    let el = document.getElementById(id);

    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;transition:left .06s,top .06s;display:flex;flex-direction:column;align-items:flex-start;';
      el.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 18 18" fill="${color}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">
          <path d="M3 1.5L15 8.5L9.5 10L7.2 15L3 1.5Z"/>
        </svg>
        <span style="background:${color};color:#fff;font-size:11px;font-family:system-ui;font-weight:600;padding:1px 6px;border-radius:3px;white-space:nowrap;margin-top:1px;box-shadow:0 1px 4px rgba(0,0,0,.3)">${escHtml(name)}</span>
      `;
      overlay.appendChild(el);
    }

    const ax = x + (scrollX - window.scrollX);
    const ay = y + (scrollY - window.scrollY);
    el.style.left = ax + 'px';
    el.style.top = ay + 'px';
    el.style.opacity = '1';

    clearTimeout(el._hide);
    el._hide = setTimeout(() => { if (el) el.style.opacity = '0'; }, 5000);
  }

  // ---- Annotations ----

  function renderAnnotation(a) {
    if (a.url && a.url !== window.location.href) return;
    if (a.type === 'highlight') renderHighlight(a);
    else if (a.type === 'sticky') renderSticky(a);
  }

  function renderHighlight(a) {
    if (!a.range) return;
    try {
      const range = deserializeRange(a.range);
      if (!range) return;
      for (const rect of range.getClientRects()) {
        const el = document.createElement('div');
        el.className = 'sb-ann';
        el.dataset.annId = a.id;
        el.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:${a.color}50;border-bottom:2px solid ${a.color};pointer-events:auto;cursor:pointer;z-index:2147483640;`;
        el.title = `${a.userName}${a.note ? ': ' + a.note : ''}`;
        document.body.appendChild(el);
      }
    } catch (_) {}
  }

  function renderSticky(a) {
    const el = document.createElement('div');
    el.className = 'sb-ann';
    el.dataset.annId = a.id;
    el.style.cssText = `position:fixed;left:${a.x}px;top:${a.y}px;background:${a.color || '#fef08a'};color:#1a1a1a;padding:8px 12px;border-radius:6px;font-size:13px;font-family:system-ui;max-width:200px;box-shadow:2px 3px 8px rgba(0,0,0,.2);z-index:2147483641;cursor:move;user-select:none;word-wrap:break-word;`;
    el.innerHTML = `<div style="font-weight:700;font-size:10px;opacity:.6;margin-bottom:3px">${escHtml(a.userName)}</div>${escHtml(a.text)}`;
    document.body.appendChild(el);
  }

  function serializeRange(range) {
    let sOff = 0, eOff = 0;
    const w1 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, found = false;
    while ((n = w1.nextNode())) {
      if (n === range.startContainer) { sOff += range.startOffset; found = true; break; }
      sOff += n.textContent.length;
    }
    if (!found) return null;
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let off = 0;
    while ((n = w2.nextNode())) {
      if (n === range.endContainer) { eOff = off + range.endOffset; break; }
      off += n.textContent.length;
    }
    return { startOffset: sOff, endOffset: eOff };
  }

  function deserializeRange(d) {
    try {
      const range = document.createRange();
      let cur = 0;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n, sNode, sOff, eNode, eOff;
      while ((n = w.nextNode())) {
        const len = n.textContent.length;
        if (!sNode && cur + len >= d.startOffset) { sNode = n; sOff = d.startOffset - cur; }
        if (!eNode && cur + len >= d.endOffset) { eNode = n; eOff = d.endOffset - cur; }
        if (sNode && eNode) break;
        cur += len;
      }
      if (!sNode || !eNode) return null;
      range.setStart(sNode, sOff);
      range.setEnd(eNode, eOff);
      return range;
    } catch { return null; }
  }

  // ---- Reactions ----

  function showReaction({ emoji, x, y }) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:${x || window.innerWidth/2}px;top:${y || window.innerHeight/2}px;font-size:30px;pointer-events:none;z-index:2147483647;animation:sb-float 2s ease-out forwards;`;
    el.textContent = emoji;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2100);
  }

  function showChatToast(msg) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:80px;right:340px;background:#1e1e2e;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;font-family:system-ui;box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:2147483647;border-left:3px solid ${msg.color};max-width:240px;animation:sb-slide 0.3s ease;`;
    el.innerHTML = `<div style="font-weight:600;color:${msg.color};margin-bottom:2px">${escHtml(msg.userName)}</div><div style="opacity:.9">${escHtml((msg.text||'').slice(0,80))}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function showToast(text, color) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:20px;right:20px;background:#1e1e2e;color:#fff;padding:12px 18px;border-radius:8px;font-size:14px;font-family:system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:2147483647;border-left:3px solid ${color||'#6366f1'};`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ---- Mouse tracking ----

  function trackMouse() {
    document.addEventListener('mousemove', (e) => {
      if (!session?.active || cursorThrottle) return;
      cursorThrottle = setTimeout(() => {
        cursorThrottle = null;
        send('cursor', { x: e.clientX, y: e.clientY, scrollX: window.scrollX, scrollY: window.scrollY });
      }, 50);
    });

    window.addEventListener('scroll', () => {
      if (session?.mode === 'follow' && session?.isLeader) {
        send('scroll', { x: window.scrollX, y: window.scrollY });
      }
    }, { passive: true });
  }

  // ---- Navigation reporting ----

  function reportNav() {
    send('navigate', { url: window.location.href, title: document.title, scroll: { x: window.scrollX, y: window.scrollY } });
  }

  // ---- Text selection ----

  document.addEventListener('mouseup', () => {
    if (!session) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    postSidebar({ type: 'TEXT_SELECTED', text: sel.toString() });
  });

  // ---- Join URL detection (b.krl.kr/ROOMCODE) ----

  function detectJoinUrl() {
    const host = window.location.hostname;
    const isJoinHost = JOIN_HOSTS.some(h => host === h || host.endsWith('.' + h));
    if (!isJoinHost) return;

    const pathMatch = window.location.pathname.match(/^\/([A-Z0-9]{4,8})$/i);
    const qParam = new URLSearchParams(window.location.search).get('room');
    const code = (pathMatch?.[1] || qParam || '').toUpperCase();
    if (!code) return;

    // Signal to the page that the extension is present
    document.documentElement.setAttribute('data-sb-extension', 'true');

    // Listen for join event from the landing page's "Join" button
    document.addEventListener('sb:join', (e) => {
      const { roomId, name } = e.detail || {};
      if (roomId && name) joinSession(roomId, name, true);
    });

    // Check if already in a session
    chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (res) => {
      if (res?.session?.active) return;
      showJoinOverlay(code);
    });
  }

  function showJoinOverlay(code) {
    if (document.getElementById('sb-join-ov')) return;

    const ov = document.createElement('div');
    ov.id = 'sb-join-ov';
    ov.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:rgba(6,6,18,.93);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font-family:system-ui;`;
    ov.innerHTML = `
      <div style="background:#12122b;border:1px solid #2d2d44;border-radius:16px;padding:36px 40px;width:360px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.6);">
        <div style="width:54px;height:54px;margin:0 auto 18px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:14px;display:flex;align-items:center;justify-content:center;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="white" stroke-width="2"/>
            <circle cx="8.5" cy="10.5" r="2" fill="white"/>
            <circle cx="15.5" cy="10.5" r="2" fill="white"/>
            <path d="M8 15.5 Q12 18 16 15.5" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/>
          </svg>
        </div>
        <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Shared Browser</div>
        <h2 style="font-size:22px;font-weight:800;color:#fff;margin-bottom:6px">You're invited</h2>
        <p style="font-size:14px;color:#7879a1;margin-bottom:8px;line-height:1.6">Joining session</p>
        <div style="font-family:monospace;font-size:26px;font-weight:900;letter-spacing:5px;color:#a5b4fc;background:rgba(99,102,241,.12);padding:8px 18px;border-radius:8px;display:inline-block;border:1px solid rgba(99,102,241,.25);margin-bottom:24px">${code}</div>
        <input id="sb-jname" type="text" placeholder="Your name" maxlength="30"
          style="width:100%;padding:12px 14px;background:#0f0f1a;border:1.5px solid #2d2d44;border-radius:8px;color:#e2e8f0;font-size:15px;outline:none;margin-bottom:12px;box-sizing:border-box;font-family:inherit;text-align:center;"/>
        <button id="sb-jbtn" style="width:100%;padding:13px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:8px;color:white;font-size:15px;font-weight:700;cursor:pointer;">Join Session</button>
        <p id="sb-jerr" style="color:#f87171;font-size:12px;margin-top:8px;display:none"></p>
        <button id="sb-jcancel" style="background:none;border:none;color:#475569;font-size:13px;cursor:pointer;margin-top:10px;font-family:inherit;">Continue without joining</button>
      </div>
    `;

    document.body.appendChild(ov);

    const nameEl = document.getElementById('sb-jname');
    const btn = document.getElementById('sb-jbtn');
    const errEl = document.getElementById('sb-jerr');

    chrome.storage.local.get('userName', (d) => { if (d.userName) nameEl.value = d.userName; });
    nameEl.focus();
    nameEl.addEventListener('focus', () => nameEl.style.borderColor = '#6366f1');
    nameEl.addEventListener('blur', () => nameEl.style.borderColor = '#2d2d44');
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
    btn.addEventListener('click', doJoin);
    document.getElementById('sb-jcancel').addEventListener('click', () => ov.remove());

    function doJoin() {
      const name = nameEl.value.trim();
      if (!name) { nameEl.style.borderColor = '#ef4444'; nameEl.focus(); return; }
      btn.disabled = true;
      btn.textContent = 'Joining...';
      errEl.style.display = 'none';
      joinSession(code, name, false, (err) => {
        if (err) {
          btn.disabled = false;
          btn.textContent = 'Join Session';
          errEl.textContent = err;
          errEl.style.display = 'block';
        } else {
          ov.remove();
        }
      });
    }
  }

  function joinSession(code, name, redirectAfter, cb) {
    chrome.storage.local.set({ userName: name });

    const newSession = {
      active: true, roomId: code,
      user: { name, id: null },
      mode: 'follow', isLeader: false, members: [], pendingJoin: true,
    };

    chrome.runtime.sendMessage({ type: 'SESSION_JOINED', session: newSession }, () => {
      session = newSession;
      connect(() => {
        send('join', { roomId: code, name });
      });
      injectSidebar();
      trackMouse();
      if (redirectAfter) {
        // Brief pause so the join message is sent, then redirect
        setTimeout(() => { window.location.href = 'https://www.google.com'; }, 600);
      }
      if (cb) cb(null);
    });
  }

  // ---- Messages from sidebar iframe ----

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.source !== 'shared-browser-sidebar') return;
    const { type, data } = e.data;

    switch (type) {
      case 'SEND_CHAT':
        send('chat', { text: data.text });
        break;

      case 'ADD_HIGHLIGHT': {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) break;
        const r = sel.getRangeAt(0);
        const rd = serializeRange(r);
        if (!rd) break;
        send('annotation_add', { annotation: { type: 'highlight', url: location.href, range: rd, note: data.note, color: data.color } });
        sel.removeAllRanges();
        break;
      }

      case 'ADD_STICKY':
        send('annotation_add', { annotation: { type: 'sticky', url: location.href, x: data.x || 120, y: data.y || 120, text: data.text, color: data.color || '#fef08a' } });
        break;

      case 'REMOVE_ANNOTATION':
        send('annotation_remove', { id: data.id });
        break;

      case 'REACTION':
        send('reaction', { emoji: data.emoji, x: window.innerWidth / 2, y: window.innerHeight / 2 });
        break;

      case 'SPLIT':
        isSplit = true;
        send('split');
        break;

      case 'MERGE':
        isSplit = false;
        send('merge');
        break;

      case 'JUMP_TO_USER':
        send('jump_to', { userId: data.userId });
        break;

      case 'SET_MODE':
        send('set_mode', { mode: data.mode });
        break;

      case 'SET_LEADER':
        send('set_leader', { userId: data.userId });
        break;

      case 'NAVIGATE':
        if (data.url && data.url !== location.href) location.href = data.url;
        break;

      case 'LEAVE_SESSION':
        chrome.runtime.sendMessage({ type: 'SESSION_ENDED' });
        break;
    }
  });

  // ---- Messages from background ----

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'SESSION_STATE': {
        const wasActive = !!session?.active;
        session = msg.session;
        if (session.active && !wasActive) {
          connect(() => rejoin());
          injectSidebar();
          trackMouse();
        } else if (!session.active && wasActive) {
          removeSidebar();
          ws?.close(); ws = null;
        } else if (session.active) {
          postSidebar({ type: 'SESSION_UPDATED', session });
        }
        break;
      }
      case 'SESSION_ENDED':
        session = null;
        removeSidebar();
        ws?.close(); ws = null;
        break;

      case 'TAB_NAVIGATED':
        if (session?.active) {
          reportNav();
          document.querySelectorAll('.sb-ann').forEach(el => el.remove());
        }
        break;
    }
  });

  // ---- Init ----

  detectJoinUrl();

  chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (res) => {
    if (res?.session?.active) {
      session = res.session;
      connect(() => rejoin());
      injectSidebar();
      trackMouse();
      setTimeout(reportNav, 500);
    }
  });

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
