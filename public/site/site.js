// HandCam landing page motion: nav, hero tilt, scroll-lit words, floating objects, reveals, chart, ring,
// pricing toggle, FAQ. No libraries. Everything degrades to a static page with reduced motion or no JS.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // Nav gets solid once you scroll
  const nav = $('#nav');
  const onScrollNav = () => nav.classList.toggle('scrolled', scrollY > 24);

  // Studio product frame: tilted back, flattens as it scrolls into view
  const browser = $('#browser');
  const onScrollTilt = () => {
    if (!browser) return;
    const r = browser.getBoundingClientRect();
    browser.style.setProperty('--tilt', `${Math.max(0, Math.min(10, (r.top - innerHeight * 0.25) / innerHeight * 16)).toFixed(2)}deg`);
  };

  // "Why" paragraph: words light up as it scrolls through the screen
  const why = $('#whyText');
  if (why) for (const p of why.querySelectorAll('p')) p.innerHTML = p.textContent.split(' ').map((w) => `<span class="w">${w}</span>`).join(' ');
  const words = why ? $$('.w', why) : [];
  const onScrollWords = () => {
    if (!why) return;
    const r = why.getBoundingClientRect(), vh = innerHeight;
    const t = Math.min(1, Math.max(0, (vh * 0.85 - r.top) / (r.height + vh * 0.35)));
    const lit = Math.round(t * words.length);
    words.forEach((w, i) => w.classList.toggle('on', i < lit));
  };

  // Floating objects drift at different speeds
  const objs = $$('.obj');
  const onScrollObjs = () => {
    if (innerWidth <= 980) { for (const o of objs) o.style.transform = ''; return; } // small screens: objects sit still at the edges
    for (const o of objs) {
      const r = o.parentElement.getBoundingClientRect();
      const y = (r.top + r.height / 2 - innerHeight / 2) * Number(o.dataset.speed || 0);
      o.style.transform = `translateY(${y.toFixed(1)}px)`;
    }
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { onScrollNav(); if (!reduce) { onScrollTilt(); onScrollObjs(); } onScrollWords(); ticking = false; });
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  onScroll();
  if (reduce) words.forEach((w) => w.classList.add('on'));

  // Reveal on scroll (+ draws the chart)
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
  for (const el of $$('[data-reveal], #chart')) io.observe(el);

  // Move match ring counts up once the hero has settled
  const ring = $('#ring'), n = $('#ringN');
  if (ring) {
    const target = 91, t0 = performance.now() + (reduce ? 0 : 900), dur = reduce ? 1 : 1400;
    const tick = (t) => {
      const k = Math.min(1, Math.max(0, (t - t0) / dur)), e = 1 - Math.pow(1 - k, 3);
      const v = Math.round(target * e);
      ring.style.setProperty('--p', v); n.textContent = v;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Pricing: monthly / yearly
  const toggle = $('#toggle');
  if (toggle) {
    const knob = $('.knob', toggle), btns = $$('button', toggle);
    const set = (b) => {
      btns.forEach((x) => x.classList.toggle('on', x === b));
      knob.style.left = `${b.offsetLeft}px`; knob.style.width = `${b.offsetWidth}px`;
      const key = b.dataset.b;
      for (const el of $$('[data-m]')) el.textContent = el.dataset[key];
    };
    btns.forEach((b) => b.addEventListener('click', () => set(b)));
    document.fonts?.ready.then(() => set(btns.find((b) => b.classList.contains('on'))));
    set(btns[0]);
  }

  // FAQ accordion
  for (const q of $$('.q')) {
    const b = $('button', q);
    b.addEventListener('click', () => {
      const open = !q.classList.contains('open');
      q.classList.toggle('open', open);
      b.setAttribute('aria-expanded', String(open));
    });
  }

  // ---- Live video -----------------------------------------------------------------------------
  // Two videos in lockstep: the AI video leads, the grey move follows (same move, same length).
  function lockstep(lead, follow, onFrame) {
    let raf = 0;
    const tick = () => {
      if (follow.readyState >= 2 && Math.abs(follow.currentTime - lead.currentTime) > 0.08) follow.currentTime = Math.min(lead.currentTime, (follow.duration || 9e9) - 0.02);
      if (onFrame) onFrame(lead.currentTime / (lead.duration || 1));
      raf = requestAnimationFrame(tick);
    };
    return {
      async play() {
        lead.loop = follow.loop = true;
        try { await Promise.all([lead.play(), follow.play()]); cancelAnimationFrame(raf); tick(); return true; }
        catch { return false; } // autoplay blocked (e.g. iPhone Low Power Mode): the caller shows a play button
      },
      pause() { lead.pause(); follow.pause(); cancelAnimationFrame(raf); },
    };
  }

  // Hero reel: plays right away, muted, inline, looping. Pauses when off screen to save battery.
  const reel = $('#heroReel');
  if (reel) {
    const [move, ai] = $$('video', reel);
    const head = $('#rcHead'), W = 600;
    const pair = lockstep(ai, move, (f) => { const x = (f * W).toFixed(1); head.setAttribute('x1', x); head.setAttribute('x2', x); });
    const btn = $('#rcPlay');
    let blocked = reduce;
    const start = async () => { blocked = !(await pair.play()); btn.hidden = !blocked; };
    btn.addEventListener('click', start);
    if (reduce) btn.hidden = false; else start();
    new IntersectionObserver(([e]) => { if (blocked) return; if (e.isIntersecting) pair.play(); else pair.pause(); }, { threshold: 0.15 }).observe(reel);
  }

  // Gallery: cards from /showcase/examples.json; drag across a card to wipe between the move and the AI video
  const track = $('#gallery');
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const card = (x) => `
    <article class="ex" data-reveal>
      <div class="ex-media" role="slider" tabindex="0" aria-label="${esc(x.title)}: drag to compare your move and the AI video" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
        <video class="ex-ai" muted playsinline loop preload="none" poster="${esc(x.aiPoster)}" src="${esc(x.ai)}"></video>
        <video class="ex-move" muted playsinline loop preload="none" poster="${esc(x.movePoster)}" src="${esc(x.move)}"></video>
        <span class="ex-l">Your move</span><span class="ex-r">AI video</span>
        <div class="ex-handle"><span></span></div>
        <span class="ex-match"><i>✓</i>${Number(x.match)}% move match</span>
      </div>
      <div class="ex-info"><h4>${esc(x.title)}</h4><p>${esc(x.moveText)} · ${Number(x.seconds)} s</p>
        <div class="ex-tags"><span>${esc(x.model)}</span><span>${esc(x.run)}</span><span>Timing ${esc(x.timing)}</span><span>Walk ${esc(x.walk)}</span></div></div>
    </article>`;
  const nextCard = (next) => `
    <article class="ex ex-next" data-reveal>
      <div class="ex-media"><img src="/assets/obj-clapper.webp" alt=""></div>
      <div class="ex-info"><h4>Next on the reel</h4><ul>${next.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    </article>`;

  function wire(media) {
    const [ai, move] = $$('video', media);
    const pair = lockstep(ai, move);
    const l = $('.ex-l', media), r = $('.ex-r', media);
    let cut = 50, dragging = false, swept = false, anim = 0;
    const set = (pct) => {
      cut = Math.max(0, Math.min(100, pct));
      media.style.setProperty('--cut', `${cut}%`);
      media.setAttribute('aria-valuenow', Math.round(cut));
      l.style.opacity = cut < 12 ? 0 : 1;
      r.style.opacity = cut > 88 ? 0 : 1;
    };
    const sweepTo = (to, ms = 500) => {
      cancelAnimationFrame(anim);
      const from = cut, t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        set(from + (to - from) * e);
        if (k < 1 && !dragging) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    };
    const at = (e) => { const b = media.getBoundingClientRect(); return ((e.clientX - b.left) / b.width) * 100; };
    media.addEventListener('pointerdown', (e) => { dragging = true; cancelAnimationFrame(anim); media.setPointerCapture(e.pointerId); set(at(e)); });
    media.addEventListener('pointermove', (e) => { if (dragging || e.pointerType === 'mouse') { cancelAnimationFrame(anim); set(at(e)); } });
    media.addEventListener('pointerup', () => { dragging = false; });
    media.addEventListener('pointercancel', () => { dragging = false; });
    media.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !dragging) sweepTo(50); });
    media.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { set(cut - 5); e.preventDefault(); }
      if (e.key === 'ArrowRight') { set(cut + 5); e.preventDefault(); }
    });
    set(50);
    // Play only while on screen. The first time, sweep across once to show what dragging does.
    new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) { pair.pause(); return; }
      for (const v of [ai, move]) if (v.preload === 'none') { v.preload = 'auto'; v.load(); }
      if (!reduce) pair.play();
      if (!swept && !reduce) { swept = true; set(94); setTimeout(() => sweepTo(6, 1400), 700); setTimeout(() => sweepTo(50, 900), 2400); }
    }, { threshold: 0.4 }).observe(media);
  }

  if (track) {
    fetch('/showcase/examples.json').then((res) => res.json()).then(({ examples, next }) => {
      track.innerHTML = examples.map(card).join('') + (next && next.length ? nextCard(next) : '');
      $$('[data-reveal]', track).forEach((el, i) => { el.style.setProperty('--i', i); io.observe(el); });
      $$('.ex-media[role=slider]', track).forEach(wire);
    }).catch(() => { track.innerHTML = '<p class="lead" style="text-align:center;color:#c7bdb2">The examples could not load. Refresh to try again.</p>'; });
  }
})();
