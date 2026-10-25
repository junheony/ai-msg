import { cookieRoute } from '../auth/session';
import { PLANS, checkoutBlock, isPlan } from '../billing';
import { redirect } from '../http';
import { PADDLE_JS_URL, checkoutCsp } from '../origins';
import { PRO_LINE, esc, page } from './layout';

const PLAN_LABEL = { 'pro-monthly': 'monthly', 'pro-yearly': 'yearly' } as const;

/**
 * `GET /checkout?plan=pro-monthly|pro-yearly` — the fixed address the landing's buttons point at. Not signed in →
 * `/login?next=…`; a live subscription → `/account`; a finished checkout still confirming → `/account?pending=1`.
 * Otherwise a page that opens the Paddle.js overlay. Values ride in `data-*`; the signed user ref is not in the page —
 * checkout.js gets it from `POST /v1/billing/intent`, after the intent row is written.
 */
export const checkoutGet = cookieRoute({ session: 'page' }, async (c) => {
  const plan = c.url.searchParams.get('plan');
  if (!isPlan(plan)) return page('Unknown plan', '<h1>Unknown plan</h1><p><a href="/account">Back to your account</a></p>', { status: 400 });
  const block = await checkoutBlock(c.env.DB, c.userId, c.nowMs);
  if (block === 'already_subscribed') return redirect('/account');
  if (block === 'payment_pending') return redirect('/account?pending=1');
  const price = c.env[PLANS[plan]];
  if (!c.env.PADDLE_CLIENT_TOKEN || !price) {
    return page('Checkout unavailable', '<h1>Checkout is not available right now</h1><p>Try again later.</p>', { status: 503 });
  }
  const email = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(c.userId).first<string>('email');
  const discount = c.env.PADDLE_DISCOUNT_FOUNDING ? ` data-discount="${esc(c.env.PADDLE_DISCOUNT_FOUNDING)}"` : '';
  return page('Subscribe', `<h1>Subscribe to AI-MSG Pro (${PLAN_LABEL[plan]})</h1>
<p>${PRO_LINE}</p>
<div id="checkout" data-plan="${esc(plan)}" data-token="${esc(c.env.PADDLE_CLIENT_TOKEN)}" data-price="${esc(price)}" data-email="${esc(email ?? '')}" data-env="${esc(c.env.PADDLE_ENV)}"${discount}>
<button type="button" id="open-checkout">Open checkout</button>
</div>
<p id="result" role="status"></p>
<noscript><p>Checkout needs JavaScript.</p></noscript>
<p><a href="/account">Back to your account</a></p>`, { scripts: [PADDLE_JS_URL, '/static/checkout.js'], csp: checkoutCsp(c.env) });
});

/**
 * `/static/checkout.js` — intent first (the server writes the lock row, then answers the signed ref), then the overlay.
 * `customData` carries the ref alone (never a user id). The email is the account's, prefilled, and `allowLogout: false`
 * hides Paddle's "change email" option (Task 9 still refuses to link a customer whose email differs). `checkout.completed` → mark the intent done → account page.
 */
export const CHECKOUT_JS = `(() => {
  const box = document.getElementById('checkout');
  const button = document.getElementById('open-checkout');
  const out = document.getElementById('result');
  if (!box || !button || !out || !window.Paddle) { if (out) out.textContent = 'Checkout could not load. Disable blockers for this page and reload.'; return; }
  const d = box.dataset;
  let completed = false;
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (d.env === 'sandbox') Paddle.Environment.set('sandbox');
  Paddle.Initialize({
    token: d.token,
    eventCallback: (ev) => {
      if (!ev || completed) return;
      if (ev.name === 'checkout.completed') {
        completed = true;
        out.textContent = 'Payment received — confirming…';
        post('/v1/billing/intent/complete', {}).catch(() => {}).finally(() => { location.href = '/account?pending=1'; });
      } else if (ev.name === 'checkout.closed') {
        button.disabled = false;
        out.textContent = 'Checkout closed. You can open it again.';
      }
    },
  });
  const open = async () => {
    button.disabled = true;
    out.textContent = '';
    try {
      const r = await post('/v1/billing/intent', { plan: d.plan });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409 && body.code === 'already_subscribed') { location.href = '/account'; return; }
      if (r.status === 409 && body.code === 'payment_pending') { location.href = '/account?pending=1'; return; }
      if (!r.ok || typeof body.ref !== 'string') throw new Error(String(body.code || r.status));
      const opts = { items: [{ priceId: d.price, quantity: 1 }], customer: { email: d.email }, customData: { ref: body.ref }, settings: { displayMode: 'overlay', allowLogout: false } };
      if (d.discount) opts.discountCode = d.discount;
      Paddle.Checkout.open(opts);
    } catch (e) {
      out.textContent = 'Could not start checkout (' + (e && e.message ? e.message : 'error') + '). Try again.';
      button.disabled = false;
    }
  };
  button.addEventListener('click', () => { void open(); });
  void open();
})();
`;
