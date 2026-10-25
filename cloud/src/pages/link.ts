import { esc, page } from './layout';

export const linkPage = (o: { userCode: string; hostName: string; fingerprint: string }): Response =>
  page('Link this Mac', `<h1>Link this Mac to your account?</h1>
<p>Mac: <strong>${esc(o.hostName)}</strong></p>
<p>Key fingerprint: <code>${esc(o.fingerprint)}</code> — it should match the one AI msg shows on your Mac.</p>
<form id="link" data-code="${esc(o.userCode)}">
<button type="submit">Link this Mac</button>
</form>
<p id="result" role="status"></p>`, { scripts: ['/static/link.js'] });

export const linkMissingPage = (): Response =>
  page('Code not found', '<h1>This code is not valid</h1><p>It may have expired. Start linking again from AI msg on your Mac.</p>', { status: 404 });

/** `/static/link.js` — posts JSON (cookie routes take JSON only) with the page's own Origin. */
export const LINK_JS = `(() => {
  const form = document.getElementById('link');
  const out = document.getElementById('result');
  if (!form || !out) return;
  const msg = {
    granted: 'Linked. Your 7-day trial has started — go back to your Mac.',
    already_used: 'Linked. This email already used its trial; subscribe on the Account page to use the relay.',
    unavailable: 'Linked. A trial is not available right now; subscribe on the Account page to use the relay.',
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    if (button) button.disabled = true;
    try {
      const r = await fetch('/v1/host/link/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userCode: form.dataset.code }) });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { out.textContent = msg[body.trial] || 'Linked.'; form.hidden = true; }
      else { out.textContent = body.code === 'host_limit' ? 'This account already has the most Macs it can link.' : 'Linking failed (' + (body.code || r.status) + ').'; if (button) button.disabled = false; }
    } catch { out.textContent = 'Network error — try again.'; if (button) button.disabled = false; }
  });
})();
`;
