// Sign in / sign up / buy videos (Phase 5), shared by the studio and the phone page.
// One small modal, no framework. The server keeps the account in an HttpOnly cookie; this page never sees a password
// after it's sent, and never sees what the AI costs us.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function getAccount() {
  try { return (await (await fetch('/api/account')).json()) || {}; } catch { return {}; }
}

function modal(html) {
  const m = document.createElement('div');
  m.className = 'acct-modal';
  m.innerHTML = `<div class="acct-card card" role="dialog" aria-modal="true">${html}<button class="acct-x" aria-label="Close">✕</button></div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.querySelector('.acct-x').onclick = close;
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  return { el: m, close };
}

/** Sign in or create an account. Resolves the account, or null if closed. */
export function signIn({ reason = '' } = {}) {
  return new Promise((resolve) => {
    let mode = 'signup';
    const { el, close } = modal(`
      <span class="eyebrow">HandCam account</span>
      <h3 id="acctTitle">Create your account</h3>
      <p class="acct-why">${esc(reason || 'Your first real video is on us. Practice mode is always free.')}</p>
      <form id="acctForm">
        <input class="field" name="email" type="email" autocomplete="email" placeholder="Email" required>
        <input class="field" name="password" type="password" autocomplete="new-password" placeholder="Password (8+ characters)" minlength="8" required>
        <div class="acct-err" id="acctErr"></div>
        <button class="btn primary" type="submit" id="acctGo">Create account</button>
      </form>
      <button class="btn quiet sm" id="acctSwitch" type="button">I already have an account</button>`);
    const done = (acct) => { close(); resolve(acct); };
    el.querySelector('.acct-x').onclick = () => done(null);
    const form = el.querySelector('#acctForm'), err = el.querySelector('#acctErr');
    el.querySelector('#acctSwitch').onclick = () => {
      mode = mode === 'signup' ? 'login' : 'signup';
      el.querySelector('#acctTitle').textContent = mode === 'signup' ? 'Create your account' : 'Sign in';
      el.querySelector('#acctGo').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      el.querySelector('#acctSwitch').textContent = mode === 'signup' ? 'I already have an account' : 'Create a new account';
      form.password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
      err.textContent = '';
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      const go = el.querySelector('#acctGo'); go.disabled = true;
      try {
        const r = await fetch(`/api/account/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.email.value, password: form.password.value }) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Something went wrong.');
        done(out.account);
      } catch (x) { err.textContent = x.message; } finally { go.disabled = false; }
    };
    setTimeout(() => form.email.focus(), 50);
  });
}

/** Choose a pack and go to the Dodo checkout. `from`: 'desk' or 'cam', where to come back to. */
export function buyVideos({ packs = [], from = 'desk', balance = null } = {}) {
  const { el } = modal(`
    <span class="eyebrow">Videos</span>
    <h3>Buy videos</h3>
    <p class="acct-why">${balance != null ? `You have <b>${balance}</b> video${balance === 1 ? '' : 's'}. ` : ''}One video = one 480p version up to 8 s. 720p uses 2, 1080p uses 5. Versions under 70% move match are free.</p>
    <div class="packs">${packs.map((p) => `<button class="pack" data-id="${esc(p.id)}"><b>${esc(p.name)}</b><span>$${Number(p.usd).toFixed(0)}</span><small>$${(p.usd / p.videos).toFixed(2)} per video</small></button>`).join('')}</div>
    <div class="acct-err" id="buyErr"></div>
    <p class="note">Secure checkout by Dodo Payments. You come back here when it’s done.</p>`);
  for (const b of el.querySelectorAll('.pack')) b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await fetch('/api/pay/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packId: b.dataset.id, from }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'Could not start the payment.');
      location.href = out.url;
    } catch (x) { el.querySelector('#buyErr').textContent = x.message; b.disabled = false; }
  };
}

/** After coming back from checkout (?paid=…): a message for the person, and the URL cleaned. */
export function paymentReturnMessage() {
  const q = new URLSearchParams(location.search), paid = q.get('paid');
  if (!paid) return null;
  q.delete('paid'); q.delete('videos');
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  return { ok: 'Payment done: your videos are in your balance.', processing: 'Payment is processing: your videos appear when it clears.', cancelled: 'Payment cancelled. Nothing was charged.', failed: 'The payment didn’t go through. Nothing was charged.', check: 'We couldn’t confirm the payment yet. If you paid, your videos will appear shortly.' }[paid] || null;
}
