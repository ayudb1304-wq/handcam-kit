// Make video panel: look → (render grey move + measuring twin) → server job → approve first frame → result.
// The server does the AI work and the checking (server/make). This file only renders and uploads.
import { signIn, buyTopups, openPlans } from '../shared/account.js';
import { logoToPng, photoToJpeg, blobOf } from '../shared/image.js';
import { getKit, setLogo, setLook } from '../shared/refs.js';
import { showPane } from './tabs.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE = new Set(['uploading', 'preparing', 'start_image', 'making', 'checking']);
const DEMO_LOOK = 'Wet parking lot at night, orange sodium street light, a man in a grey hoodie by the cars, shot on an old phone';

export function setupMake({ getTake, takeScene, toast, getView = () => null, onDone, onJobs = () => {}, onAccount = () => {} }) {
  const form = $('makeForm'), box = $('makeJob'), btn = $('makeBtn'), sel = $('recipe'), qsel = $('quality'), vsel = $('versions');
  let recipes = [], job = null, timer = null, blocked = null, freeBelow = 70, cfg = {};
  // FOUNDER ONLY: the real AI cost in dollars. Must be replaced by the customer price (videos/credits) before going live: PLAN Phase 5.
  const usd = (x) => `$${x.toFixed(2)}`;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  let jobs = []; // newest first, from the server: lets a take show the videos already made from it
  const latestFor = (takeId) => jobs.find((j) => j.take?.id === takeId);
  async function loadJobs() {
    try { jobs = (await (await fetch('/api/make')).json()).jobs || []; } catch { jobs = []; }
    onJobs();
  }
  function showForm() { clearTimeout(timer); job = null; box.hidden = true; form.hidden = false; costLine(); }

  const recipe = () => recipes.find((r) => r.id === sel.value);
  /**
   * The pictures the AI must keep, for this take's set: the look of the set (one wide picture of the whole place), the
   * product's photo (from building the set) and the brand's logo.
   */
  const setIdOf = (scene) => scene?.setId || scene?.id;
  async function productRefs(take) {
    const scene = take && (await takeScene(take));
    const [kit, brand] = await Promise.all([getKit(setIdOf(scene)), getKit('__brand')]);
    return { look: kit.look || null, subject: kit.subject[0] || null, logo: brand.logo || null };
  }
  let refsFor = null;
  async function showRefs(take) {
    const row = $('refsRow'), lookRow = $('lookRow');
    if (!cfg.refs || !take || recipe()?.provider === 'mock') { row.hidden = lookRow.hidden = true; refsFor = null; return; }
    if (refsFor === take.id) return;
    refsFor = take.id;
    const { look, subject, logo } = await productRefs(take).catch(() => ({}));
    row.hidden = !subject && !logo;
    $('refThumbs').innerHTML = [subject, logo].filter(Boolean).map((p) => `<img src="${p.dataUrl}" alt="">`).join('');
    $('refsText').textContent = subject ? `Keep my product exactly as in my photo${logo ? ', with my logo' : ''}` : 'Keep my logo exactly as it is';
    lookRow.hidden = false;
    $('lookThumb').innerHTML = look ? `<img src="${look.dataUrl}" alt="">` : '';
    $('lookText').textContent = look ? 'Set look saved' : 'Set look';
    $('lookBtn').textContent = look ? 'Redo' : 'Make';
  }

  // ---- the look of the set: one wide picture of the whole place, approved once (DECISIONS §50) ----
  /** Grey picture of the set from the studio's own view, in this take's frame. */
  async function wideView(take, scene) {
    const v = getView();
    if (!v) throw new Error('The studio view isn’t ready yet.');
    const { exportTake } = await import('../shared/export-video.js');
    const still = { id: 'look', frame: take.frame, view: { fov: v.fov, aspect: take.view?.aspect ?? 16 / 9 }, samples: [{ ts: 0, p: v.p, q: v.q }, { ts: 1, p: v.p, q: v.q }] };
    return exportTake(still, scene); // one frame: its PNG is the picture
  }
  const dataUrlOf = (blob) => new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsDataURL(blob); });
  async function makeLook() {
    const take = getTake(), r = recipe(), words = $('look').value.trim(), b = $('lookBtn');
    if (!take || !r) return;
    if (words.length < 3) { $('look').focus(); return toast('Describe the look in a few words first.'); }
    const scene = await takeScene(take);
    if (!scene) return toast('The set this take was shot in isn’t saved on this computer.');
    const label = b.textContent;
    b.disabled = true; b.innerHTML = '<span class="spinner"></span>Making…';
    try {
      const wide = await wideView(take, scene);
      const { subject } = await productRefs(take);
      const b64 = async (blob) => (await dataUrlOf(blob)).split(',')[1];
      const res = await fetch('/api/make/look', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        recipeId: r.id, look: words, aspect: wide.width < wide.height ? '9:16' : '16:9', byok: r.ownKey ? ownKey() : undefined,
        wide: { data: await b64(wide.png) }, subject: subject && $('useRefs').checked ? { data: subject.dataUrl.split(',')[1] } : undefined,
      }) });
      if (!res.ok) { const out = await res.json().catch(() => ({})); if (await needAccount(out)) return; throw new Error(out.error || 'The look could not be made. Try again.'); }
      const pic = await photoToJpeg(await res.blob());
      approveLook({ dataUrl: pic.dataUrl, width: pic.width, height: pic.height, words, at: Date.now() }, setIdOf(scene));
    } catch (e) { toast(e.message, 6000); }
    finally { b.disabled = false; b.textContent = label; }
  }
  /** Show the picture; nothing is kept until the person says it's the place. */
  function approveLook(look, setId) {
    const m = $('resultModal');
    m.innerHTML = `<div class="card modal-card">
      <div class="modal-head"><div class="grow"><span class="eyebrow">Look of this set</span><h2>Is this the place?</h2>
        <p class="muted" style="margin:6px 0 0">Every video in this set starts from this picture. To change the view, turn the studio view and try again.</p></div>
        <button class="btn quiet icon" data-act="close" aria-label="Close">✕</button></div>
      <img src="${look.dataUrl}" alt="The look of this set" style="max-width:100%;max-height:58vh;display:block;margin:0 auto;border-radius:10px">
      <div class="row wrap"><span class="grow"></span><button class="btn ghost" data-act="again">Try again</button><button class="btn primary" data-act="use">Use this look</button></div>
    </div>`;
    m.hidden = false;
    const close = () => { m.hidden = true; m.innerHTML = ''; };
    m.querySelector('[data-act=close]').onclick = close;
    m.querySelector('[data-act=again]').onclick = () => { close(); makeLook(); };
    m.querySelector('[data-act=use]').onclick = async () => {
      try { await setLook(setId, look); } catch { return toast('The look could not be saved on this computer.', 5000); }
      close(); refsFor = null; costLine();
      toast('Saved. Videos in this set now start from this look.');
    };
  }
  $('lookBtn').onclick = makeLook;
  function costLine() {
    const r = recipe(), take = getTake();
    showRefs(take).catch(() => {});
    if (blocked) { $('costText').textContent = blocked; $('costEta').textContent = ''; btn.disabled = true; return; }
    if (!take) { $('costText').textContent = 'Pick a take first'; $('costEta').textContent = ''; btn.disabled = true; return; }
    if (!r) return;
    const takeS = (take.samples?.at(-1)?.ts ?? 0) / 1000;
    if (Math.round(takeS) > (r.maxDurationS ?? 15)) { // same rule as the server: too long for this model, never cut silently
      $('costText').textContent = `This take is ${takeS.toFixed(1)} s. ${r.label} takes up to ${r.maxDurationS} s: shoot it again a little shorter.`;
      $('costEta').textContent = ''; btn.disabled = true; return;
    }
    const free = r.provider === 'mock' && !cfg.chargePractice;
    // same length rule as the server: whole seconds, within the recipe's limits
    const secs = Math.min(r.maxDurationS ?? 15, Math.max(r.minDurationS ?? 4, Math.round((take.samples?.at(-1)?.ts ?? 0) / 1000)));
    const n = Number(vsel.value) || r.candidates;
    const own = ownKey();
    $('ownKeyRow').hidden = !r.ownKey || !r.ourKey; // only a choice when both ways are open; own-key-only recipes always use it
    $('costEta').textContent = free ? '≈ 20 s' : qsel.value === '1080p' ? '≈ 5–10 min' : '≈ 3–5 min';
    if (cfg.admin) { // founder on the laptop: the real AI cost (never shown to customers: PLAN Phase 5)
      const video = r.qualities?.[qsel.value] != null ? r.qualities[qsel.value] * secs : r.cost?.video ?? 0;
      const total = (r.cost?.startImage ?? 0) + n * video;
      $('costText').textContent = free ? 'Practice · free · no AI' : `≈ ${usd(total)} · ${n} × ${secs} s video${n > 1 ? ', best kept' : ''}`;
    } else if (own) {
      $('costText').innerHTML = 'On your own Higgsfield key · uses none of your videos';
    } else {
      // customers: the price in videos from their plan, top-ups or trial (docs/PRICING-PLAN.md), never our AI cost
      const unit = free ? 0 : (cfg.pricing?.qualityUnits?.[qsel.value] ?? 1) * (secs > (cfg.pricing?.longTakeSeconds ?? 8) ? 2 : 1);
      const v = cfg.ent?.videos, need = n * unit;
      const trialOnly = v && unit && v.left + v.topup < need; // the free trial videos would pay: 480p and watermarked
      $('costText').innerHTML = free ? 'Practice · free · no AI'
        : `Uses up to <b>${need}</b> video${need === 1 ? '' : 's'}${v ? ` · you have ${v.total} · <a href="#" id="buyLink">${cfg.ent.features.topups ? 'Buy more' : 'See plans'}</a>` : ''}${trialOnly && v.total >= need ? ` · <span title="Your free videos are ${cfg.ent.trialQuality} with a small CineHand label. Each version made uses one, whatever its move match.">free trial: ${cfg.ent.trialQuality}, watermarked, every version counts</span>` : ''}`;
      $('buyLink')?.addEventListener('click', (e) => { e.preventDefault(); topUp(); });
    }
    $('recipeStatus').hidden = r.status === 'final';
    $('recipeStatus').textContent = r.status;
    btn.disabled = !r.ready;
    $('recipeWhy').textContent = r.ready ? '' : (r.why ? `${r.label}: ${r.why}.` : '');
  }
  /** Quality list for the chosen model: hidden when it has none (Practice). Remembers the last pick per browser. */
  function fillQualities() {
    const q = Object.entries(recipe()?.qualities || {});
    qsel.hidden = !q.length;
    const saved = store.get('handcam.quality');
    qsel.innerHTML = '';
    q.forEach(([name], i) => qsel.append(new Option(`${name}${i === 0 ? ' · test' : name === '1080p' ? ' · best' : ''}`, name)));
    if (q.some(([name]) => name === saved)) qsel.value = saved;
    costLine();
  }
  sel.onchange = fillQualities;
  qsel.onchange = () => { store.set('handcam.quality', qsel.value); costLine(); };
  /** How many versions to make, 1 to maxVersions. More versions: better odds one follows the move, and more cost. */
  function fillVersions(max = 4) {
    vsel.innerHTML = '';
    for (let n = 1; n <= max; n++) vsel.append(new Option(n === 1 ? '1 version' : `${n} versions`, String(n)));
    vsel.value = store.get('handcam.versions') || '2';
    if (!vsel.value) vsel.value = '2';
  }
  vsel.onchange = () => { store.set('handcam.versions', vsel.value); costLine(); };

  /** Use the customer's own Higgsfield key for this video? (paid plans with a saved key; required when real AI is off for customers) */
  const ownKey = () => { const r = recipe(); return !!r?.ownKey && (!r.ourKey || $('ownKey').checked); };
  $('ownKey').onchange = () => { store.set('handcam.ownKey', $('ownKey').checked ? '1' : ''); costLine(); };
  $('ownKey').checked = store.get('handcam.ownKey') === '1';
  const reloadAll = () => loadConfig();
  const topUp = (reason = '') => (cfg.ent?.features?.topups ? buyTopups({ account: cfg.account, onChange: reloadAll, reason }) : openPlans({ account: cfg.account, onChange: reloadAll, reason: reason || 'A plan comes with real AI videos every month.' }));

  async function loadConfig() {
    const res = await fetch('/api/make/config');
    cfg = await res.json();
    onAccount(cfg.account, cfg);
    ({ recipes } = cfg);
    freeBelow = cfg.freeBelowMatch ?? 70;
    const keepV = vsel.value, keepR = sel.value;
    fillVersions(cfg.maxVersions);
    if (keepV) vsel.value = keepV;
    sel.innerHTML = '';
    for (const r of recipes) {
      const o = new Option(`${r.label}${r.ready ? '' : r.why?.startsWith('real AI') ? ' · off for this test' : ' · needs setup'}${r.status === 'draft' && cfg.admin ? ' · draft recipe' : ''}`, r.id);
      o.disabled = !r.ready;
      sel.append(o);
    }
    sel.value = recipes.find((r) => r.id === keepR && r.ready)?.id || (recipes.find((r) => r.ready && r.provider !== 'mock') || recipes.find((r) => r.ready))?.id || '';
    fillQualities();
    return cfg;
  }
  loadConfig().then(async () => {
    await loadJobs();
    const take = getTake();
    const last = take ? latestFor(take.id) : jobs[0]; // carry on after a page reload
    if (last && (take || ACTIVE.has(last.status) || last.status === 'needs_approval')) show(last);
  }).catch(() => { blocked = 'Make video is unavailable'; costLine(); });
  /** Sign in (or top up) and carry on: used when the server says 401 / 402. */
  async function needAccount(out) {
    if (out?.code === 'signin') { if (await signIn({ reason: 'Sign in to make real videos. Your first two are free.' })) await loadConfig(); return true; }
    if (out?.code === 'balance') { topUp(out.error); return true; }
    if (out?.code === 'quality' || out?.code === 'plan' || out?.code === 'byok') { if (out.code === 'byok') toast(out.error, 6000); else openPlans({ account: cfg.account, onChange: reloadAll, reason: out.error }); return true; }
    return false;
  }

  // ---- start a job ----
  btn.onclick = async () => {
    const take = getTake(), r = recipe(), look = $('look').value.trim();
    if (!take || !r) return;
    if (look.length < 3) { $('look').focus(); return toast('Describe the look in a few words first.'); }
    const scene = await takeScene(take);
    if (!scene) return toast('The set this take was shot in isn’t saved on this computer.');
    const step = (text) => { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${esc(text)}`; };
    try {
      step('Preparing your move…');
      const { exportTake } = await import('../shared/export-video.js');
      const { speckle } = await import('../shared/speckle.js');
      const ref = await exportTake(take, scene, { onProgress: (f) => step(`Preparing your move ${Math.round(f * 50)}%`) });
      const twin = await exportTake(take, scene, { decorate: speckle, onProgress: (f) => step(`Preparing your move ${50 + Math.round(f * 50)}%`) });
      const { labSent, ...cleanTake } = take;
      // the look of the set always goes along when there is one; the product photo and logo when the box is ticked
      const kept = !$('lookRow').hidden ? await productRefs(take) : null;
      const refs = kept && { look: kept.look, ...(!$('refsRow').hidden && $('useRefs').checked ? { subject: kept.subject, logo: kept.logo } : {}) };
      const anyRefs = !!(refs?.look || refs?.subject || refs?.logo);
      const res = await fetch('/api/make', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ take: cleanTake, scene, look, recipeId: r.id, demo: !!take.demo, quality: qsel.hidden ? undefined : qsel.value, versions: Number(vsel.value) || undefined, byok: r.ownKey ? ownKey() : undefined, refs: anyRefs || undefined }) });
      const out = await res.json();
      if (!res.ok) { if (await needAccount(out)) return; throw new Error(out.error); }
      const files = { 'reference.mp4': ref.mp4, 'measure.mp4': twin.mp4, 'first-frame.png': ref.png };
      if (out.refUploads && refs?.look) files['ref-look.jpg'] = blobOf(refs.look.dataUrl);
      if (out.refUploads && refs?.subject) files['ref-subject.jpg'] = blobOf(refs.subject.dataUrl);
      if (out.refUploads && refs?.logo) files['ref-logo.png'] = blobOf(refs.logo.dataUrl);
      let i = 0;
      const count = Object.keys(files).length;
      for (const [name, blob] of Object.entries(files)) {
        step(`Uploading ${++i}/${count}…`);
        const u = await fetch(`/api/make/${out.job.id}/files/${name}`, { method: 'PUT', body: blob });
        if (!u.ok) throw new Error((await u.json().catch(() => ({}))).error || `upload failed (${u.status})`);
      }
      show((await post(out.job.id, 'start')).job);
    } catch (e) { toast(e.message, 6000); }
    finally { btn.innerHTML = 'Make video'; costLine(); }
  };

  async function post(id, action, body) {
    const r = await fetch(`/api/make/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const out = await r.json();
    if (!r.ok) { if (await needAccount(out)) throw new Error(out.code === 'signin' ? 'Signed in: press it again.' : out.code === 'balance' ? `${out.error} Or choose fewer versions.` : out.error); throw new Error(out.error); }
    if (out.account) { cfg.account = out.account; cfg.ent = out.account; onAccount(out.account, cfg); }
    return out;
  }
  function poll() {
    clearTimeout(timer);
    if (!job || !ACTIVE.has(job.status)) return;
    timer = setTimeout(async () => {
      try { show((await (await fetch(`/api/make/${job.id}`)).json()).job); } catch { poll(); }
    }, 1500);
  }

  // ---- show a job ----
  const STEPS = [['Preparing your move', ['uploading', 'preparing']], ['First frame', ['start_image']], ['Your OK', ['needs_approval']], ['Making the video', ['making']], ['Checking the move', ['checking']], ['Done', ['done']]];
  function show(j) {
    const was = job?.id === j.id ? job.status : undefined; // only a change of the same job counts as news
    job = j;
    form.hidden = true; box.hidden = false;
    const at = STEPS.findIndex(([, s]) => s.includes(j.status));
    const made = j.candidates.filter((c) => c.file).length;
    let html = `<h3 style="margin:0 0 10px">${j.status === 'failed' ? 'Something went wrong' : j.status === 'done' ? 'Your video is ready' : 'Making your video'}</h3><ul class="timeline-steps">`;
    STEPS.forEach(([label], i) => {
      const cls = j.status === 'failed' ? (i < at ? 'done' : '') : i < at || j.status === 'done' ? 'done' : i === at ? 'now' : '';
      const extra = i === 3 && (j.status === 'making' || made) ? `${made}/${Math.max(j.candidates.length, 1)}` : '';
      html += `<li class="${cls}"><span class="ic">${cls === 'now' ? '<span class="spinner"></span>' : ''}</span>${label}<span class="when">${extra}</span></li>`;
    });
    html += '</ul>';
    if (j.status === 'needs_approval') {
      const s = j.startImages.filter((x) => x.file).at(-1);
      html += `<div class="approve" style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
        <img src="/api/make/${j.id}/media/${s.file}" alt="First frame of your video">
        <p class="note">First frame. Same layout as your set?</p>
        <div class="row"><select id="approveVersions" class="grow" aria-label="How many versions">${Array.from({ length: cfg.maxVersions || 4 }, (_, i) => `<option value="${i + 1}" ${i + 1 === (j.versions || 2) ? 'selected' : ''}>${i + 1} version${i ? 's' : ''}${j.charge ? ` · up to ${(i + 1) * j.charge.unit} video${(i + 1) * j.charge.unit === 1 ? '' : 's'}` : ''}</option>`).join('')}</select></div>
        <button class="btn primary" data-act="approve" data-n="${s.n}">Looks right · make the video</button>
        <details><summary class="note" style="cursor:pointer">Try other words</summary>
          <textarea class="field" id="relook" rows="2" style="margin-top:8px">${esc(j.look)}</textarea>
          <button class="btn ghost sm" data-act="redo" style="margin-top:8px">New first frame</button></details></div>`;
    }
    if (j.status === 'done') {
      const best = j.candidates.find((c) => c.n === j.best);
      const ring = ringHtml(j, best);
      const b = j.billing;
      const paidUnits = j.charge ? b?.charged * j.charge.unit : null;
      const billLine = b && (j.provider !== 'mock' || j.charge)
        ? `<p class="note" style="margin:10px 0 0">${j.byok ? 'Made on your own Higgsfield key' : paidUnits != null ? `Used ${paidUnits} video${paidUnits === 1 ? '' : 's'}${j.watermark ? ' (free trial: watermarked)' : ''}` : `Charged for ${b.charged} of ${b.videos} version${b.videos > 1 ? 's' : ''}`}${b.free ? ` · ${b.free} version${b.free > 1 ? 's' : ''} free (under ${b.freeBelow}% move match)` : ''}${b.apiUsd != null ? ` · AI cost ≈ ${usd(b.apiUsd)}` : ''}</p>` : '';
      const retry = b?.tryAgain
        ? `<div class="warn-box" style="margin:12px 0 0"><b>It didn’t follow your move</b> (under ${b.freeBelow}%), so it isn’t charged.
            <div style="margin-top:8px"><button class="btn primary sm" data-act="again">Try again</button></div></div>` : '';
      html += `<div class="result-card" style="margin-top:12px">
        <video src="/api/make/${j.id}/media/${best.file}" muted loop playsinline autoplay></video>
        <div style="display:flex;flex-direction:column;gap:8px">${ring}<span class="note">${esc(verdictText(j, best))}</span></div></div>
        ${retry}<div class="actions" style="margin-top:12px"><button class="btn ${b?.tryAgain ? 'ghost' : 'primary'}" data-act="open">Open result</button><button class="btn ghost" data-act="new">New video</button></div>${billLine}`;
    }
    if (j.status === 'failed') {
      html += `<p class="warn-box" style="margin:10px 0 0">${esc(j.error)}</p><button class="btn ghost" data-act="new" style="margin-top:10px">Start over</button>`;
    }
    box.innerHTML = html;
    box.querySelector('[data-act=approve]')?.addEventListener('click', async (e) => { try { show((await post(j.id, 'approve', { n: Number(e.target.dataset.n), versions: Number($('approveVersions')?.value) || undefined })).job); } catch (x) { toast(x.message, 5000); } });
    box.querySelector('[data-act=redo]')?.addEventListener('click', async () => { show((await post(j.id, 'redo-start', { look: $('relook').value })).job); });
    box.querySelector('[data-act=open]')?.addEventListener('click', () => openResult(j));
    box.querySelector('[data-act=again]')?.addEventListener('click', async () => { try { show((await post(j.id, 'more')).job); } catch (e) { toast(e.message, 5000); } });
    for (const b of box.querySelectorAll('[data-act=new]')) b.addEventListener('click', showForm);
    const i = jobs.findIndex((x) => x.id === j.id);
    if (i >= 0) jobs[i] = j; else { jobs.unshift(j); onJobs(); }
    if (j.status === 'done' && was && was !== 'done') { onDone(); onJobs(); openResult(j); }
    if (was && j.status !== was && ['needs_approval', 'done', 'failed'].includes(j.status)) showPane('make'); // it needs you, or it's finished
    poll();
  }

  // ---- result: your move and the AI video, side by side ----
  function openResult(j, n = j.best) {
    const m = $('resultModal');
    const c = j.candidates.find((x) => x.n === n);
    const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
    m.innerHTML = `<div class="card modal-card">
      <div class="modal-head">${ringHtml(j, c, 76)}<div class="grow"><span class="eyebrow">Version ${c.n} of ${j.candidates.filter((x) => x.file).length}${n === j.best ? ' · kept' : ''}</span>
        <h2 id="resultTitle">${esc(titleText(j, c))}</h2><p class="muted" style="margin:6px 0 0">${esc(verdictText(j, c))}</p></div>
        <button class="btn quiet icon" data-act="close" aria-label="Close">✕</button></div>
      <div class="compare">
        <figure><video id="rv0" src="/api/make/${j.id}/media/reference.mp4" muted loop playsinline></video><figcaption><span class="eyebrow">Your move</span><span class="badge">grey reference</span></figcaption></figure>
        <figure><video id="rv1" src="/api/make/${j.id}/media/${c.file}" muted loop playsinline></video><figcaption><span class="eyebrow">AI video</span><span class="badge accent">${j.demo && j.provider === 'mock' ? 'Example result · Seedance 2.5' : esc(j.recipe?.label || '')}${j.resolution ? ` · ${esc(j.resolution)}` : ''}</span></figcaption></figure>
      </div>
      <div class="row wrap"><button class="btn light" data-act="play">▶ Play both</button><span class="grow"></span></div>
      ${c.score ? `<div class="why"><div><b>${c.score.timing_offset_s == null ? '—' : `${c.score.timing_offset_s > 0 ? '+' : ''}${c.score.timing_offset_s.toFixed(2)} s`}</b><span>Timing vs your take</span></div>
        <div><b>${pct(c.score.turn_corr)}</b><span>Turns that match yours</span></div><div><b>${pct(c.score.walk_ratio)}</b><span>Of your walking distance</span></div></div>` : ''}
      <div class="row wrap"><div class="versions grow">${j.candidates.filter((x) => x.file).map((x) => `<button class="version${x.n === c.n ? ' sel' : ''}" data-v="${x.n}">${x.verdict?.pass ? '✓' : x.verdict?.pass === false ? '⚠' : '·'} V${x.n}${x.match != null ? ` · ${x.match}%` : ''}${x.free ? ' · free' : ''}</button>`).join('')}</div>
        <button class="btn ghost" data-act="more">Make another version</button>
        ${c.preview ? '<span class="note">Free version: watch only.</span>' : `<a class="btn primary" href="/api/make/${j.id}/media/${c.file}" download="cinehand-${j.id}-v${c.n}.mp4">Download</a>`}</div>
      ${c.preview ? '' : lockBoxHtml(j, c)}
    </div>`;
    m.hidden = false;
    const [a, b] = [m.querySelector('#rv0'), m.querySelector('#rv1')];
    let raf = 0;
    const sync = () => { if (Math.abs(b.currentTime - a.currentTime) > 0.06) b.currentTime = a.currentTime; raf = requestAnimationFrame(sync); };
    const close = () => { cancelAnimationFrame(raf); m.hidden = true; m.innerHTML = ''; };
    m.querySelector('[data-act=close]').onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
    addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); removeEventListener('keydown', esc); } });
    m.querySelector('[data-act=play]').onclick = (e) => {
      if (a.paused) { b.currentTime = a.currentTime = 0; a.play(); b.play(); sync(); e.target.textContent = '❚❚ Pause'; }
      else { a.pause(); b.pause(); cancelAnimationFrame(raf); e.target.textContent = '▶ Play both'; }
    };
    for (const v of m.querySelectorAll('[data-v]')) v.onclick = () => { close(); openResult(j, Number(v.dataset.v)); };
    m.querySelector('[data-act=more]').onclick = async () => { close(); try { show((await post(j.id, 'more')).job); } catch (e) { toast(e.message, 5000); } };
    if (!c.preview) wireLockBox(m, j, c, (fresh) => { close(); openResult(fresh, n); });
  }

  // ---- logo lock: the brand's exact logo on the product, in every frame (server/logolock.py) ----
  function lockBoxHtml(j, c) {
    const l = j.locks?.[c.n];
    let body;
    if (!j.hasLogo) body = `<label class="btn ghost sm">Add your logo (PNG or SVG)<input type="file" data-act="logofile" accept="image/png,image/svg+xml,.svg,.png" hidden></label><button class="btn quiet sm" data-act="mylogo" hidden>Use my last logo</button>`;
    else if (l?.status === 'working') body = '<span class="note"><span class="spinner"></span> Locking your logo onto every frame… about a minute.</span>';
    else if (l?.status === 'done') body = `<div class="seg" role="group" aria-label="Show"><button class="seg-b sel" data-act="showlock">With your logo</button><button class="seg-b" data-act="showai">AI video</button></div>
        <a class="btn primary sm" href="/api/make/${j.id}/media/${l.file}" download="cinehand-${j.id}-v${c.n}-logo.mp4">Download with logo</a>
        <button class="btn quiet sm" data-act="place">Place again</button>
        <span class="note">${l.oldLogo ? 'You changed the logo since: place it again to update. ' : ''}${l.locked < 0.9 ? `Hidden in ${Math.round((1 - l.locked) * 100)}% of the frames, where the product left the picture or changed too much to follow.` : 'Held in every frame.'}</span>`;
    else body = `${l?.status === 'failed' ? `<span class="warn-box">${esc(l.error)}</span>` : ''}<button class="btn primary sm" data-act="place">Place your logo</button>
        <label class="btn quiet sm">Change logo<input type="file" data-act="logofile" accept="image/png,image/svg+xml,.svg,.png" hidden></label>`;
    return `<div class="lock-box"><div><b>Logo lock</b> <span class="muted small">Your exact logo, in every frame.</span></div><div class="row wrap">${body}</div></div>`;
  }

  function wireLockBox(m, j, c, reopen) {
    const l = j.locks?.[c.n];
    const upload = async (logo) => {
      const r = await fetch(`/api/make/${j.id}/logo`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: blobOf(logo.dataUrl) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'Could not add the logo.');
      return out.job;
    };
    for (const inp of m.querySelectorAll('[data-act=logofile]')) inp.onchange = async (e) => {
      const f = e.target.files?.[0]; e.target.value = '';
      if (!f) return;
      try {
        const logo = await logoToPng(f);
        const fresh = await upload(logo);
        setLogo('__brand', { dataUrl: logo.dataUrl, width: logo.width, height: logo.height, name: f.name, at: Date.now() }).catch(() => {}); // next time: one tap
        placeLogo(fresh, c, reopen);
      } catch (x) { toast(x.message, 5000); }
    };
    const mine = m.querySelector('[data-act=mylogo]');
    if (mine) getKit('__brand').then((k) => {
      if (!k.logo) return;
      mine.hidden = false;
      mine.onclick = async () => { try { placeLogo(await upload(k.logo), c, reopen); } catch (x) { toast(x.message, 5000); } };
    });
    m.querySelector('[data-act=place]')?.addEventListener('click', () => placeLogo(j, c, reopen));
    const v = m.querySelector('#rv1');
    if (l?.status === 'done' && v) {
      const src = (file) => { const t = v.currentTime, playing = !v.paused; v.src = `/api/make/${j.id}/media/${file}`; v.currentTime = t; if (playing) v.play(); };
      const [a, b] = [m.querySelector('[data-act=showlock]'), m.querySelector('[data-act=showai]')];
      a.onclick = () => { src(l.file); a.classList.add('sel'); b.classList.remove('sel'); };
      b.onclick = () => { src(c.file); b.classList.add('sel'); a.classList.remove('sel'); };
      src(l.file);
    }
    if (l?.status === 'working') { // check back until it's done
      const t = setInterval(async () => {
        if (m.hidden) return clearInterval(t);
        try {
          const fresh = (await (await fetch(`/api/make/${j.id}`)).json()).job;
          if (fresh.locks?.[c.n]?.status !== 'working') { clearInterval(t); reopen(fresh); }
        } catch {}
      }, 3000);
    }
  }

  /** Place the logo on the first frame: drag it, pull its four corners onto the product's surface, then lock. */
  async function placeLogo(j, c, reopen) {
    const m = $('resultModal');
    const prev = j.locks?.[c.n]?.quad;
    m.innerHTML = `<div class="card modal-card">
      <div class="modal-head"><div class="grow"><span class="eyebrow">Logo lock · version ${c.n}</span><h2>Put your logo on the product</h2>
        <p class="muted" style="margin:6px 0 0">Drag the logo onto the product, then pull its corners so it lies flat.</p></div>
        <button class="btn quiet icon" data-act="close" aria-label="Close">✕</button></div>
      <div class="place-stage" id="placeStage"><img class="place-frame" id="placeFrame" src="/api/make/${j.id}/media/frame-${c.n}.jpg" alt="First frame"><img class="place-logo" id="placeLogo" src="/api/make/${j.id}/media/logo.png?${Date.now()}" alt="Your logo"><svg class="place-svg" id="placeSvg"><polygon id="placePoly"></polygon></svg></div>
      <div class="row wrap"><label class="small"><input type="checkbox" id="placeCover" checked> Paint over the AI’s own logo underneath</label><span class="grow"></span>
        <label class="btn quiet sm">Change logo<input type="file" id="placeLogoFile" accept="image/png,image/svg+xml,.svg,.png" hidden></label>
        <button class="btn ghost" data-act="back">Back</button><button class="btn primary" data-act="lock">Lock logo</button></div>
    </div>`;
    m.hidden = false;
    m.querySelector('[data-act=close]').onclick = () => { m.hidden = true; m.innerHTML = ''; };
    m.querySelector('[data-act=back]').onclick = () => reopen(j);
    $('placeLogoFile').onchange = async (e) => { // a different logo: same place, new picture
      const f = e.target.files?.[0]; e.target.value = '';
      if (!f) return;
      try {
        const lg = await logoToPng(f);
        const r = await fetch(`/api/make/${j.id}/logo`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: blobOf(lg.dataUrl) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Could not add the logo.');
        setLogo('__brand', { dataUrl: lg.dataUrl, width: lg.width, height: lg.height, name: f.name, at: Date.now() }).catch(() => {});
        j = out.job;
        logo.src = `/api/make/${j.id}/media/logo.png?${Date.now()}`;
        logo.onload = () => { la = (logo.naturalHeight || 1) / (logo.naturalWidth || 1); draw(); };
      } catch (x) { toast(x.message, 5000); }
    };
    const stage = $('placeStage'), frame = $('placeFrame'), logo = $('placeLogo'), svg = $('placeSvg'), poly = $('placePoly');
    await Promise.all([frame, logo].map((im) => (im.complete && im.naturalWidth ? null : new Promise((r) => { im.onload = r; im.onerror = r; }))));
    const fw = frame.naturalWidth || 1, fh = frame.naturalHeight || 1;
    let la = (logo.naturalHeight || 1) / (logo.naturalWidth || 1);
    // corners in frame fractions: last placement, else where the logo is recognised, else the middle
    let q = prev;
    if (!q) {
      try { q = (await (await fetch(`/api/make/${j.id}/lock-find`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: c.n }) })).json()).quad; } catch {}
    }
    if (!q) { const w = 0.22, h = (w * fw * la) / fh; q = [[0.5 - w / 2, 0.5 - h / 2], [0.5 + w / 2, 0.5 - h / 2], [0.5 + w / 2, 0.5 + h / 2], [0.5 - w / 2, 0.5 + h / 2]]; }
    const handles = q.map((_, i) => { const d = document.createElement('div'); d.className = 'place-handle'; d.dataset.i = i; stage.append(d); return d; });
    function draw() {
      const W = frame.clientWidth, H = frame.clientHeight, px = q.map(([x, y]) => [x * W, y * H]);
      logo.style.width = '100px'; logo.style.height = `${100 * la}px`;
      logo.style.transform = quadTransform(100, 100 * la, px);
      handles.forEach((h, i) => { h.style.left = `${px[i][0]}px`; h.style.top = `${px[i][1]}px`; });
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.width = `${W}px`; svg.style.height = `${H}px`;
      poly.setAttribute('points', px.map((p) => p.join(',')).join(' '));
    }
    let drag = null;
    const at = (e) => { const r = frame.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    stage.onpointerdown = (e) => {
      const i = e.target.dataset?.i;
      if (i == null && e.target !== poly) return;
      drag = { i: i == null ? null : Number(i), from: at(e), q0: q.map((p) => [...p]) };
      stage.setPointerCapture(e.pointerId); e.preventDefault();
    };
    stage.onpointermove = (e) => {
      if (!drag) return;
      const [x, y] = at(e), dx = x - drag.from[0], dy = y - drag.from[1];
      const next = drag.q0.map((p, k) => (drag.i == null || drag.i === k ? [p[0] + dx, p[1] + dy] : p));
      if (convex(next)) { q = next; draw(); }
    };
    stage.onpointerup = stage.onpointercancel = () => { drag = null; };
    new ResizeObserver(draw).observe(frame);
    draw();
    m.querySelector('[data-act=lock]').onclick = async (e) => {
      e.target.disabled = true;
      try { reopen((await post(j.id, 'lock', { n: c.n, quad: q, cover: $('placeCover').checked ? 'auto' : 'off' })).job); }
      catch (x) { toast(x.message, 5000); e.target.disabled = false; }
    };
  }

  /** Is the quad convex and the right way round (no bow ties)? */
  function convex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [a, b, c] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (!cr || (sign && Math.sign(cr) !== sign)) return false;
      sign = Math.sign(cr);
    }
    return true;
  }
  /** CSS matrix3d that maps a w×h box onto four corners (TL, TR, BR, BL) in pixels: the logo, in perspective. */
  function quadTransform(w, h, [[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
    const A = [], b = [];
    for (const [[u, v], [x, y]] of [[[0, 0], [x0, y0]], [[w, 0], [x1, y1]], [[w, h], [x2, y2]], [[0, h], [x3, y3]]]) {
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    for (let i = 0; i < 8; i++) { // Gaussian elimination with pivoting
      let p = i; for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = 0; r < 8; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let k = i; k < 8; k++) A[r][k] -= f * A[i][k]; b[r] -= f * b[i]; }
    }
    const [a, bb, c, d, e, f, g, hh] = b.map((v, i) => v / A[i][i]);
    return `matrix3d(${[a, d, 0, g, bb, e, 0, hh, 0, 0, 1, 0, c, f, 0, 1].join(',')})`;
  }

  function ringHtml(j, c, size = 64) {
    const unchecked = j.outcome === 'unchecked' || c?.match == null;
    const cls = unchecked ? 'none' : c.verdict?.pass ? '' : 'warn';
    return `<div class="ring ${cls}" style="--p:${unchecked ? 0 : c.match};width:${size}px;height:${size}px" title="Move match: the camera’s turns, timing and walking in the AI video, measured against your take"><b>${unchecked ? '–' : `${c.match}%`}</b></div>`;
  }
  function titleText(j, c) {
    if (j.outcome === 'unchecked' || !c.verdict || c.verdict.pass === null) return 'Your video is ready';
    return c.verdict.pass ? 'It follows your move' : 'Closest version';
  }
  function verdictText(j, c) {
    if (!c) return '';
    if (j.outcome === 'unchecked' || c.verdict?.pass === null) return `Not checked: ${c.verdict?.reasons?.[0] || j.checkError || 'no scorer on this computer'}.`;
    if (c.verdict?.pass) return `Move match ${c.match}%. Timing, turns and walking line up with your take.`;
    return `Move match ${c.match}%: ${c.verdict?.reasons?.join(', ') || 'not close enough'}. Make another version or keep this one.`;
  }

  return {
    onTake(take) {
      if (take?.demo && !$('look').value) $('look').value = DEMO_LOOK;
      const j = take && latestFor(take.id);
      if (j) show(j); // this take already has a video (or one on the way): show it
      else if (job && job.take?.id !== take?.id) showForm();
      else costLine();
    },
    /** Has a finished video been made from this take? For the badge in the takes list. */
    hasVideo: (takeId) => jobs.some((j) => j.take?.id === takeId && j.status === 'done'),
    reload: () => loadConfig().then(() => loadJobs()),
  };
}
