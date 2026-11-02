// A thumb stick on any element: drag inside it, get a vector back. Pointer events, no library.
// stick.value is { x, y } in −1..1 (x right, y down, like the screen), 0 inside the 10% dead zone,
// and snaps back to 0 when the thumb lifts.
const DEAD = 0.1;

export function makeStick(zone) {
  const knob = document.createElement('div');
  knob.className = 'knob';
  zone.append(knob);
  const stick = { value: { x: 0, y: 0 } };
  let id = null;

  function update(e) {
    const r = zone.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = (e.clientX - (r.left + radius)) / radius;
    let dy = (e.clientY - (r.top + r.height / 2)) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
    const m = Math.min(len, 1);
    // rescale so the edge of the dead zone is 0 and the rim is 1: no jump when leaving the dead zone
    const k = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD) / m;
    stick.value = { x: dx * k, y: dy * k };
  }
  function release(e) {
    if (e.pointerId !== id) return;
    id = null;
    stick.value = { x: 0, y: 0 };
    knob.style.transform = '';
  }
  zone.addEventListener('pointerdown', (e) => { if (id !== null) return; id = e.pointerId; zone.setPointerCapture(id); update(e); });
  zone.addEventListener('pointermove', (e) => { if (e.pointerId === id) update(e); });
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);
  return stick;
}
