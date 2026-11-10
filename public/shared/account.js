// Sign in, plans, top-ups and the account panel (Phase 5, 5c: docs/PRICING-PLAN.md), for the studio.
// One small modal at a time, no framework. Sign-in is Google only. The server keeps the account in an HttpOnly cookie;
// this page never sees what the AI costs us, and never sees a saved AI key (only its last 4 characters).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w = 'video') => `${n} ${w}${n === 1 ? '' : 's'}`;
const money = (usd) => `$${Number(usd) % 1 ? Number(usd).toFixed(2) : Number(usd)}`;
const date = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '';

export async function getAccount() {
  try { return (await (await fetch('/api/account')).json()) || {}; } catch { return {}; }
}
let catalogue = null;
export async function getPlans() {
  if (!catalogue) catalogue = fetch('/api/plans').then((r) => r.json()).catch(() => { catalogue = null; return null; });
  return catalogue;
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(out.error || 'Something went wrong. Try again in a minute.'), { code: out.code });
  return out;
}

function modal(html, cls = '') {
  document.querySelector('.acct-modal')?.remove(); // one at a time
  const m = document.createElement('div');
  m.className = 'acct-modal';
  m.innerHTML = `<div class="acct-card card ${cls}" role="dialog" aria-modal="true">${html}<button class="acct-x" aria-label="Close">✕</button></div>`;
  document.body.append(m);
  const close = () => m.remove();
  m.querySelector('.acct-x').onclick = close;
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  return { el: m, close };
}

// ---- Sign-in: Google only, through Supabase Auth (DECISIONS §49). Loaded only when needed. ----
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
let supaClient; // undefined: not checked yet · false: this server has no Supabase · a client
export async function supabase() {
  if (supaClient !== undefined) return supaClient;
  try {
    const cfg = (await (await fetch('/api/auth/config')).json()).supabase;
    if (!cfg) return (supaClient = false);
    const { createClient } = await import(SUPABASE_JS);
    supaClient = createClient(cfg.url, cfg.publishableKey, { auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true } });
  } catch { supaClient = false; }
  return supaClient;
}
/**
 * Call on page load: finishes a sign-in that came back from Google. The Supabase session becomes CineHand's own
 * session cookie. → { account, notice } (notice: something to tell the person, e.g. no free videos on this device),
 * { error }, or {} when there was nothing to finish.
 */
export async function finishSignIn() {
  const back = /[?&#](code|access_token|error_description)=/.test(location.search + location.hash);
  const sb = (back || (await getAccount()).account === null) ? await supabase() : false;
  if (!sb) return {};
  const { data } = await sb.auth.getSession(); // also swaps a ?code= from Google for a session
  if (back) { // tidy the address bar
    const q = new URLSearchParams(location.search); for (const k of ['code', 'error', 'error_code', 'error_description']) q.delete(k);
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  }
  if (!data.session) return {};
  try {
    const out = await postJson('/api/account/supabase', { access_token: data.session.access_token });
    return { account: out.account, notice: out.notice };
  } catch (x) {
    await sb.auth.signOut().catch(() => {}); // a session CineHand won't take (not Google): don't try it again on every page load
    return back ? { error: x.message } : {};
  }
}
/** Sign out of CineHand (and of Supabase, so the next person on this computer starts fresh). */
export async function signOut() {
  await fetch('/api/account/logout', { method: 'POST' });
  const sb = await supabase();
  if (sb) await sb.auth.signOut().catch(() => {});
  location.reload();
}

const GOOGLE_ICON = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

/**
 * Sign in or create an account: one button, Google. The browser leaves for Google and comes back to this page, where
 * finishSignIn() carries on, so this resolves null (closed, or on the way to Google).
 */
export function signIn({ reason = '' } = {}) {
  return new Promise(async (resolve) => {
    const sb = await supabase();
    const { el, close } = modal(`
      <span class="eyebrow">CineHand account</span>
      <h3>Sign in to CineHand</h3>
      <p class="acct-why">${esc(reason || 'Your first two real videos are on us. Practice mode is always free.')}</p>
      ${sb ? `<button class="btn google" id="acctGoogle" type="button">${GOOGLE_ICON}<span>Continue with Google</span></button>
      <p class="note">One Google account, one CineHand account. New here? The same button creates your account.</p>` : '<p class="warn-box">Sign-in isn’t set up on this server.</p>'}
      <div class="acct-err" id="acctErr"></div>`);
    el.querySelector('.acct-x').onclick = () => { close(); resolve(null); };
    const go = el.querySelector('#acctGoogle');
    go?.addEventListener('click', async () => {
      go.disabled = true;
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${location.origin}${location.pathname}${location.search}` } });
      if (error) { el.querySelector('#acctErr').textContent = error.message; go.disabled = false; } // otherwise the browser is on its way to Google and back
    });
  });
}

/** One line for a plan's monthly videos. */
const videosLine = (p) => (p.videosPerMonth ? `${p.videosPerMonth} real AI videos a month` : p.id === 'free' ? '2 real AI videos to try (480p, watermarked)' : 'No AI videos included');
function includes(p, cat) {
  const f = p.features, rows = [videosLine(p)];
  rows.push(f.exportData ? 'JSON and Blender export' : 'Grey video export');
  if (p.id !== 'free') rows.push('480p, 720p and 1080p, no watermark');
  if (f.byok) rows.push('Use your own Higgsfield key');
  if (f.priority >= 2) rows.push('First in the queue when busy'); else if (f.priority === 1) rows.push('Priority when busy');
  if (f.commercial) rows.push('Commercial use');
  if (f.topups && cat.topups.length) rows.push(`Top-ups from ${money(Math.min(...cat.topups.map((t) => t.usd)))}`);
  return rows;
}

/**
 * Choose or change a plan, buy Lifetime. `reason`: a line at the top saying why this opened (e.g. "Blender export comes
 * with a paid plan"). Resolves when the modal closes; the page reloads the account when something changed.
 */
export async function openPlans({ account = null, reason = '', from = 'desk', onChange = () => {} } = {}) {
  const cat = await getPlans();
  if (!cat) return;
  const store = { get: () => { try { return localStorage.getItem('handcam.interval'); } catch { return null; } }, set: (v) => { try { localStorage.setItem('handcam.interval', v); } catch {} } };
  let interval = account?.sub?.interval || store.get() || 'month';
  const { el, close } = modal('<div id="plansBody"></div>', 'wide');
  const body = el.querySelector('#plansBody');
  const live = account?.sub && ['active', 'ending'].includes(account.status) ? account.sub : null;

  function cardAction(p) {
    if (!account) return `<button class="btn ${p.popular ? 'primary' : 'ghost'}" data-pick="${p.id}">${p.id === 'free' ? 'Create account' : `Choose ${esc(p.name)}`}</button>`;
    const current = (live && live.plan === p.id && live.interval === interval) || (!live && p.id === account.plan);
    if (current) return `<button class="btn ghost" disabled>Your plan</button>`;
    if (p.id === 'free') return live ? `<button class="btn quiet" data-cancel>Cancel plan</button>` : '<span></span>';
    if (account.status === 'on_hold') return `<button class="btn ghost" disabled title="Update your card first">Change plan</button>`;
    if (!live) return `<button class="btn ${p.popular ? 'primary' : 'ghost'}" data-pick="${p.id}">Choose ${esc(p.name)}</button>`;
    const rank = cat.plans.find((x) => x.id === live.plan)?.rank ?? 0;
    const up = p.rank > rank || (p.rank === rank && interval === 'year');
    return `<button class="btn ${up ? 'primary' : 'ghost'}" data-pick="${p.id}">${up ? 'Upgrade' : 'Switch'} to ${esc(p.name)}</button>`;
  }

  function render(msg = '') {
    const yearly = interval === 'year';
    body.innerHTML = `
      <span class="eyebrow">Plans</span>
      <h3>${live ? 'Change your plan' : 'Choose a plan'}</h3>
      ${reason ? `<p class="acct-why">${esc(reason)}</p>` : ''}
      <div class="seg" role="tablist" aria-label="Billing"><button role="tab" data-iv="month" class="${yearly ? '' : 'on'}">Monthly</button><button role="tab" data-iv="year" class="${yearly ? 'on' : ''}">Yearly <small>save 20%</small></button></div>
      <div class="plan-grid">${cat.plans.map((p) => `
        <div class="plan-card${p.popular ? ' pop' : ''}">
          <div class="pc-top"><b>${esc(p.name)}</b>${p.popular ? '<span class="badge accent">Most popular</span>' : ''}</div>
          <span class="muted small">${esc(p.tagline || '')}</span>
          <div class="pc-price">${p.id === 'free' ? '$0' : money(yearly ? Math.round(p.price.year / 12) : p.price.month)}<small>${p.id === 'free' ? '' : '/month'}</small></div>
          <span class="muted small">${p.id === 'free' ? 'Free forever' : yearly ? `${money(p.price.year)} billed yearly` : 'Billed monthly'}</span>
          <ul>${includes(p, cat).map((x) => `<li>${esc(x)}</li>`).join('')}${(p.soon || []).map((x) => `<li class="soon">${esc(x)} <span class="badge">soon</span></li>`).join('')}</ul>
          ${cardAction(p)}
        </div>`).join('')}
      </div>
      ${cat.lifetime && !account?.lifetime ? `<div class="life"><div><b>${esc(cat.lifetime.name)} · ${money(cat.lifetime.usd)} once</b><span class="muted small">${esc(cat.lifetime.tagline)}. JSON and Blender export, your own Higgsfield key for AI videos, top-ups. No monthly videos.</span></div>
        <button class="btn ghost" data-life ${cat.lifetime.soldOut ? 'disabled' : ''}>${cat.lifetime.soldOut ? 'Sold out' : 'Buy Lifetime'}</button></div>` : ''}
      <p class="note">One video = one 480p version up to 8 s; 720p uses 2, 1080p uses 5. Versions under 70% move match use nothing (the 2 free trial videos are 2 versions, whatever their match). Plan videos reset monthly; top-ups never expire. ${live ? 'Upgrades start now and you pay the difference today; switching down happens when your paid period ends.' : 'Cancel any time: you keep the plan until the end of what you paid for.'}</p>
      <div class="acct-err" id="planErr">${esc(msg)}</div>`;
    for (const b of body.querySelectorAll('[data-iv]')) b.onclick = () => { interval = b.dataset.iv; store.set(interval); render(); };
    for (const b of body.querySelectorAll('[data-pick]')) b.onclick = () => pick(b.dataset.pick, b);
    body.querySelector('[data-cancel]')?.addEventListener('click', () => { close(); cancelPlan({ account, onChange }); });
    body.querySelector('[data-life]')?.addEventListener('click', (e) => checkout({ kind: 'lifetime', id: cat.lifetime.id }, e.target));
  }

  async function checkout(item, btn) {
    if (!account) { close(); if (await signIn({ reason: 'Create your account first, then choose your plan.' })) { onChange(); } return; }
    btn.disabled = true;
    try { location.href = (await postJson('/api/pay/checkout', { ...item, from })).url; }
    catch (x) { render(x.message); }
  }
  async function pick(planId, btn) {
    if (!account) return checkout({ kind: 'plan', id: planId, interval }, btn);
    if (!live) return checkout({ kind: 'plan', id: planId, interval }, btn);
    const p = cat.plans.find((x) => x.id === planId), rank = cat.plans.find((x) => x.id === live.plan)?.rank ?? 0;
    const up = p.rank > rank || (p.rank === rank && interval === 'year');
    const sure = up
      ? `Switch to ${p.name} ${interval === 'year' ? 'yearly' : 'monthly'} now? You pay the difference for the rest of this period today, and this month’s videos go up to ${p.videosPerMonth} at once (the ones you’ve used still count).`
      : `Switch to ${p.name} ${interval === 'year' ? 'yearly' : 'monthly'} on ${date(live.paidThrough)}? You keep your current plan and its videos until then.`;
    // confirm inside the window (no browser pop-up), then show the result here too
    body.innerHTML = `<span class="eyebrow">Plans</span><h3>${up ? 'Upgrade' : 'Switch'} to ${esc(p.name)}?</h3><p class="acct-why">${esc(sure)}</p>
      <div class="row" style="gap:8px"><button class="btn primary" data-yes>${up ? 'Upgrade now' : `Switch on ${esc(date(live.paidThrough))}`}</button><button class="btn ghost" data-back>Back</button></div>
      <div class="acct-err" id="planErr"></div>`;
    body.querySelector('[data-back]').onclick = () => render();
    body.querySelector('[data-yes]').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = up ? 'Upgrading…' : 'Saving…';
      try {
        const out = await postJson('/api/pay/change', { plan: planId, interval });
        if (!up || out.account?.sub?.plan === planId) { close(); onChange(); return; }
        // an upgrade is charged first: Dodo confirms the payment a few seconds later, then the plan switches
        body.innerHTML = `<span class="eyebrow">Plans</span><h3>Upgrading to ${esc(p.name)}…</h3><p class="acct-why">We’re confirming the payment for the difference. This usually takes under a minute; you can close this window.</p><div class="spinner"></div>`;
        onChange();
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const now = (await getAccount()).account;
          if (now?.sub?.plan === planId) { body.innerHTML = `<span class="eyebrow">Plans</span><h3>You’re on ${esc(p.name)}</h3><p class="acct-why">${plural(now.videos?.left ?? 0)} left this month.</p><button class="btn primary" data-done>Done</button>`; body.querySelector('[data-done]').onclick = close; onChange(); return; }
          if (!document.body.contains(el)) { onChange(); return; } // window closed: the page refreshes the account itself
        }
        body.querySelector('.acct-why').textContent = 'The payment is taking longer than usual. Your plan will switch as soon as it goes through.';
      } catch (x) { body.querySelector('#planErr').textContent = x.message; e.target.disabled = false; e.target.textContent = 'Try again'; }
    };
  }
  render();
}

/** Cancel at the end of the paid period, after saying exactly what happens. */
export async function cancelPlan({ account, onChange = () => {} }) {
  const { el, close } = modal(`
    <span class="eyebrow">Cancel plan</span>
    <h3>Cancel ${esc(account.name)}?</h3>
    <p class="acct-why">You keep ${esc(account.name)} and this month’s videos until <b>${esc(date(account.sub?.paidThrough))}</b>. Then you’re on Free: your sets, takes and grey video export stay; JSON and Blender export stop. ${account.videos.topup ? `Your ${plural(account.videos.topup, 'top-up video')} stay yours.` : ''} No refund for the rest of the period.</p>
    <select class="field" id="why" aria-label="Why are you cancelling? (optional)"><option value="">Why? (optional)</option><option value="too_expensive">Too expensive</option><option value="unused">I don’t use it enough</option><option value="missing_features">Missing something I need</option><option value="low_quality">The videos aren’t good enough</option><option value="too_complex">Too hard to use</option><option value="switched_service">Switched to something else</option><option value="other">Something else</option></select>
    <div class="acct-err" id="cancelErr"></div>
    <div class="row"><button class="btn ghost grow" data-keep>Keep my plan</button><button class="btn quiet grow" data-go>Cancel plan</button></div>`);
  el.querySelector('[data-keep]').onclick = close;
  el.querySelector('[data-go]').onclick = async (e) => {
    e.target.disabled = true;
    try { await postJson('/api/pay/cancel', { feedback: el.querySelector('#why').value || undefined }); close(); onChange(); }
    catch (x) { el.querySelector('#cancelErr').textContent = x.message; e.target.disabled = false; }
  };
}

/** Buy top-ups (paid plans and Lifetime). Free accounts are shown the plans instead. */
export async function buyTopups({ account, from = 'desk', onChange = () => {}, reason = '' } = {}) {
  const cat = await getPlans();
  if (!cat) return;
  if (!account?.features?.topups) return openPlans({ account, from, onChange, reason: reason || (account ? 'You’ve used your free videos. A plan comes with videos every month, and lets you buy top-ups.' : '') });
  const { el } = modal(`
    <span class="eyebrow">Top-ups</span>
    <h3>More videos</h3>
    <p class="acct-why">${reason ? `${esc(reason)} ` : ''}You have <b>${account.videos.total}</b>: ${account.videos.left} left this month${account.videos.topup ? ` + ${account.videos.topup} top-up` : ''}. Top-ups never expire and are used after your plan’s videos.</p>
    <div class="packs">${cat.topups.map((t) => `<button class="pack" data-id="${esc(t.id)}"><b>${esc(t.name)}</b><span>${money(t.usd)}</span><small>${money(t.usd / t.videos)} per video</small></button>`).join('')}</div>
    <div class="acct-err" id="buyErr"></div>
    <p class="note">Secure checkout by Dodo Payments. You come back here when it’s done.</p>`);
  for (const b of el.querySelectorAll('.pack')) b.onclick = async () => {
    b.disabled = true;
    try { location.href = (await postJson('/api/pay/checkout', { kind: 'topup', id: b.dataset.id, from })).url; }
    catch (x) { el.querySelector('#buyErr').textContent = x.message; b.disabled = false; }
  };
}

/** The account panel: plan, videos, what happens next, and every change in one place. */
export async function openAccount({ account, from = 'desk', onChange = () => {} }) {
  const v = account.videos, s = account.sub, cat = await getPlans();
  const nameOf = (id) => cat?.plans.find((p) => p.id === id)?.name || id;
  const status = account.hold ? `<div class="warn-box">Real AI videos are paused while a payment dispute is open. Write to us if that’s a mistake.</div>`
    : account.status === 'on_hold' ? `<div class="warn-box"><b>Your last payment didn’t go through.</b> Plan videos are paused until it does; everything else keeps working. <button class="btn primary sm" data-portal>Update card</button></div>`
    : account.status === 'ending' ? `<div class="warn-box">${esc(account.name)} ends on <b>${esc(date(s.paidThrough))}</b>, then you’re on Free. <button class="btn primary sm" data-resume>Keep my plan</button></div>`
    : s?.pending ? `<div class="warn-box">Switches to <b>${esc(nameOf(s.pending.plan))}</b> (${s.pending.interval === 'year' ? 'yearly' : 'monthly'}) on ${esc(date(s.pending.at))}. <button class="btn ghost sm" data-keep>Keep ${esc(account.name)}</button></div>` : '';
  const pct = v.included ? Math.round((v.left / v.included) * 100) : 0;
  const { el, close } = modal(`
    <span class="eyebrow">${esc(account.email)}</span>
    <h3>${esc(account.name)}${s ? ` <span class="muted small">${s.interval === 'year' ? 'yearly' : 'monthly'}</span>` : ''}</h3>
    ${status}
    ${v.included ? `<div class="meter" aria-label="Plan videos left"><i style="width:${pct}%"></i></div><p class="acct-why"><b>${v.left} of ${v.included}</b> plan videos left${v.resetsAt ? ` · back to ${v.included} on ${esc(date(v.resetsAt))}` : ''}</p>` : ''}
    <p class="acct-why">${[v.topup && `${plural(v.topup, 'top-up video')} (never expire)`, v.trial && `${plural(v.trial, 'free video')} to try (480p, watermarked)`].filter(Boolean).join(' · ') || (v.included ? '' : 'No real AI videos left.')}${s && account.status === 'active' && !s.pending ? ` Renews ${esc(date(s.paidThrough))}.` : ''}</p>
    <div class="row wrap">
      <button class="btn primary" data-plans>${s || account.lifetime ? 'Change plan' : 'Choose a plan'}</button>
      ${account.features.topups ? '<button class="btn ghost" data-topup>Buy videos</button>' : ''}
      ${s ? '<button class="btn ghost" data-portal>Manage billing</button>' : ''}
    </div>
    ${account.features.byok ? `<details class="byok"><summary>Your own Higgsfield key ${account.byok?.set ? `<span class="badge ok">saved · …${esc(account.byok.last4)}</span>` : ''}</summary>
      <p class="note">Make videos on your own Higgsfield account (console.higgsfield.ai → API keys): they use none of your CineHand videos, every quality, no watermark. Stored encrypted; we never show it again.</p>
      <form id="byokForm"><input class="field" name="keyId" placeholder="API key ID" autocomplete="off" required><input class="field" name="keySecret" type="password" placeholder="API key secret" autocomplete="off" required>
      <div class="row"><button class="btn ghost sm" type="submit">Save key</button>${account.byok?.set ? '<button class="btn quiet sm" type="button" data-unkey>Remove key</button>' : ''}</div></form></details>` : ''}
    <div class="acct-err" id="acctErr2"></div>
    <div class="row"><span class="grow"></span><button class="btn quiet sm" data-out>Sign out</button></div>`);
  const err = (x) => { el.querySelector('#acctErr2').textContent = x.message; };
  const act = (sel, fn) => el.querySelector(sel)?.addEventListener('click', async (e) => { e.preventDefault(); e.target.disabled = true; try { await fn(); } catch (x) { err(x); e.target.disabled = false; } });
  act('[data-plans]', async () => { close(); openPlans({ account, from, onChange }); });
  act('[data-topup]', async () => { close(); buyTopups({ account, from, onChange }); });
  for (const b of el.querySelectorAll('[data-portal]')) b.addEventListener('click', async () => { try { location.href = (await postJson('/api/pay/portal', { from })).url; } catch (x) { err(x); } });
  act('[data-resume]', async () => { await postJson('/api/pay/resume'); close(); onChange(); });
  act('[data-keep]', async () => { await postJson('/api/pay/keep'); close(); onChange(); });
  act('[data-unkey]', async () => { const r = await fetch('/api/account/byok', { method: 'DELETE' }); if (!r.ok) throw new Error('Could not remove the key.'); close(); onChange(); });
  act('[data-out]', signOut);
  el.querySelector('#byokForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await postJson('/api/account/byok', { keyId: e.target.keyId.value, keySecret: e.target.keySecret.value }); close(); onChange(); } catch (x) { err(x); }
  });
}

/** A paid feature was asked for: sign in, or show the plans with the reason. → true if something was shown. */
export async function needPlan({ account, reason, from = 'desk', onChange = () => {} }) {
  if (!account) { if (await signIn({ reason: `${reason} Create your account to see the plans.` })) onChange(); return true; }
  await openPlans({ account, reason, from, onChange });
  return true;
}

/** After coming back from checkout (?paid=…): a message for the person, and the URL cleaned. */
export function paymentReturnMessage() {
  const q = new URLSearchParams(location.search), paid = q.get('paid');
  if (!paid) return null;
  q.delete('paid'); q.delete('videos');
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  return {
    ok: 'Payment done: your videos are in your account.', plan: 'You’re on your new plan. Its videos are ready to use.', lifetime: 'Lifetime is yours. Add your Higgsfield key in your account to make AI videos.',
    processing: 'Payment is processing: it appears in your account when it clears.', cancelled: 'Payment cancelled. Nothing was charged.',
    failed: 'The payment didn’t go through. Nothing was charged.', check: 'We couldn’t confirm the payment yet. If you paid, it will appear shortly.',
  }[paid] || null;
}
