// Content script - injected into every page
// Handles: cursor overlay, annotations, sidebar injection, socket relay

(function () {
  if (window.__sharedBrowserInjected) return;
  window.__sharedBrowserInjected = true;

  const SERVER_WS = 'wss://api.b.krl.kr';
  let socket = null;
  let session = null;
  let cursors = {};
  let annotations = [];
  let isSplit = false;
  let cursorThrottle = null;
  let sidebarFrame = null;
  let overlay = null;

  // ---- WebSocket Connection ----

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    // Socket.io handshake
    const wsUrl = SERVER_WS.replace('wss://', 'https://').replace('ws://', 'http://');

    // Use socket.io-client loaded via importScripts equivalent
    // We implement a minimal socket.io v4 client
    const sid = encodeURIComponent(Math.random().toString(36).slice(2));
    const pollUrl = `${wsUrl}/socket.io/?EIO=4&transport=websocket`;

    try {
      socket = new WebSocket(pollUrl.replace('https://', 'wss://').replace('http://', 'ws://'));

      socket.onopen = () => {
        console.log('[SharedBrowser] Connected to server');
        if (session) rejoinSession();
      };

      socket.onmessage = (event) => {
        handleSocketMessage(event.data);
      };

      socket.onclose = () => {
        console.log('[SharedBrowser] Disconnected, reconnecting...');
        setTimeout(connect, 3000);
      };

      socket.onerror = () => {
        socket.close();
      };
    } catch (e) {
      setTimeout(connect, 5000);
    }
  }

  // Socket.io v4 protocol implementation
  let socketId = null;
  let pingInterval = null;

  function handleSocketMessage(data) {
    if (data === '2') { // ping
      if (socket.readyState === WebSocket.OPEN) socket.send('3'); // pong
      return;
    }

    const type = data.charAt(0);

    if (type === '0') { // open
      const payload = JSON.parse(data.slice(1));
      socketId = payload.sid;
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('2');
      }, payload.pingInterval || 25000);
      socket.send('40'); // connect to namespace
      return;
    }

    if (type === '4') { // message
      const msgType = data.charAt(1);
      if (msgType === '0') { // connected to namespace
        if (session) rejoinSession();
      } else if (msgType === '2') { // event
        try {
          const payload = JSON.parse(data.slice(2));
          const [event, ...args] = payload;
          handleEvent(event, args[0], args[1]);
        } catch (e) {}
      }
    }
  }

  function emit(event, data, callback) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const id = callback ? Math.floor(Math.random() * 100000) : null;
    const packet = id
      ? `42${id}["${event}",${JSON.stringify(data)}]`
      : `42["${event}",${JSON.stringify(data)}]`;
    socket.send(packet);

    if (callback) {
      const handler = (msg) => {
        if (msg.data && msg.data.startsWith(`43${id}`)) {
          socket.removeEventListener('message', handler);
          try {
            callback(JSON.parse(msg.data.slice(`43${id}`.length)));
          } catch (e) {}
        }
      };
      socket.addEventListener('message', handler);
    }
  }

  function rejoinSession() {
    if (!session) return;
    emit('join_session', { roomId: session.roomId, name: session.user.name }, (res) => {
      if (res.success) {
        updateAnnotations(res.room.annotations || []);
        sendTelemetry();
      }
    });
  }

  // ---- Event Handlers ----

  function handleEvent(event, data) {
    switch (event) {
      case 'leader_navigated':
      case 'group_navigated':
        if (!isSplit && data.url && data.url !== window.location.href) {
          window.location.href = data.url;
        }
        break;

      case 'scroll_sync':
        if (!isSplit && session?.mode === 'follow' && !session?.isLeader) {
          window.scrollTo(data.x, data.y);
        }
        break;

      case 'cursor_update':
        updateRemoteCursor(data);
        break;

      case 'annotation_added':
        annotations.push(data);
        renderAnnotation(data);
        break;

      case 'annotation_removed':
        annotations = annotations.filter(a => a.id !== data.id);
        removeAnnotationEl(data.id);
        break;

      case 'chat_message':
        postToSidebar({ type: 'CHAT_MESSAGE', message: data });
        showChatNotification(data);
        break;

      case 'reaction':
        showReaction(data);
        break;

      case 'user_joined':
      case 'user_left':
      case 'user_navigated':
      case 'mode_changed':
      case 'leader_changed':
      case 'permission_changed':
      case 'user_split':
      case 'user_merged':
        postToSidebar({ type: 'SERVER_EVENT', event, data });
        break;

      case 'merge_state':
        if (data.url && data.url !== window.location.href) {
          window.location.href = data.url;
        }
        break;

      case 'jump':
        if (data.url && data.url !== window.location.href) {
          window.location.href = data.url;
        }
        break;
    }
  }

  // ---- Sidebar ----

  function injectSidebar() {
    if (sidebarFrame) return;

    const container = document.createElement('div');
    container.id = 'sb-sidebar-container';
    container.style.cssText = `
      position: fixed; top: 0; right: 0; width: 320px; height: 100vh;
      z-index: 2147483647; pointer-events: none; font-family: system-ui;
    `;

    sidebarFrame = document.createElement('iframe');
    sidebarFrame.src = chrome.runtime.getURL('sidebar.html');
    sidebarFrame.style.cssText = `
      width: 100%; height: 100%; border: none; pointer-events: all;
      box-shadow: -4px 0 24px rgba(0,0,0,0.15);
    `;
    sidebarFrame.allow = 'microphone';

    container.appendChild(sidebarFrame);
    document.body.appendChild(container);

    sidebarFrame.onload = () => {
      setTimeout(() => {
        postToSidebar({ type: 'INIT', session, annotations });
      }, 100);
    };

    // Adjust page content
    document.body.style.transition = 'margin-right 0.3s ease';
    document.body.style.marginRight = '320px';
  }

  function removeSidebar() {
    const container = document.getElementById('sb-sidebar-container');
    if (container) container.remove();
    sidebarFrame = null;
    document.body.style.marginRight = '';
  }

  function postToSidebar(message) {
    if (sidebarFrame?.contentWindow) {
      try {
        sidebarFrame.contentWindow.postMessage({ source: 'shared-browser', ...message }, '*');
      } catch (e) {}
    }
  }

  // ---- Cursor Overlay ----

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'sb-cursor-overlay';
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483646;';
    document.body.appendChild(overlay);
  }

  function updateRemoteCursor({ userId, name, color, x, y, scrollX, scrollY }) {
    if (!overlay) ensureOverlay();

    const adjustedX = x + (scrollX - window.scrollX);
    const adjustedY = y + (scrollY - window.scrollY);

    let cursorEl = document.getElementById(`sb-cursor-${userId}`);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.id = `sb-cursor-${userId}`;
      cursorEl.innerHTML = `
        <div class="sb-cursor-pointer" style="color:${color}">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="${color}">
            <path d="M4 2L16 9.5L10.5 11L8 16L4 2Z"/>
          </svg>
        </div>
        <div class="sb-cursor-label" style="background:${color}">${escapeHtml(name)}</div>
      `;
      cursorEl.style.cssText = `position: fixed; pointer-events: none; transition: left 0.05s, top 0.05s; z-index: 2147483645; display: flex; flex-direction: column; align-items: flex-start;`;
      overlay.appendChild(cursorEl);
      cursors[userId] = cursorEl;
    }

    cursorEl.style.left = `${adjustedX}px`;
    cursorEl.style.top = `${adjustedY}px`;

    clearTimeout(cursorEl._hideTimer);
    cursorEl._hideTimer = setTimeout(() => {
      if (cursorEl) cursorEl.style.opacity = '0';
    }, 5000);
    cursorEl.style.opacity = '1';
  }

  function removeRemoteCursor(userId) {
    const el = document.getElementById(`sb-cursor-${userId}`);
    if (el) el.remove();
    delete cursors[userId];
  }

  // ---- Annotations ----

  function updateAnnotations(newAnnotations) {
    annotations = newAnnotations;
    document.querySelectorAll('.sb-annotation').forEach(el => el.remove());
    annotations.forEach(a => renderAnnotation(a));
  }

  function renderAnnotation(annotation) {
    if (annotation.url && annotation.url !== window.location.href) return;

    switch (annotation.type) {
      case 'highlight':
        renderHighlight(annotation);
        break;
      case 'sticky':
        renderSticky(annotation);
        break;
      case 'drawing':
        renderDrawing(annotation);
        break;
    }
  }

  function renderHighlight(a) {
    if (!a.range) return;
    try {
      const range = deserializeRange(a.range);
      if (!range) return;
      const rects = range.getClientRects();
      for (const rect of rects) {
        const el = document.createElement('div');
        el.className = 'sb-annotation sb-highlight';
        el.dataset.id = a.id;
        el.style.cssText = `
          position: fixed; left: ${rect.left + window.scrollX}px; top: ${rect.top + window.scrollY}px;
          width: ${rect.width}px; height: ${rect.height}px;
          background: ${a.color}40; border-bottom: 2px solid ${a.color};
          pointer-events: auto; cursor: pointer; z-index: 2147483640;
        `;
        el.title = `${a.userName}: ${a.note || ''}`;
        document.body.appendChild(el);
      }
    } catch (e) {}
  }

  function renderSticky(a) {
    const el = document.createElement('div');
    el.className = 'sb-annotation sb-sticky';
    el.dataset.id = a.id;
    el.style.cssText = `
      position: fixed; left: ${a.x}px; top: ${a.y}px;
      background: ${a.color}; color: #000; padding: 8px 12px;
      border-radius: 4px; font-size: 13px; max-width: 200px;
      box-shadow: 2px 2px 8px rgba(0,0,0,0.2); z-index: 2147483641;
      pointer-events: auto; cursor: move; user-select: none;
      word-wrap: break-word;
    `;
    el.innerHTML = `
      <div style="font-weight:600;font-size:11px;margin-bottom:4px;opacity:0.7">${escapeHtml(a.userName)}</div>
      <div>${escapeHtml(a.text)}</div>
    `;
    document.body.appendChild(el);
  }

  function renderDrawing(a) {
    if (!a.paths || !a.paths.length) return;
    const el = document.createElement('canvas');
    el.className = 'sb-annotation sb-drawing';
    el.dataset.id = a.id;
    el.width = window.innerWidth;
    el.height = window.innerHeight;
    el.style.cssText = 'position: fixed; top: 0; left: 0; pointer-events: none; z-index: 2147483639;';
    document.body.appendChild(el);

    const ctx = el.getContext('2d');
    ctx.strokeStyle = a.color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    for (const path of a.paths) {
      if (path.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.stroke();
    }
  }

  function removeAnnotationEl(id) {
    document.querySelectorAll(`[data-id="${id}"]`).forEach(el => el.remove());
  }

  // Simple range serialization (text offset based)
  function deserializeRange(data) {
    try {
      const range = document.createRange();
      const start = findTextNode(document.body, data.startOffset);
      const end = findTextNode(document.body, data.endOffset);
      if (!start || !end) return null;
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    } catch (e) {
      return null;
    }
  }

  function findTextNode(root, targetOffset) {
    let current = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (current + len >= targetOffset) {
        return { node, offset: targetOffset - current };
      }
      current += len;
    }
    return null;
  }

  function serializeRange(range) {
    let startOffset = 0, endOffset = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node, found = false;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) {
        startOffset += range.startOffset;
        found = true;
      } else if (!found) {
        startOffset += node.textContent.length;
      }
    }
    const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let offset = 0, found2 = false;
    while ((node = walker2.nextNode())) {
      if (node === range.endContainer) {
        endOffset = offset + range.endOffset;
        found2 = true;
        break;
      }
      offset += node.textContent.length;
    }
    return found && found2 ? { startOffset, endOffset } : null;
  }

  // ---- Reactions ----

  function showReaction({ emoji, x, y, color }) {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px;
      font-size: 28px; pointer-events: none; z-index: 2147483647;
      animation: sb-float 2s ease-out forwards;
    `;
    el.textContent = emoji;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2100);
  }

  // ---- Chat Notification ----

  function showChatNotification(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 80px; right: 340px;
      background: #1e1e2e; color: #fff; padding: 10px 14px;
      border-radius: 8px; font-size: 13px; font-family: system-ui;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 2147483647;
      border-left: 3px solid ${message.color};
      max-width: 240px; animation: sb-slide-in 0.3s ease;
    `;
    toast.innerHTML = `
      <div style="font-weight:600;color:${message.color};margin-bottom:2px">${escapeHtml(message.userName)}</div>
      <div style="opacity:0.9">${escapeHtml(message.text.slice(0, 80))}</div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ---- Telemetry (URL + scroll) ----

  function sendTelemetry() {
    if (!session || !socket || socket.readyState !== WebSocket.OPEN) return;
    emit('navigate', {
      url: window.location.href,
      title: document.title,
      scroll: { x: window.scrollX, y: window.scrollY },
    });
  }

  // ---- Mouse tracking ----

  function trackCursor() {
    document.addEventListener('mousemove', (e) => {
      if (!session || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (cursorThrottle) return;
      cursorThrottle = setTimeout(() => {
        cursorThrottle = null;
        emit('cursor_move', {
          x: e.clientX,
          y: e.clientY,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        });
      }, 50);
    });

    window.addEventListener('scroll', () => {
      if (!session || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (session.mode === 'follow' && session.isLeader) {
        emit('scroll', { x: window.scrollX, y: window.scrollY });
      }
    });
  }

  // ---- Text selection for highlighting ----

  document.addEventListener('mouseup', () => {
    if (!session) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    postToSidebar({ type: 'TEXT_SELECTED', text: selection.toString() });
  });

  // ---- Messages from sidebar ----

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'shared-browser-sidebar') return;
    const { type, data } = event.data;

    switch (type) {
      case 'SEND_CHAT':
        emit('chat_message', { text: data.text });
        break;

      case 'ADD_HIGHLIGHT': {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) break;
        const range = sel.getRangeAt(0);
        const rangeData = serializeRange(range);
        if (!rangeData) break;
        emit('add_annotation', {
          type: 'highlight',
          url: window.location.href,
          range: rangeData,
          note: data.note,
          color: data.color,
        });
        sel.removeAllRanges();
        break;
      }

      case 'ADD_STICKY':
        emit('add_annotation', {
          type: 'sticky',
          url: window.location.href,
          x: data.x,
          y: data.y,
          text: data.text,
          color: data.color,
        });
        break;

      case 'REMOVE_ANNOTATION':
        emit('remove_annotation', { id: data.id });
        break;

      case 'REACTION':
        emit('reaction', { emoji: data.emoji, x: window.innerWidth / 2, y: window.innerHeight / 2 });
        break;

      case 'SPLIT':
        isSplit = true;
        emit('split');
        break;

      case 'MERGE':
        isSplit = false;
        emit('merge');
        break;

      case 'JUMP_TO_USER':
        emit('jump_to_user', { userId: data.userId });
        break;

      case 'SET_MODE':
        emit('set_mode', { mode: data.mode });
        break;

      case 'SET_LEADER':
        emit('set_leader', { userId: data.userId });
        break;

      case 'NAVIGATE':
        if (data.url && data.url !== window.location.href) {
          window.location.href = data.url;
        }
        break;

      case 'LEAVE_SESSION':
        chrome.runtime.sendMessage({ type: 'SESSION_ENDED' });
        break;
    }
  });

  // ---- Messages from background ----

  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'SESSION_STATE':
        const wasActive = !!session;
        session = message.session;
        if (session.active && !wasActive) {
          connect();
          injectSidebar();
          trackCursor();
        } else if (!session.active && wasActive) {
          removeSidebar();
          if (socket) { socket.close(); socket = null; }
        } else if (session.active) {
          postToSidebar({ type: 'SESSION_UPDATED', session });
        }
        break;

      case 'SESSION_ENDED':
        session = null;
        removeSidebar();
        if (socket) { socket.close(); socket = null; }
        break;

      case 'TAB_NAVIGATED':
        sendTelemetry();
        // Re-render annotations for new page
        document.querySelectorAll('.sb-annotation').forEach(el => el.remove());
        annotations.forEach(a => renderAnnotation(a));
        break;
    }
  });

  // ---- Init ----

  chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (res) => {
    if (res?.session?.active) {
      session = res.session;
      connect();
      injectSidebar();
      trackCursor();
      setTimeout(sendTelemetry, 500);
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
