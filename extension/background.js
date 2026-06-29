// Service worker - coordinates tab events and session state
const SERVER_URL = 'wss://api.b.krl.kr';
const SERVER_HTTP = 'https://api.b.krl.kr';

let sessionState = {
  active: false,
  roomId: null,
  user: null,
  mode: 'follow',
  isLeader: false,
  members: [],
};

// Keep service worker alive during active session
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.storage.session.get('session', () => {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Notify all content scripts in active tabs about session state
async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (_) {}
  }
}

// Tab navigation tracking for Follow/Group mode
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!sessionState.active) return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

  const activeTab = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab[0] || activeTab[0].id !== tabId) return;

  // Notify content script to report navigation
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'TAB_NAVIGATED',
      url: tab.url,
      title: tab.title,
    });
  } catch (_) {}
});

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_SESSION':
      sendResponse({ session: sessionState });
      break;

    case 'SESSION_CREATED':
    case 'SESSION_JOINED':
      sessionState = { ...sessionState, ...message.session, active: true };
      chrome.storage.session.set({ session: sessionState });
      startKeepAlive();
      broadcastToTabs({ type: 'SESSION_STATE', session: sessionState });
      sendResponse({ ok: true });
      break;

    case 'SESSION_ENDED':
      sessionState = { active: false, roomId: null, user: null, mode: 'follow', isLeader: false, members: [] };
      chrome.storage.session.remove('session');
      stopKeepAlive();
      broadcastToTabs({ type: 'SESSION_ENDED' });
      sendResponse({ ok: true });
      break;

    case 'UPDATE_SESSION':
      sessionState = { ...sessionState, ...message.updates };
      chrome.storage.session.set({ session: sessionState });
      broadcastToTabs({ type: 'SESSION_STATE', session: sessionState });
      sendResponse({ ok: true });
      break;

    case 'NAVIGATE_TO':
      chrome.tabs.update(sender.tab?.id ?? undefined, { url: message.url });
      sendResponse({ ok: true });
      break;

    case 'OPEN_SIDEBAR':
      chrome.sidePanel.open({ windowId: sender.tab?.windowId });
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }
  return true;
});

// Restore session on service worker restart
chrome.runtime.onStartup.addListener(async () => {
  const data = await chrome.storage.session.get('session');
  if (data.session?.active) {
    sessionState = data.session;
    startKeepAlive();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});
