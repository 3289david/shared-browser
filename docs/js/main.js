// Scroll animations
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.1 }
);

document.querySelectorAll('.feature-card, .mode-card, .use-case, .pricing-card, .compare-card').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(24px)';
  el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  observer.observe(el);
});

// Nav scroll effect
window.addEventListener('scroll', () => {
  const nav = document.querySelector('.nav');
  if (window.scrollY > 60) {
    nav.style.padding = '10px 0';
    nav.style.background = 'rgba(6, 6, 18, 0.95)';
  } else {
    nav.style.padding = '14px 0';
    nav.style.background = 'rgba(6, 6, 18, 0.85)';
  }
});

// Copy invite link demo
document.querySelectorAll('.sb-room-id').forEach(el => {
  el.addEventListener('click', () => {
    const text = el.textContent;
    navigator.clipboard.writeText(`https://b.krl.kr/join/${text}`).catch(() => {});
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = text; }, 1500);
  });
});

// ---- Join URL handler ----
// Handles both b.krl.kr/AB123 (via 404.html redirect to ?room=AB123)
// and direct ?room=AB123 links

(function handleJoinUrl() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room')?.toUpperCase();
  if (!roomId || !/^[A-Z0-9]{4,8}$/.test(roomId)) return;

  // Update page title and meta
  document.title = `Join ${roomId} - Shared Browser`;
  window.history.replaceState({}, '', `/${roomId}`);

  const overlay = document.getElementById('join-overlay');
  const roomCodeEl = document.getElementById('join-room-code');
  const formSection = document.getElementById('join-form-section');
  const installSection = document.getElementById('join-install-section');
  const nameInput = document.getElementById('join-name-input');
  const actionBtn = document.getElementById('join-action-btn');
  const statusMsg = document.getElementById('join-status-msg');

  if (!overlay) return;

  roomCodeEl.textContent = roomId;
  overlay.style.display = 'flex';

  // Check if extension is installed by looking for the data attribute
  // the content script injects data-sb-extension="true" onto <html>
  const extensionInstalled = document.documentElement.getAttribute('data-sb-extension') === 'true';

  if (!extensionInstalled) {
    // Wait a moment for the content script to run
    setTimeout(() => {
      if (document.documentElement.getAttribute('data-sb-extension') !== 'true') {
        formSection.style.display = 'none';
        installSection.style.display = 'block';
      }
    }, 400);
  }

  // Extension is installed - handle the join button
  actionBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.style.borderColor = '#ef4444';
      nameInput.focus();
      return;
    }

    actionBtn.disabled = true;
    actionBtn.textContent = 'Joining...';

    // The extension content script listens for this custom event
    document.dispatchEvent(new CustomEvent('sb:join', {
      detail: { roomId, name },
      bubbles: true,
    }));

    // Show pending state - the extension will redirect once joined
    statusMsg.style.display = 'block';
    statusMsg.style.color = '#a5b4fc';
    statusMsg.textContent = 'Connecting...';

    // Fallback: if extension doesn't respond in 3s, show install prompt
    setTimeout(() => {
      if (actionBtn.disabled) {
        formSection.style.display = 'none';
        installSection.style.display = 'block';
        actionBtn.disabled = false;
      }
    }, 3000);
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') actionBtn.click();
  });

  // Pre-fill name from localStorage if available
  try {
    const saved = localStorage.getItem('sb_name');
    if (saved) nameInput.value = saved;
    nameInput.addEventListener('input', () => localStorage.setItem('sb_name', nameInput.value));
  } catch (_) {}

  nameInput.focus();
})();
