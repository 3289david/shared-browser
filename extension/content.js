// Content script — injected into every page.
// Thin layer: connects WS, relays messages to/from background and sidebar.
// All persistent state lives in background.js.

(function () {
  if (window.__sbLoaded) return;
  window.__sbLoaded = true;

  // ── Config ────────────────────────────────────────────────────────────────
  const WS_URL = 'wss://b.krl.kr/ws';
  function setHTML(el, html) { const b = new DOMParser().parseFromString(html, 'text/html').body; el.replaceChildren(...Array.from(b.childNodes)); }

  // ── State (ephemeral, per-page) ───────────────────────────────────────────
  let ws = null;
  let sessionState = null;  // mirrored from background
  let isSplit = false;
  let drawMode = false;
  let drawCanvas = null;
  let currentPath = [];
  let pingTimer = null;
  let reconnectTimer = null;
  let sidebarEl = null;
  let cursorOverlay = null;
  let cursorThrottle = null;
  let mouseTracking = false;

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function wsConnect(onOpen) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { startPing(); if (onOpen) onOpen(); };
    ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { stopPing(); scheduleReconnect(); };
    ws.onerror = () => ws.close();
  }

  function wsSend(type, data = {}) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
  }

  function startPing() { pingTimer = setInterval(() => wsSend('ping'), 25000); }
  function stopPing() { clearInterval(pingTimer); pingTimer = null; }

  function scheduleReconnect() {
    if (!sessionState?.active) return;
    reconnectTimer = setTimeout(() => wsConnect(rejoin), 3000);
  }

  function rejoin() {
    if (!sessionState) return;
    if (sessionState.pendingCreate) {
      wsSend('create', { name: sessionState.user.name, mode: sessionState.mode });
    } else {
      wsSend('join', { roomId: sessionState.roomId, name: sessionState.user.name });
    }
  }

  // ── Server message handler ────────────────────────────────────────────────
  function onMsg(msg) {
    switch (msg.type) {

      case 'created':
        chrome.runtime.sendMessage({
          type: 'SESSION_CONFIRMED',
          sessionUpdates: { roomId: msg.roomId, userId: msg.user.id, pendingCreate: false, leader: msg.user.id, isLeader: true },
          user: msg.user, room: msg.room,
        }, () => {
          sessionState = { ...sessionState, roomId: msg.roomId, userId: msg.user.id, isLeader: true };
          // Fetch fresh confirmed state and push directly — avoids broadcast race with iframe load
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
            if (res) toSidebar({ type: 'SESSION_CHANGED', state: res });
          });
        });
        setTimeout(() => wsSend('navigate', { url: location.href, title: document.title, scroll: {x:scrollX, y:scrollY} }), 200);
        break;

      case 'joined':
        chrome.runtime.sendMessage({
          type: 'SESSION_CONFIRMED',
          sessionUpdates: { roomId: msg.roomId, userId: msg.user.id, pendingJoin: false, isLeader: msg.room.leader === msg.user.id },
          user: msg.user, room: msg.room,
        }, () => {
          sessionState = { ...sessionState, roomId: msg.roomId, userId: msg.user.id };
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
            if (res) toSidebar({ type: 'SESSION_CHANGED', state: res });
          });
        });
        // Navigate to leader's page if in follow mode
        if (msg.room.mode === 'follow' && msg.room.state?.url && msg.room.state.url !== location.href) {
          location.href = msg.room.state.url;
        } else {
          setTimeout(() => wsSend('navigate', { url: location.href, title: document.title, scroll: {x:scrollX, y:scrollY} }), 200);
        }
        break;

      case 'navigate':
        if (!isSplit && msg.url && msg.url !== location.href) {
          location.href = msg.url;
        }
        break;

      case 'scroll':
        if (!isSplit && !sessionState?.isLeader) window.scrollTo(msg.x, msg.y);
        break;

      case 'cursor':
        renderCursor(msg);
        break;

      case 'chat':
        bg('PUSH_CHAT', { message: msg });
        break;

      case 'reaction':
        showReaction(msg);
        break;

      case 'annotation_added':
        bg('PUSH_ANNOTATION', { annotation: msg.annotation });
        renderAnnotation(msg.annotation);
        break;

      case 'annotation_removed':
        bg('REMOVE_ANNOTATION', { id: msg.id });
        document.querySelectorAll(`[data-ann="${msg.id}"]`).forEach(e => e.remove());
        break;

      case 'user_joined':
        bg('PUSH_MEMBER', { user: msg.user });
        break;

      case 'user_left':
        bg('REMOVE_MEMBER', { userId: msg.userId });
        removeCursor(msg.userId);
        break;

      case 'user_navigated':
        bg('UPDATE_MEMBER_URL', { userId: msg.userId, url: msg.url });
        bg('PUSH_HISTORY', { entry: { ...msg, timestamp: Date.now() } });
        break;

      case 'mode_changed':
        bg('UPDATE_SESSION', { updates: { mode: msg.mode } });
        toSidebar({ type: 'SERVER_MSG', msg });
        break;

      case 'leader_changed':
        bg('UPDATE_SESSION', { updates: {
          leader: msg.userId,
          isLeader: msg.userId === sessionState?.userId,
        }});
        toSidebar({ type: 'SERVER_MSG', msg });
        break;

      case 'user_split':
        bg('SPLIT_CHANGED', { userId: msg.userId, split: true });
        toSidebar({ type: 'SERVER_MSG', msg });
        break;

      case 'user_merged':
        bg('SPLIT_CHANGED', { userId: msg.userId, split: false });
        toSidebar({ type: 'SERVER_MSG', msg });
        break;

      case 'error':
        showToast(msg.message, '#ef4444');
        break;

      case 'pong': break;
    }
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────
  function injectSidebar() {
    if (document.getElementById('__sb_sidebar')) return;
    const wrap = document.createElement('div');
    wrap.id = '__sb_sidebar';
    wrap.style.cssText = 'position:fixed;top:0;right:0;width:300px;height:100vh;z-index:2147483647;pointer-events:none;';
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sidebar.html');
    iframe.style.cssText = 'width:100%;height:100%;border:none;pointer-events:all;box-shadow:-2px 0 20px rgba(0,0,0,.25);';
    // Push full state once the iframe has loaded so it never shows stale ------
    iframe.addEventListener('load', () => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
        if (res) toSidebar({ type: 'SESSION_CHANGED', state: res });
      });
    });
    wrap.appendChild(iframe);
    document.documentElement.appendChild(wrap);
    document.documentElement.style.marginRight = '300px';
    sidebarEl = iframe;
  }

  function removeSidebar() {
    document.getElementById('__sb_sidebar')?.remove();
    document.documentElement.style.marginRight = '';
    sidebarEl = null;
  }

  function toSidebar(msg) {
    sidebarEl?.contentWindow?.postMessage({ __sb: true, ...msg }, '*');
  }

  // ── Cursor overlay ────────────────────────────────────────────────────────
  function ensureCursorOverlay() {
    if (cursorOverlay) return;
    cursorOverlay = document.createElement('div');
    cursorOverlay.id = '__sb_cursors';
    cursorOverlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645;';
    document.documentElement.appendChild(cursorOverlay);
  }

  function renderCursor({ userId, name, color, x, y, scrollX: sx, scrollY: sy }) {
    ensureCursorOverlay();
    const ax = x + (sx - scrollX), ay = y + (sy - scrollY);
    let el = document.getElementById(`__sb_c_${userId}`);
    if (!el) {
      el = document.createElement('div');
      el.id = `__sb_c_${userId}`;
      el.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483644;transition:left .07s,top .07s;';
      setHTML(el, `<svg width="16" height="20" viewBox="0 0 16 20" fill="${color}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))"><path d="M0 0 L0 16 L4 12 L7 18 L9 17 L6 11 L11 11Z"/></svg><span style="background:${color};color:#fff;font:600 11px/1 system-ui;padding:2px 6px;border-radius:3px;white-space:nowrap;display:block;margin-top:1px;">${esc(name)}</span>`);
      cursorOverlay.appendChild(el);
    }
    el.style.left = ax + 'px';
    el.style.top = ay + 'px';
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { if (el) el.style.opacity = '0'; }, 5000);
  }

  function removeCursor(userId) {
    document.getElementById(`__sb_c_${userId}`)?.remove();
  }

  // ── Annotations ───────────────────────────────────────────────────────────
  function renderAnnotation(a) {
    if (a.url && a.url !== location.href) return;
    if (a.type === 'highlight') renderHighlight(a);
    else if (a.type === 'sticky') renderSticky(a);
    else if (a.type === 'drawing') renderDrawing(a);
  }

  function renderHighlight(a) {
    if (!a.range) return;
    try {
      const range = deserializeRange(a.range);
      if (!range) return;
      for (const rect of range.getClientRects()) {
        const el = document.createElement('div');
        el.dataset.ann = a.id;
        el.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:${a.color}55;border-bottom:2px solid ${a.color};pointer-events:auto;z-index:2147483640;cursor:pointer;`;
        el.title = `${a.userName}${a.note ? ': ' + a.note : ''}`;
        document.documentElement.appendChild(el);
      }
    } catch {}
  }

  function renderSticky(a) {
    if (document.querySelector(`[data-ann="${a.id}"]`)) return;
    const el = document.createElement('div');
    el.dataset.ann = a.id;
    el.style.cssText = `position:fixed;left:${a.x}px;top:${a.y}px;background:${a.color||'#fef08a'};color:#111;padding:8px 10px;border-radius:6px;font:13px/1.4 system-ui;max-width:180px;box-shadow:0 2px 8px rgba(0,0,0,.2);z-index:2147483641;cursor:move;user-select:none;word-break:break-word;min-width:80px;`;
    setHTML(el, `<div style="font-size:10px;font-weight:700;opacity:.6;margin-bottom:3px;">${esc(a.userName)}</div>${esc(a.text)}`);
    makeDraggable(el);
    document.documentElement.appendChild(el);
  }

  function renderDrawing(a) {
    if (!a.paths?.length) return;
    let canvas = document.querySelector(`[data-ann="${a.id}"]`);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.dataset.ann = a.id;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      canvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483639;';
      document.documentElement.appendChild(canvas);
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = a.color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const path of a.paths) {
      if (path.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.stroke();
    }
  }

  // ── Draw Mode ─────────────────────────────────────────────────────────────
  function enableDrawMode() {
    if (drawMode) return;
    drawMode = true;
    drawCanvas = document.createElement('canvas');
    drawCanvas.id = '__sb_drawcanvas';
    drawCanvas.width = window.innerWidth;
    drawCanvas.height = window.innerHeight;
    drawCanvas.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483643;cursor:crosshair;';
    document.documentElement.appendChild(drawCanvas);

    const ctx = drawCanvas.getContext('2d');
    let drawing = false;
    let paths = []; // current drawing paths

    drawCanvas.addEventListener('mousedown', e => {
      drawing = true;
      currentPath = [{ x: e.clientX, y: e.clientY }];
    });

    drawCanvas.addEventListener('mousemove', e => {
      if (!drawing) return;
      currentPath.push({ x: e.clientX, y: e.clientY });
      ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(currentPath[0].x, currentPath[0].y);
      for (let i = 1; i < currentPath.length; i++) ctx.lineTo(currentPath[i].x, currentPath[i].y);
      ctx.stroke();
    });

    drawCanvas.addEventListener('mouseup', () => {
      if (!drawing || currentPath.length < 2) return;
      drawing = false;
      paths.push([...currentPath]);
      currentPath = [];
      // Send to server
      wsSend('annotation_add', { annotation: {
        type: 'drawing', url: location.href,
        paths, color: '#ef4444',
      }});
      paths = [];
      ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    });
  }

  function disableDrawMode() {
    drawMode = false;
    document.getElementById('__sb_drawcanvas')?.remove();
    drawCanvas = null;
  }

  // ── Range serialization ───────────────────────────────────────────────────
  function serializeRange(range) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, off = 0, sOff = null, eOff = null;
    while ((n = w.nextNode())) {
      if (n === range.startContainer) sOff = off + range.startOffset;
      if (n === range.endContainer) { eOff = off + range.endOffset; break; }
      off += n.textContent.length;
    }
    return sOff !== null && eOff !== null ? { s: sOff, e: eOff } : null;
  }

  function deserializeRange(d) {
    const range = document.createRange();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, off = 0, sN, sO, eN, eO;
    while ((n = w.nextNode())) {
      const len = n.textContent.length;
      if (sN === undefined && off + len >= d.s) { sN = n; sO = d.s - off; }
      if (eN === undefined && off + len >= d.e) { eN = n; eO = d.e - off; break; }
      off += len;
    }
    if (!sN || !eN) return null;
    range.setStart(sN, sO);
    range.setEnd(eN, eO);
    return range;
  }

  // ── Sticky drag ───────────────────────────────────────────────────────────
  function makeDraggable(el) {
    let ox = 0, oy = 0;
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      ox = e.clientX - el.getBoundingClientRect().left;
      oy = e.clientY - el.getBoundingClientRect().top;
      const move = e2 => {
        el.style.left = (e2.clientX - ox) + 'px';
        el.style.top = (e2.clientY - oy) + 'px';
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', () => document.removeEventListener('mousemove', move), { once: true });
    });
  }

  // ── Reactions ─────────────────────────────────────────────────────────────
  function showReaction({ emoji, x, y }) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:${x||innerWidth/2}px;top:${y||innerHeight/2}px;font-size:32px;pointer-events:none;z-index:2147483647;animation:__sb_float 2s ease-out forwards;`;
    el.textContent = emoji;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 2100);
  }

  function showToast(text, color = '#6366f1') {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:16px;right:316px;background:#1a1a2e;color:#fff;padding:10px 16px;border-radius:8px;font:13px system-ui;border-left:3px solid ${color};z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.3);animation:__sb_slide .25s ease;`;
    el.textContent = text;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── Inject CSS for animations ─────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes __sb_float { 0%{transform:translateY(0) scale(1);opacity:1} 100%{transform:translateY(-80px) scale(1.4);opacity:0} }
    @keyframes __sb_slide { from{opacity:0;transform:translateX(12px)} to{opacity:1;transform:none} }
  `;
  document.head?.appendChild(style);

  // ── Mouse tracking ────────────────────────────────────────────────────────
  function trackMouse() {
    if (mouseTracking) return;
    mouseTracking = true;
    document.addEventListener('mousemove', e => {
      if (!sessionState?.active || cursorThrottle) return;
      cursorThrottle = setTimeout(() => {
        cursorThrottle = null;
        wsSend('cursor', { x: e.clientX, y: e.clientY, scrollX, scrollY });
      }, 50);
    });
    window.addEventListener('scroll', () => {
      if (sessionState?.mode === 'follow' && sessionState?.isLeader) {
        wsSend('scroll', { x: scrollX, y: scrollY });
      }
    }, { passive: true });
  }

  // ── Messages from sidebar (postMessage) ──────────────────────────────────
  window.addEventListener('message', e => {
    if (!e.data?.__sbSidebar) return;
    const { type, data } = e.data;
    switch (type) {

      case 'SEND_CHAT':
        wsSend('chat', { text: data.text });
        break;

      case 'REACTION':
        wsSend('reaction', { emoji: data.emoji, x: innerWidth/2, y: innerHeight/2 });
        break;

      case 'HIGHLIGHT': {
        const sel = getSelection();
        if (!sel || sel.isCollapsed) { showToast('Select text first'); break; }
        const range = sel.getRangeAt(0);
        const rd = serializeRange(range);
        if (!rd) break;
        wsSend('annotation_add', { annotation: {
          type: 'highlight', url: location.href,
          range: rd, note: data.note || '', color: data.color || '#facc15',
        }});
        sel.removeAllRanges();
        break;
      }

      case 'STICKY': {
        wsSend('annotation_add', { annotation: {
          type: 'sticky', url: location.href,
          x: data.x || 120, y: data.y || 120,
          text: data.text, color: data.color || '#fef08a',
        }});
        break;
      }

      case 'DRAW_ON':
        enableDrawMode();
        break;

      case 'DRAW_OFF':
        disableDrawMode();
        break;

      case 'REMOVE_ANN':
        wsSend('annotation_remove', { id: data.id });
        break;

      case 'SET_MODE':
        wsSend('set_mode', { mode: data.mode });
        break;

      case 'SET_LEADER':
        wsSend('set_leader', { userId: data.userId });
        break;

      case 'SPLIT':
        isSplit = true;
        wsSend('split');
        break;

      case 'MERGE':
        isSplit = false;
        wsSend('merge');
        break;

      case 'JUMP_TO':
        wsSend('jump_to', { userId: data.userId });
        break;

      case 'NAVIGATE':
        if (data.url && data.url !== location.href) location.href = data.url;
        break;

      case 'LEAVE':
        chrome.runtime.sendMessage({ type: 'SESSION_END' });
        break;
    }
  });

  // ── Messages from background (broadcasted to all tabs) ────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {

      // Triggered by popup when starting a new session from the extension icon
      case 'SB_CREATE':
        sessionState = { active: true, user: { name: msg.name }, mode: msg.mode, isLeader: true, pendingCreate: true, userId: null };
        wsConnect(() => { wsSend('create', { name: msg.name, mode: msg.mode }); });
        injectSidebar();
        trackMouse();
        waitForRoomId();
        reply?.({ ok: true });
        break;

      case 'SB_JOIN':
        initiateJoin(msg.roomId, msg.name);
        reply?.({ ok: true });
        break;

      case 'SESSION_CHANGED':
        sessionState = msg.state.session;
        toSidebar({ type: 'SESSION_CHANGED', state: msg.state });
        break;
      case 'SESSION_ENDED':
        sessionState = null;
        removeSidebar();
        ws?.close(); ws = null;
        disableDrawMode();
        break;
      case 'CHAT_MSG':
        // Sidebar reads chat directly from background on nav, but forward for live updates
        toSidebar({ type: 'LIVE_CHAT', message: msg.message });
        break;
      case 'MEMBERS_CHANGED':
        toSidebar({ type: 'LIVE_MEMBERS', members: msg.members });
        break;
      case 'ANNOTATION_ADDED':
        renderAnnotation(msg.annotation);
        toSidebar({ type: 'ANNOTATION_ADDED', annotation: msg.annotation });
        break;
      case 'ANNOTATION_REMOVED':
        document.querySelectorAll(`[data-ann="${msg.id}"]`).forEach(e => e.remove());
        toSidebar({ type: 'ANNOTATION_REMOVED', id: msg.id });
        break;
      case 'HISTORY_CHANGED':
        toSidebar({ type: 'LIVE_HISTORY', history: msg.history });
        break;
    }
  });

  // ── Join URL detection (b.krl.kr/ROOMCODE) ───────────────────────────────
  function detectJoinUrl() {
    const host = location.hostname;
    if (host !== 'b.krl.kr' && host !== 'localhost') return;
    const match = location.pathname.match(/^\/([A-Z0-9]{4,8})$/i);
    const qRoom = new URLSearchParams(location.search).get('room');
    const code = (match?.[1] || qRoom || '').toUpperCase();
    if (!code) return;

    document.documentElement.setAttribute('data-sb-ext', 'true');
    document.addEventListener('sb:join', e => {
      const { roomId, name } = e.detail || {};
      if (roomId && name) initiateJoin(roomId, name);
    });

    chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
      if (res?.session?.active) return;
      showJoinOverlay(code);
    });
  }

  function showJoinOverlay(code) {
    if (document.getElementById('__sb_joinov')) return;
    const ov = document.createElement('div');
    ov.id = '__sb_joinov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(6,6,18,.93);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font-family:system-ui;';
    setHTML(ov, `<div style="background:#12122b;border:1px solid #2d2d44;border-radius:16px;padding:36px 40px;width:340px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.6);">
        <div style="width:52px;height:52px;margin:0 auto 16px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:13px;display:flex;align-items:center;justify-content:center;">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="white" stroke-width="2"/><circle cx="8.5" cy="10.5" r="2" fill="white"/><circle cx="15.5" cy="10.5" r="2" fill="white"/><path d="M8 15.5 Q12 18 16 15.5" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </div>
        <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Shared Browser</div>
        <h2 style="font-size:21px;font-weight:800;color:#fff;margin-bottom:6px">You're invited</h2>
        <div style="font-family:monospace;font-size:24px;font-weight:900;letter-spacing:5px;color:#a5b4fc;background:rgba(99,102,241,.12);padding:8px 18px;border-radius:8px;display:inline-block;border:1px solid rgba(99,102,241,.25);margin-bottom:20px">${esc(code)}</div><br>
        <input id="__sb_jname" type="text" placeholder="Your name" maxlength="30"
          style="width:100%;padding:11px 14px;background:#0f0f1a;border:1.5px solid #2d2d44;border-radius:8px;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:10px;box-sizing:border-box;text-align:center;"/>
        <button id="__sb_jbtn" style="width:100%;padding:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:8px;color:white;font-size:14px;font-weight:700;cursor:pointer;">Join Session</button>
        <p id="__sb_jerr" style="color:#f87171;font-size:12px;margin-top:8px;display:none"></p>
        <button id="__sb_jdismiss" style="background:none;border:none;color:#475569;font-size:12px;cursor:pointer;margin-top:10px;">Dismiss</button>
      </div>`);
    document.documentElement.appendChild(ov);
    const ni = document.getElementById('__sb_jname');
    const btn = document.getElementById('__sb_jbtn');
    const err = document.getElementById('__sb_jerr');
    document.getElementById('__sb_jdismiss').addEventListener('click', () => ov.remove());
    chrome.storage.local.get('sbName', d => { if (d.sbName) ni.value = d.sbName; });
    ni.focus();
    ni.addEventListener('focus', () => ni.style.borderColor = '#6366f1');
    ni.addEventListener('blur', () => ni.style.borderColor = '#2d2d44');
    ni.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    btn.addEventListener('click', go);
    function go() {
      const name = ni.value.trim();
      if (!name) { ni.style.borderColor='#ef4444'; return; }
      btn.disabled = true; btn.textContent = 'Joining...'; err.style.display='none';
      initiateJoin(code, name, () => {
        ov.remove();
      });
    }
  }

  function initiateJoin(roomId, name, cb) {
    chrome.storage.local.set({ sbName: name });
    chrome.runtime.sendMessage({
      type: 'SESSION_START',
      session: { active: true, roomId, user: { name }, mode: 'follow', isLeader: false, pendingJoin: true, userId: null },
    }, () => {
      sessionState = { active: true, roomId, user: { name }, mode: 'follow', isLeader: false, pendingJoin: true };
      wsConnect(() => { wsSend('join', { roomId, name }); });
      injectSidebar();
      trackMouse();
      waitForRoomId();
      if (cb) cb();
    });
  }

  // Poll every 200ms until roomId arrives, then keep pushing for 1s to
  // guarantee the sidebar receives it even if earlier messages were dropped.
  function waitForRoomId() {
    let found = false;
    const t = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
        if (!res?.session?.roomId) return;
        toSidebar({ type: 'SESSION_CHANGED', state: res });
        if (!found) { found = true; setTimeout(() => clearInterval(t), 1000); }
      });
    }, 200);
    setTimeout(() => clearInterval(t), 20000);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  detectJoinUrl();

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
    if (!res?.session?.active) return;
    sessionState = res.session;
    isSplit = res.splitUsers?.includes(sessionState.userId);

    // Re-render persisted annotations for this page
    (res.annotations || []).forEach(a => renderAnnotation(a));

    injectSidebar();
    trackMouse();
    wsConnect(rejoin);

    // Report current URL after reconnect
    setTimeout(() => wsSend('navigate', {
      url: location.href, title: document.title,
      scroll: { x: scrollX, y: scrollY },
    }), 500);
  });

  // ── Utils ─────────────────────────────────────────────────────────────────
  function bg(type, data = {}) {
    try { chrome.runtime.sendMessage({ type, ...data }, () => void chrome.runtime.lastError); } catch {}
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

})();
