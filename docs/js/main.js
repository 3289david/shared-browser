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

// Session join from URL (for landing page join flow)
const path = window.location.pathname;
const joinMatch = path.match(/\/join\/([A-Z0-9]{4,8})/);
if (joinMatch) {
  const code = joinMatch[1];
  const banner = document.createElement('div');
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white; padding: 16px; text-align: center;
    font-family: system-ui; font-size: 15px; font-weight: 600;
    box-shadow: 0 4px 20px rgba(99,102,241,0.4);
  `;
  banner.innerHTML = `
    You were invited to join session <strong>${code}</strong>.
    Install the extension and enter this code to join.
    <button onclick="navigator.clipboard.writeText('${code}');this.textContent='Copied!'" style="
      margin-left: 12px; padding: 6px 14px; background: rgba(255,255,255,0.2);
      border: 1px solid rgba(255,255,255,0.4); border-radius: 6px; color: white;
      font-size: 13px; cursor: pointer; font-weight: 600;
    ">Copy Code</button>
    <button onclick="this.parentElement.remove()" style="
      position: absolute; right: 16px; top: 50%; transform: translateY(-50%);
      background: none; border: none; color: rgba(255,255,255,0.7); cursor: pointer; font-size: 18px;
    ">x</button>
  `;
  document.body.prepend(banner);
}
