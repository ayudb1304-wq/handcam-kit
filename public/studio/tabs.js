// The studio's two side panels show one pane at a time (left: Set, Phone, Sequence; right: Takes, Export, Make video),
// so neither side ever scrolls. A tab button has data-tab="name"; its pane has data-pane="name" in the same .col.
const pane = (name) => document.querySelector(`[data-pane="${name}"]`);

/** Show a pane (and mark its tab). Does nothing for an unknown name. */
export function showPane(name) {
  const p = pane(name), col = p?.closest('.col');
  if (!col) return;
  for (const el of col.querySelectorAll('[data-pane]')) el.hidden = el !== p;
  for (const b of col.querySelectorAll('[data-tab]')) { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
}
/** Make sure an element is on screen: if it sits in a pane that isn't showing, show that pane. */
export function reveal(el) {
  const p = el?.closest('[data-pane]');
  if (p?.hidden) showPane(p.dataset.pane);
}
export function setupTabs() {
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showPane(b.dataset.tab);
  for (const s of document.querySelectorAll('[data-go]')) s.onclick = () => showPane(s.dataset.go); // the steps in the top bar
}
