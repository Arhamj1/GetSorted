/* ════════════════════════════════════════════
   GetSorted motion layer: GSAP + ScrollTrigger
   Hooks into the app's own functions (showApp, renderCards,
   openOverlay…) so the app code stays untouched. If GSAP fails to
   load, or the user prefers reduced motion, nothing here runs and
   the app falls back to its plain CSS transitions.
════════════════════════════════════════════ */
(function () {
  if (!window.gsap || !window.ScrollTrigger) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  gsap.registerPlugin(ScrollTrigger);
  document.documentElement.classList.add('gsap');

  const EASE = 'power3.out';
  const q = (s, r) => Array.from((r || document).querySelectorAll(s));
  const wrap = (name, after) => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      const out = orig.apply(this, arguments);
      try { after.apply(this, arguments); } catch (e) { console.warn('motion:', name, e); }
      return out;
    };
  };

  /* ── Dashboard entrance ─────────────────────── */
  let entered = false, introTl = null, lastEnter = 0;
  function enterDashboard() {
    // showApp can fire twice in a row (demo + auth state); play the intro once
    if (performance.now() - lastEnter < 1500) return;
    lastEnter = performance.now();
    ScrollTrigger.getAll().forEach(t => t.vars.id === 'reveal' && t.kill());
    if (introTl) introTl.progress(1).kill();

    const IN = { y: 0, x: 0, scale: 1, opacity: 1, clearProps: 'transform,opacity' };
    const tl = introTl = gsap.timeline({ defaults: { ease: EASE } });
    tl.fromTo('.topbar', { y: -24, opacity: 0 }, { ...IN, duration: .6 })
      .fromTo('.greet small, .greet h1', { y: 28, opacity: 0 }, { ...IN, duration: .8, stagger: .08 }, '-=.35')
      .fromTo('.kpis', { y: 36, opacity: 0 }, { ...IN, duration: .8 }, '-=.5')
      .fromTo('.kpi', { y: 18, opacity: 0 }, { ...IN, duration: .6, stagger: .07 }, '-=.6');

    // Panels reveal as they scroll into view; ones already on screen play right away
    ScrollTrigger.batch('#appPage .panel', {
      id: 'reveal',
      start: 'top 90%',
      once: true,
      onEnter: els => gsap.fromTo(els,
        { y: 48, opacity: 0, scale: .985 },
        { y: 0, opacity: 1, scale: 1, duration: .9, ease: EASE, stagger: .1, delay: entered ? 0 : .35, clearProps: 'transform,opacity' })
    });
    gsap.set('#appPage .panel', { opacity: 0 });
    entered = true;
    ScrollTrigger.refresh();
  }
  wrap('showApp', () => requestAnimationFrame(enterDashboard));

  /* ── Scroll effects ─────────────────────────── */
  // Greeting drifts up and fades as you scroll past it
  gsap.to('.greet', {
    yPercent: -30, opacity: .15, ease: 'none',
    scrollTrigger: { trigger: '.greet', start: 'top 80px', end: 'bottom top', scrub: .6 }
  });
  // Top bar tightens once the page scrolls
  ScrollTrigger.create({
    start: 8, end: 'max',
    onToggle: self => document.querySelector('.topbar').classList.toggle('scrolled', self.isActive)
  });

  /* ── Subscription rows: reveal on scroll ─────── */
  let rowTriggers = [];
  wrap('renderCards', () => {
    rowTriggers.forEach(t => t.kill());
    const rows = q('#cardsGrid .row');
    if (!rows.length) return;
    gsap.set(rows, { opacity: 0, y: 22 });
    rowTriggers = ScrollTrigger.batch(rows, {
      start: 'top 95%',
      once: true,
      onEnter: els => gsap.to(els, { opacity: 1, y: 0, duration: .6, ease: EASE, stagger: .05, clearProps: 'transform,opacity' })
    });
  });

  wrap('renderUpcoming', () => {
    const items = q('#upcomingList .up');
    if (items.length) gsap.fromTo(items, { x: 24, opacity: 0 }, { x: 0, opacity: 1, duration: .6, ease: EASE, stagger: .06, clearProps: 'transform,opacity' });
  });

  /* ── Modals ─────────────────────────────────── */
  wrap('openOverlay', id => {
    const ov = document.getElementById(id);
    const modal = ov && ov.querySelector('.modal');
    if (!modal) return;
    gsap.killTweensOf(modal);
    gsap.fromTo(modal, { y: 40, scale: .94, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: .65, ease: 'back.out(1.4)', clearProps: 'transform,opacity' });
    const tiles = q('.svc-opt', modal);
    if (tiles.length) gsap.fromTo(tiles, { y: 14, opacity: 0 }, {
      y: 0, opacity: 1, duration: .5, ease: EASE, delay: .12, clearProps: 'transform,opacity',
      stagger: { each: .025, grid: 'auto', from: 'start' }
    });
    const fields = q('.modal-body > .field, .modal-body > .row2, .modal-body > .grid2', modal);
    if (fields.length) gsap.fromTo(fields, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: EASE, delay: .2, stagger: .04, clearProps: 'transform,opacity' });
  });

  /* ── Dropdown menus: options cascade in ─────── */
  new MutationObserver(muts => muts.forEach(m => {
    const el = m.target;
    if (el.classList && el.classList.contains('dd-menu') && el.classList.contains('show') && !(m.oldValue || '').includes('show')) {
      const up = el.classList.contains('dd-up');
      gsap.fromTo(q('.dd-opt', el), { y: up ? 8 : -8, opacity: 0 }, { y: 0, opacity: 1, duration: .35, ease: EASE, stagger: .02, clearProps: 'transform,opacity' });
    }
  })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });

  /* ── Micro-interactions ─────────────────────── */
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  // Magnetic primary buttons
  if (fine) document.addEventListener('pointermove', e => {
    const b = e.target.closest && e.target.closest('.btn-primary');
    if (!b || b._mag) return;
    b._mag = true;
    const xTo = gsap.quickTo(b, 'x', { duration: .4, ease: 'power3' });
    const yTo = gsap.quickTo(b, 'y', { duration: .4, ease: 'power3' });
    b.addEventListener('pointermove', ev => {
      const r = b.getBoundingClientRect();
      xTo((ev.clientX - r.left - r.width / 2) * .25);
      yTo((ev.clientY - r.top - r.height / 2) * .35);
    });
    b.addEventListener('pointerleave', () => {
      gsap.to(b, { x: 0, y: 0, duration: .7, ease: 'elastic.out(1, .4)' });
    });
  });

  // Press squish on every button
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest && e.target.closest('.btn, .icon-btn, .svc-opt, .chip');
    if (b) gsap.fromTo(b, { scale: .95 }, { scale: 1, duration: .45, ease: 'back.out(3)', overwrite: 'auto', clearProps: 'scale' });
  });

  // Hover: boxes lift a little and tilt towards the cursor.
  // Perspective is re-applied on every enter because the scroll reveal's
  // clearProps wipes it, which used to flatten the effect.
  if (fine) {
    const tilt = el => {
      el.addEventListener('pointerenter', () => {
        gsap.set(el, { transformPerspective: 1200 });
        gsap.to(el, { y: -6, scale: 1.006, duration: .5, ease: 'power3.out', overwrite: 'auto' });
      });
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
        gsap.to(el, { rotationY: px * 4, rotationX: -py * 4, duration: .6, ease: 'power3.out', overwrite: 'auto' });
      });
      el.addEventListener('pointerleave', () => {
        gsap.to(el, { y: 0, scale: 1, rotationX: 0, rotationY: 0, duration: .8, ease: 'elastic.out(1, .6)', overwrite: 'auto' });
      });
    };
    q('.kpis, #appPage .panel').forEach(tilt);
  }

  // Number pop when a KPI value changes
  q('.kpi-val').forEach(el => new MutationObserver(() => {
    if (el._popping) return;
    el._popping = true;
    gsap.fromTo(el, { scale: 1.06 }, { scale: 1, duration: .8, ease: 'elastic.out(1, .5)', onComplete: () => { el._popping = false; } });
  }).observe(el, { childList: true, characterData: true, subtree: true }));

  // ?demo opens the dashboard before this file loads, so play the entrance now
  if (document.getElementById('appPage').classList.contains('show')) requestAnimationFrame(enterDashboard);
})();
