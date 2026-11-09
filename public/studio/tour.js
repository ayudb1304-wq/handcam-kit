// First-run tour: a welcome card, then a spotlight on each part of the studio. Esc closes, ← → move.
const KEY = 'handcam.tour.seen.v1';
const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const remember = () => { try { localStorage.setItem(KEY, '1'); } catch {} };

const STEPS = [
  { sel: '[data-tour=set]', title: 'Describe the set', text: 'One sentence becomes a grey blockout: boxes for cars and walls, stick figures for people. It’s rough on purpose: it only has to put things in the right places.' },
  { sel: '[data-tour=stage]', title: 'This is your set', text: 'Drag to look around. When your phone is connected, the white outline is your phone, moving live as you hold it.' },
  { sel: '[data-tour=phone]', title: 'Your phone is the camera', text: 'Scan the code with your phone (iPhone or Android). Turn it to look around, use the joysticks to walk. Tap ● and move like a real camera operator. Wobbles welcome.' },
  { sel: '[data-tour=takes]', title: 'Takes, not edits', text: 'Every take lands here with a little curve of your move. Don’t like it? Shoot it again, like on a real set. Nothing is ever smoothed.' },
  { sel: '[data-tour=player]', title: 'Replay the exact move', text: 'Press play or scrub. The orange outline replays your hand frame by frame, and the corner shows what the camera saw.', needsTake: true },
  { sel: '[data-tour=make]', title: 'Make it real', text: 'Describe the look and press Make video. You approve the first frame, then we make versions and check each one moves like your take. You keep the best.' },
];

export function setupTour({ loadDemo }) {
  let i = 0, els = null;

  function welcome() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="card welcome rise" role="dialog" aria-modal="true" aria-labelledby="wTitle">
      <div class="art"><img src="/assets/obj-viewfinder.webp" alt=""><img src="/assets/obj-phone.webp" alt="" onerror="this.src='/assets/obj-camera.webp'"><img src="/assets/obj-clapper.webp" alt=""></div>
      <div class="body"><span class="eyebrow">Welcome to CineHand Studio</span>
        <h2 id="wTitle">Your hand is the camera.<br>The AI follows.</h2>
        <p>Describe a set, shoot the move with your phone, and turn it into a real video that moves exactly like you did. Here’s the studio in 60 seconds.</p>
        <div class="row" style="margin-top:6px"><button class="btn primary lg" data-a="go">Show me around</button><button class="btn quiet" data-a="skip">Skip for now</button></div></div></div>`;
    document.body.append(m);
    const done = (go) => { m.remove(); remember(); if (go) start(true); };
    m.querySelector('[data-a=go]').onclick = () => done(true);
    m.querySelector('[data-a=skip]').onclick = () => done(false);
    m.querySelector('[data-a=go]').focus();
  }

  async function start(skipWelcome) {
    if (!skipWelcome) return welcome();
    close();
    i = 0;
    els = {
      veil: Object.assign(document.createElement('div'), { className: 'tour-veil' }),
      hole: Object.assign(document.createElement('div'), { className: 'tour-hole' }),
      tip: Object.assign(document.createElement('div'), { className: 'card tour-tip' }),
    };
    els.veil.onclick = () => next(1);
    document.body.append(els.veil, els.hole, els.tip);
    addEventListener('keydown', keys);
    addEventListener('resize', place);
    await show();
  }
  function close() {
    if (!els) return;
    for (const e of Object.values(els)) e.remove();
    els = null;
    removeEventListener('keydown', keys);
    removeEventListener('resize', place);
  }
  function keys(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') next(1);
    if (e.key === 'ArrowLeft') next(-1);
  }
  async function next(d) {
    i += d;
    if (i < 0) i = 0;
    if (i >= STEPS.length) return finish();
    await show();
  }
  async function show() {
    const s = STEPS[i];
    if (s.needsTake && document.querySelector(s.sel)?.hidden) await loadDemo();
    els.tip.innerHTML = `<span class="eyebrow">Step ${i + 1} of ${STEPS.length}</span><h4>${s.title}</h4><p>${s.text}</p>
      <div class="row"><div class="tour-dots grow">${STEPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      ${i ? '<button class="btn quiet sm" data-a="back">Back</button>' : '<button class="btn quiet sm" data-a="end">Skip</button>'}
      <button class="btn primary sm" data-a="next">${i === STEPS.length - 1 ? 'Finish' : 'Next'}</button></div>`;
    els.tip.querySelector('[data-a=next]').onclick = () => next(1);
    els.tip.querySelector('[data-a=back]')?.addEventListener('click', () => next(-1));
    els.tip.querySelector('[data-a=end]')?.addEventListener('click', close);
    place();
    els.tip.querySelector('[data-a=next]').focus();
  }
  function place() {
    if (!els) return;
    const t = document.querySelector(STEPS[i].sel);
    if (!t) return;
    t.scrollIntoView({ block: 'nearest' });
    const r = t.getBoundingClientRect(), pad = 8;
    Object.assign(els.hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const tw = 340, th = els.tip.offsetHeight || 200, gap = 18, vw = innerWidth, vh = innerHeight;
    let left = r.right + gap, top = r.top;
    if (left + tw > vw - 12) left = r.left - tw - gap;            // no room on the right: go left
    if (left < 12) { left = Math.min(Math.max(12, r.left), vw - tw - 12); top = r.bottom + gap; } // nor left: go below
    if (top + th > vh - 12) top = Math.max(12, r.top - th - gap);  // nor below: go above
    if (r.height > vh * 0.6 && left >= 12) top = Math.min(Math.max(12, r.top + 24), vh - th - 12);
    Object.assign(els.tip.style, { left: `${left}px`, top: `${Math.max(12, top)}px` });
  }
  function finish() {
    close();
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="card welcome rise"><div class="art"><img src="/assets/obj-reel.webp" alt="" onerror="this.src='/assets/obj-clapper.webp'"><img src="/assets/obj-lens.webp" alt=""><img src="/assets/obj-camera.webp" alt="" onerror="this.src='/assets/obj-viewfinder.webp'"></div>
      <div class="body"><span class="eyebrow">You’re ready</span><h2>Try it with the demo take</h2>
      <p>It’s a real move with a real AI result. Press <b>Make video</b> in practice mode: no phone, no credits, about 20 seconds.</p>
      <div class="row"><button class="btn primary lg" data-a="demo">Load the demo take</button><button class="btn quiet" data-a="x">Close</button></div></div></div>`;
    document.body.append(m);
    m.querySelector('[data-a=demo]').onclick = async () => { m.remove(); await loadDemo(); document.querySelector('[data-tour=make]').scrollIntoView({ block: 'center' }); document.getElementById('look')?.focus(); };
    m.querySelector('[data-a=x]').onclick = () => m.remove();
  }

  return { start: () => start(false), maybeAutoStart: (force) => { if (force || !seen()) welcome(); } };
}
