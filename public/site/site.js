// HandCam landing page motion: nav, hero tilt, scroll-lit words, floating objects, reveals, chart, ring,
// pricing toggle, FAQ. No libraries. Everything degrades to a static page with reduced motion or no JS.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // Nav gets solid once you scroll
  const nav = $('#nav');
  const onScrollNav = () => nav.classList.toggle('scrolled', scrollY > 24);

  // Hero product frame: tilted back, flattens as you scroll
  const browser = $('#browser');
  const onScrollTilt = () => { if (browser) browser.style.setProperty('--tilt', `${Math.max(0, 14 - scrollY / 28)}deg`); };

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
    const target = 91, t0 = performance.now() + (reduce ? 0 : 1200), dur = reduce ? 1 : 1400;
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
})();
