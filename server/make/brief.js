// The shot brief: what the video AI is told about THIS shot, written from the set and the take, never invented.
// Recipe v0.2 (lab/recipe.md rules 11 to 14, DECISIONS §58). The recipe's prompt has {{pictures}}, {{set}} and {{move}};
// the sentences used to fill them live in the recipe (video.brief), so a changed wording is a new recipe version.
// The move words only say what the hand did (the reference video carries the move itself): describing is not authoring.
import { measureMove } from '../../public/shared/describe.js';

const len = (m) => (m < 1 ? `${Math.max(1, Math.round(m * 100))} cm` : `${m < 10 ? Math.round(m * 10) / 10 : Math.round(m)} m`);
const name = (o) => (o.label || o.id || 'object').replace(/[-_]/g, ' ');
const say = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

/** Height of a set object in metres, and its centre. Planes are flat. */
function dims(o) {
  const s = o.size || [], p = o.p || [0, 0, 0];
  if (o.type === 'stickfigure') { const h = o.height || 1.75; return { h, r: 0.3, c: [p[0], p[1] + h / 2, p[2]] }; }
  if (o.type === 'cylinder') return { h: s[1] ?? 1, r: s[0] ?? 0.5, c: p };
  if (o.type === 'sphere') return { h: 2 * (s[0] ?? 0.5), r: s[0] ?? 0.5, c: p };
  if (o.type === 'plane') return { h: 0, r: Math.max(s[0] ?? 1, s[1] ?? 1) / 2, c: p };
  return { h: s[1] ?? 1, r: Math.max(s[0] ?? 1, s[2] ?? 1) / 2, c: p };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Where the camera looks: unit vector from a [x,y,z,w] quaternion (it looks down -z). */
function forward([x, y, z, w]) {
  return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}
/** Is point c inside the camera's frame at sample s? (view: { fov vertical deg, aspect }) */
function inFrame(s, c, view) {
  const [x, y, z, w] = s.q;
  const f = forward(s.q);
  const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  const right = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  const d = [c[0] - s.p[0], c[1] - s.p[1], c[2] - s.p[2]];
  const ahead = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  if (ahead <= 0.05) return false;
  const tv = Math.tan(((view?.fov ?? 60) * Math.PI) / 360), th = tv * (view?.aspect ?? 16 / 9);
  const sx = (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / ahead, sy = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / ahead;
  return Math.abs(sx) <= th && Math.abs(sy) <= tv;
}

/**
 * The subject of the shot: the object called "subject" if there is one, else the thing the take opens on (closest to
 * the middle of the first frame, within 25 m). Floors, walls and backdrops bigger than 10 m are never the subject.
 */
export function subjectOf(scene, take) {
  const objs = (scene?.objects || []).filter((o) => o.type !== 'plane');
  const named = objs.find((o) => o.id === 'subject');
  if (named) return named;
  const s0 = take?.samples?.[0];
  if (!s0) return null;
  const f = forward(s0.q);
  let best = null, bestA = Infinity;
  for (const o of objs) {
    const { h, r, c } = dims(o);
    if (h > 10 || r > 10) continue;
    const d = [c[0] - s0.p[0], c[1] - s0.p[1], c[2] - s0.p[2]], n = Math.hypot(...d);
    if (n > 25 || n < 0.01) continue;
    const a = Math.acos(Math.max(-1, Math.min(1, (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / n)));
    if (a < bestA) { best = o; bestA = a; }
  }
  return bestA < Math.PI / 3 ? best : null;
}

/** "the clay mug (15 cm tall) on the rock (60 cm tall), the gravel bank, 2 trees… Far behind: 3 alps." */
export function setWords(scene, subject, words) {
  const objs = scene?.objects || [];
  const sub = subject && dims(subject);
  const at = sub ? sub.c : scene?.spawn?.p || [0, 0, 0];
  // parts of the subject (a mug's handle, a label) are covered by the product picture: not listed on their own
  const part = (o) => sub && o !== subject && dims(o).h <= sub.h && dist(dims(o).c, sub.c) < sub.r + sub.h + 0.15;
  const onTop = (a, b) => { // a stands on b
    const A = dims(a), B = dims(b);
    return b.type !== 'plane' && Math.abs((A.c[1] - A.h / 2) - (B.c[1] + B.h / 2)) < 0.05 && Math.hypot(A.c[0] - B.c[0], A.c[2] - B.c[2]) <= B.r + 0.05;
  };
  const near = [], far = new Map();
  for (const o of objs) {
    if (o.type === 'plane' && !o.label) continue; // the ground itself
    if (part(o)) continue;
    const d = dims(o);
    if (dist(d.c, at) > 12 || d.h > 10) { far.set(name(o), (far.get(name(o)) || 0) + 1); continue; }
    near.push(o);
  }
  const counted = new Map();
  for (const o of near) counted.set(name(o), [...(counted.get(name(o)) || []), o]);
  const items = [];
  for (const [n, group] of counted) {
    const o = group[0], d = dims(o), base = objs.find((b) => b !== o && onTop(o, b));
    const size = o.type === 'plane' ? '' : ` (${len(d.h)} tall)`;
    if (group.length > 1) items.push(`${group.length} ${n}s`);
    else items.push(`the ${n}${size}${base ? ` on the ${name(base)}` : ''}`);
  }
  const farList = [...far].map(([n, k]) => (k > 1 ? `${k} ${n}s` : `the ${n}`));
  // a set built from a photo is often described without its subject ("on a rock, by a river"): put the subject first
  let said = (scene?.prompt || '').trim().replace(/\.*\s*$/, '');
  if (said && subject && /^(on|in|at|by|under|beside|next|near|inside|against|with|atop|over)\b/i.test(said)) said = `the ${name(subject)} ${said}`;
  return say(words.set, {
    words: said ? `${said[0].toUpperCase()}${said.slice(1)}.` : '',
    near: items.slice(0, 14).join(', ') || 'nothing else',
    far: farList.length ? say(words.far, { far: farList.slice(0, 8).join(', ') }) : '',
  }).replace(/\s+/g, ' ').trim();
}

/**
 * The move in stages, from the take's own numbers: "from 0.7 s it pulls back about 2.8 m from the clay mug; from 3.3 s
 * it holds its place for about 4 s; from 7.3 s it moves back in about 2.1 m toward the clay mug; at 9.4 s it whips right".
 * Moving = the camera travels faster than 15 cm/s; stops shorter than 0.4 s don't split a stage.
 */
export function stages(take) {
  const s = take?.samples || [];
  if (s.length < 3) return [];
  const t = (i) => s[i].ts / 1000, moving = [];
  for (let i = 0, j = 0; i < s.length; i++) { // speed over the last 0.25 s
    while (t(i) - t(j) > 0.25) j++;
    const dt = t(i) - t(j);
    moving.push(dt > 0 && Math.hypot(s[i].p[0] - s[j].p[0], s[i].p[2] - s[j].p[2]) / dt > 0.15);
  }
  const runs = []; // [start index, end index, moving?]
  for (let i = 0; i < s.length; i++) {
    const last = runs.at(-1);
    if (last && last[2] === moving[i]) last[1] = i; else runs.push([i, i, moving[i]]);
  }
  const merged = []; // a short stop inside a move is still the move
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && !r[2] && t(r[1]) - t(r[0]) < 0.4 && r[1] < s.length - 1) { last[1] = r[1]; continue; }
    if (last && last[2] === r[2]) { last[1] = r[1]; continue; }
    merged.push([...r]);
  }
  return merged.map(([i, j, mv]) => ({ from: t(i), to: t(j), moving: mv, m: measureMove(s.slice(i, j + 1)), rate: turnRate(s.slice(i, j + 1)), a: s[i], b: s[j] }));
}

/** Fastest turn in °/s, over 0.15 s windows: single readings jump, so one noisy sample can't make a pan a whip. */
function turnRate(s) {
  const yaw = (q) => { const f = forward(q); return (Math.atan2(-f[0], -f[2]) * 180) / Math.PI; };
  let fastest = 0;
  for (let i = 0, j = 0; i < s.length; i++) {
    while ((s[i].ts - s[j].ts) / 1000 > 0.15) j++;
    const dt = (s[i].ts - s[j].ts) / 1000;
    if (dt < 0.1) continue;
    let d = yaw(s[i].q) - yaw(s[j].q); d -= 360 * Math.round(d / 360);
    fastest = Math.max(fastest, Math.abs(d) / dt);
  }
  return fastest;
}

/** How far the camera went around the subject, seen from above, in degrees (+: moving to its left, −: to its right). */
function arcAround(a, b, c) {
  const u = [a[0] - c[0], a[2] - c[2]], v = [b[0] - c[0], b[2] - c[2]];
  return (Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) * 180) / Math.PI;
}

/** The move in words, from the take's own numbers, plus what the AI tends to get wrong on this kind of move. */
export function moveWords(take, scene, subject, words) {
  const s = take?.samples;
  if (!s?.length) return '';
  const subj = subject ? `the ${name(subject)}` : 'the subject', at = subject && dims(subject).c;
  const sec = (x) => `${x.toFixed(1)} s`;
  const turnWords = (m, rate) => (rate > 150 && m.turnRange > 25 ? `whips ${m.turn >= 0 ? 'left' : 'right'} fast`
    : Math.abs(m.turn) > 15 ? `turns about ${Math.round(Math.abs(m.turn))}° to the ${m.turn >= 0 ? 'left' : 'right'}` : '');
  const parts = [];
  if (at && dist(s[0].p, at) < 1.5) parts.push(say(words.opensClose, { subject: subj, d: len(dist(s[0].p, at)) }));
  let travelled = 0;
  for (const g of stages(take)) {
    const m = g.m, bits = [];
    if (g.moving) {
      const d = Math.hypot(g.b.p[0] - g.a.p[0], g.b.p[2] - g.a.p[2]);
      if (d < 0.3) continue;
      travelled += d;
      const closer = at ? dist(g.a.p, at) - dist(g.b.p, at) : 0;
      const around = at ? arcAround(g.a.p, g.b.p, at) : 0;
      const arc = Math.abs(around) > 25 && Math.abs(closer) < 0.3 * dist(g.a.p, at);
      if (arc) bits.push(`circles about ${Math.round(Math.abs(around))}° around ${subj}, moving to the ${around > 0 ? 'left' : 'right'}`);
      else bits.push(closer > d * 0.5 ? `moves in about ${len(d)} toward ${subj}` : closer < -d * 0.5 ? `pulls back about ${len(d)} from ${subj}`
        : m.forward > Math.abs(m.side) ? `moves forward about ${len(d)}` : m.forward < -Math.abs(m.side) ? `moves back about ${len(d)}`
        : `moves about ${len(d)} to the ${m.side > 0 ? 'right' : 'left'}`);
      if (Math.abs(m.up) > 0.25) bits.push(`${m.up > 0 ? 'rising' : 'lowering'} about ${len(Math.abs(m.up))}`);
      const turn = !arc && turnWords(m, g.rate); if (turn) bits.push(`and ${turn}`); // circling turns to keep the subject: implied
      parts.push(`from ${sec(g.from)} it ${bits.join(' ')}`);
    } else if (g.to - g.from >= 1) {
      const turn = turnWords(m, g.rate);
      parts.push(`from ${sec(g.from)} it holds its place for about ${sec(g.to - g.from)}${turn ? ` and ${turn}` : ', with only hand sway'}`);
    } else {
      const turn = turnWords(m, g.rate); if (turn) parts.push(`at ${sec(g.from)} it ${turn}`);
    }
  }
  const total = (s.at(-1).ts / 1000).toFixed(1);
  const said = parts.length ? parts.join('; ') : 'it barely moves: only natural hand sway';
  const out = [say(words.move, { move: `${said[0].toUpperCase()}${said.slice(1)}`, s: total })];
  if (travelled > 0.3) out.push(words.fullDistance); // Seedance walks short (rules 6, 13)
  if (at && inFrame(s[0], at, take.view) && !inFrame(s.at(-1), at, take.view)) out.push(say(words.endsAway, { subject: subj })); // swing-back (rule 4)
  out.push(words.toTheEnd);
  return out.join(' ');
}

/** What each reference picture is, in the order they are sent. names: e.g. ['start', 'ref-look.jpg', 'ref-subject.jpg']. */
export function picturesWords(names, subject, words) {
  const subj = subject ? `the ${name(subject)}` : 'the product';
  return names.map((n, i) => say({ start: words.start, 'ref-look.jpg': words.look, 'ref-subject.jpg': words.subject, 'ref-logo.png': words.logo }[n] || '', { i: i + 1, subject: subj }))
    .filter(Boolean).join(' ');
}

/** A see-through product (glass, bottle…): its photo shows whatever was behind it (rule 12). */
export const seeThrough = (...texts) => /\b(glass|glasses|transparent|clear|crystal|perfume|bottle|jar|vial)\b/i.test(texts.filter(Boolean).join(' '));

/** {{pictures}}, {{set}}, {{move}} for the video prompt. names: the pictures sent, in order. */
export function brief({ scene, take, look, names, words }) {
  const subject = subjectOf(scene, take);
  let pictures = picturesWords(names, subject, words);
  if (names.includes('ref-subject.jpg') && seeThrough(subject && name(subject), scene?.prompt, look)) pictures += ` ${words.seeThrough}`;
  return { pictures, set: setWords(scene, subject, words), move: moveWords(take, scene, subject, words), subject: subject ? name(subject) : null };
}
