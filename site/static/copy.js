// Copy buttons for the install lines (no inline script: the CSP is script-src 'self').
document.addEventListener('click', (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest('button[data-copy]') : null;
  if (!btn || !navigator.clipboard) return;
  const label = btn.textContent;
  navigator.clipboard.writeText(btn.getAttribute('data-copy') || '').then(() => {
    btn.textContent = btn.getAttribute('data-copied') || label;
    setTimeout(() => { btn.textContent = label; }, 1600);
  }, () => {});
});
// A Pro button without a checkout link goes nowhere.
document.addEventListener('click', (ev) => {
  const a = ev.target instanceof Element ? ev.target.closest('a[aria-disabled="true"]') : null;
  if (a) ev.preventDefault();
});
