// Make video panel: look → (render grey move + measuring twin) → server job → approve first frame → result.
// The server does the AI work and the checking (server/make). This file only renders and uploads.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE = new Set(['uploading', 'preparing', 'start_image', 'making', 'checking']);
const DEMO_LOOK = 'Wet parking lot at night, orange sodium street light, a man in a grey hoodie by the cars, shot on an old phone';

export function setupMake({ getTake, takeScene, toast, onDone }) {
  const form = $('makeForm'), box = $('makeJob'), btn = $('makeBtn'), sel = $('recipe');
  let recipes = [], job = null, timer = null, blocked = null;

  const recipe = () => recipes.find((r) => r.id === sel.value);
  function costLine() {
    const r = recipe(), take = getTake();
    if (blocked) { $('costText').textContent = blocked; $('costEta').textContent = ''; btn.disabled = true; return; }
    if (!take) { $('costText').textContent = 'Pick a take first'; $('costEta').textContent = ''; btn.disabled = true; return; }
    if (!r) return;
    const free = r.provider === 'mock';
    const per = (r.cost?.startImage ?? 0) + r.candidates * (r.cost?.video ?? 0);
    $('costText').textContent = free ? 'Practice · free · no AI' : `≈ ${per} credits · ${r.candidates} versions, best one kept`;
    $('costEta').textContent = free ? '≈ 20 s' : '≈ 3–5 min';
    $('recipeStatus').hidden = r.status === 'final';
    $('recipeStatus').textContent = r.status;
    btn.disabled = !r.ready;
  }
  sel.onchange = costLine;

  fetch('/api/make/config').then(async (res) => {
    if (res.status === 403) { blocked = 'Open the studio at localhost on the laptop to make videos'; return costLine(); }
    ({ recipes } = await res.json());
    sel.innerHTML = '';
    for (const r of recipes) {
      const o = new Option(`${r.label}${r.ready ? '' : ' · needs setup'}${r.status === 'draft' ? ' · draft recipe' : ''}`, r.id);
      o.disabled = !r.ready;
      sel.append(o);
    }
    sel.value = (recipes.find((r) => r.ready && r.provider !== 'mock') || recipes.find((r) => r.ready))?.id || '';
    costLine();
    const last = (await (await fetch('/api/make')).json()).jobs[0]; // carry on after a page reload
    if (last && (ACTIVE.has(last.status) || last.status === 'needs_approval')) show(last);
  }).catch(() => { blocked = 'Make video is unavailable'; costLine(); });

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
      const res = await fetch('/api/make', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ take: cleanTake, scene, look, recipeId: r.id, demo: !!take.demo }) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      const files = { 'reference.mp4': ref.mp4, 'measure.mp4': twin.mp4, 'first-frame.png': ref.png };
      let i = 0;
      for (const [name, blob] of Object.entries(files)) {
        step(`Uploading ${++i}/3…`);
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
    if (!r.ok) throw new Error(out.error);
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
  const STEPS = [['Preparing your move', ['uploading', 'preparing']], ['First frame', ['start_image']], ['Your OK', ['needs_approval']], ['Making the video', ['making']], ['Checking it follows your move', ['checking']], ['Done', ['done']]];
  function show(j) {
    const was = job?.status;
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
        <p class="note">This is the first frame. Same layout as your set? Then make the video.</p>
        <button class="btn primary" data-act="approve" data-n="${s.n}">Looks right · make the video</button>
        <details><summary class="note" style="cursor:pointer">Try other words for the look</summary>
          <textarea class="field" id="relook" rows="2" style="margin-top:8px">${esc(j.look)}</textarea>
          <button class="btn ghost sm" data-act="redo" style="margin-top:8px">New first frame</button></details></div>`;
    }
    if (j.status === 'done') {
      const best = j.candidates.find((c) => c.n === j.best);
      const ring = ringHtml(j, best);
      html += `<div class="result-card" style="margin-top:12px">
        <video src="/api/make/${j.id}/media/${best.file}" muted loop playsinline autoplay></video>
        <div style="display:flex;flex-direction:column;gap:8px">${ring}<span class="note">${esc(verdictText(j, best))}</span></div></div>
        <div class="actions" style="margin-top:12px"><button class="btn primary" data-act="open">Open result</button><button class="btn ghost" data-act="new">New video</button></div>`;
    }
    if (j.status === 'failed') {
      html += `<p class="warn-box" style="margin:10px 0 0">${esc(j.error)}</p><button class="btn ghost" data-act="new" style="margin-top:10px">Start over</button>`;
    }
    box.innerHTML = html;
    box.querySelector('[data-act=approve]')?.addEventListener('click', async (e) => { show((await post(j.id, 'approve', { n: Number(e.target.dataset.n) })).job); });
    box.querySelector('[data-act=redo]')?.addEventListener('click', async () => { show((await post(j.id, 'redo-start', { look: $('relook').value })).job); });
    box.querySelector('[data-act=open]')?.addEventListener('click', () => openResult(j));
    for (const b of box.querySelectorAll('[data-act=new]')) b.addEventListener('click', () => { job = null; box.hidden = true; form.hidden = false; costLine(); });
    if (j.status === 'done' && was && was !== 'done') { onDone(); openResult(j); }
    if (j.status !== was) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        <figure><video id="rv1" src="/api/make/${j.id}/media/${c.file}" muted loop playsinline></video><figcaption><span class="eyebrow">AI video</span><span class="badge accent">${j.demo && j.provider === 'mock' ? 'Example result · Seedance 2.5' : esc(j.recipe?.label || '')}</span></figcaption></figure>
      </div>
      <div class="row wrap"><button class="btn light" data-act="play">▶ Play both</button><span class="muted small grow">Both play in sync, so you can see the camera do what your hand did.</span></div>
      ${c.score ? `<div class="why"><div><b>${c.score.timing_offset_s == null ? '—' : `${c.score.timing_offset_s > 0 ? '+' : ''}${c.score.timing_offset_s.toFixed(2)} s`}</b><span>Timing vs your take</span></div>
        <div><b>${pct(c.score.turn_corr)}</b><span>Turns that match yours</span></div><div><b>${pct(c.score.walk_ratio)}</b><span>Of your walking distance</span></div></div>` : ''}
      <div class="row wrap"><div class="versions grow">${j.candidates.filter((x) => x.file).map((x) => `<button class="version${x.n === c.n ? ' sel' : ''}" data-v="${x.n}">${x.verdict?.pass ? '✓' : x.verdict?.pass === false ? '⚠' : '·'} V${x.n}${x.match != null ? ` · ${x.match}%` : ''}</button>`).join('')}</div>
        <button class="btn ghost" data-act="more">Make another version</button>
        <a class="btn primary" href="/api/make/${j.id}/media/${c.file}" download="handcam-${j.id}-v${c.n}.mp4">Download</a></div>
      <p class="note">Move match compares the camera’s turns, timing and walking in the AI video with your take. It’s measured, not guessed: the score is the same every time for the same video.</p>
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
    m.querySelector('[data-act=more]').onclick = async () => { close(); try { show((await post(j.id, 'more')).job); } catch (e) { toast(e.message); } };
  }

  function ringHtml(j, c, size = 64) {
    const unchecked = j.outcome === 'unchecked' || c?.match == null;
    const cls = unchecked ? 'none' : c.verdict?.pass ? '' : 'warn';
    return `<div class="ring ${cls}" style="--p:${unchecked ? 0 : c.match};width:${size}px;height:${size}px" title="Move match"><b>${unchecked ? '–' : `${c.match}%`}</b></div>`;
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
      costLine();
    },
  };
}
