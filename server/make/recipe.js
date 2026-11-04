// A recipe is the tested way to turn a take into a real video with one AI model. It lives in recipes/*.json on the
// server only (never served to the browser): the prompts and settings are the product's edge.
// Templates use {{name}}; a value that is exactly one placeholder keeps its type (numbers stay numbers).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PROVIDERS = ['higgsfield', 'mock'];

/** Problems with a recipe, as short strings. Empty means it is usable. */
export function checkRecipe(r) {
  const e = [];
  if (!r || typeof r !== 'object') return ['recipe must be an object'];
  if (typeof r.id !== 'string' || !r.id) e.push('id missing');
  if (!PROVIDERS.includes(r.provider)) e.push(`provider must be one of ${PROVIDERS.join(', ')}`);
  for (const step of ['startImage', 'video']) {
    if (typeof r[step]?.endpoint !== 'string') e.push(`${step}.endpoint missing`);
    if (!r[step]?.input || typeof r[step].input !== 'object') e.push(`${step}.input missing`);
    if (typeof r[step]?.output !== 'string') e.push(`${step}.output missing (where the URL is in the result, e.g. "images.0.url")`);
  }
  if (!Number.isInteger(r.candidates) || r.candidates < 1 || r.candidates > 4) e.push('candidates must be 1 to 4');
  if (!Number.isInteger(r.extraTries ?? 0) || r.extraTries < 0 || r.extraTries > 3) e.push('extraTries must be 0 to 3');
  if (!r.pass || typeof r.pass !== 'object') e.push('pass marks missing');
  if (r.qualities != null) { // { "480p": credits per video, ... }; the first one is the default
    const q = Object.entries(r.qualities);
    if (!q.length || !q.every(([k, v]) => /^\d{3,4}p$/.test(k) && Number.isFinite(v) && v >= 0)) e.push('qualities must look like { "480p": 0.167 } (USD per second of video)');
  }
  return e;
}

/** Fill {{name}} placeholders anywhere inside a JSON-like value. Unknown placeholders are an error. */
export function fill(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{(\w+)\}\}$/);
    if (whole) return need(vars, whole[1]);
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) => String(need(vars, k)));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}
function need(vars, k) {
  if (!(k in vars) || vars[k] === undefined) throw new Error(`recipe uses {{${k}}} but no value was given`);
  return vars[k];
}

/** Read a dotted path such as "images.0.url" from a provider result. */
export function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Did a scored candidate pass? Each mark only applies when the score has that number (e.g. no walking measured
 * means walk marks are skipped). Returns { pass, reasons } with plain-language reasons for a fail.
 */
export function judge(score, pass) {
  const reasons = [];
  if (!score) return { pass: false, reasons: ['not scored'] };
  const has = (k) => typeof score[k] === 'number';
  if (pass.turnCorrMin != null && has('turn_corr') && score.turn_corr < pass.turnCorrMin) reasons.push('turns don’t match your move');
  if (pass.maxOffsetS != null && has('timing_offset_s') && Math.abs(score.timing_offset_s) > pass.maxOffsetS) reasons.push(`timing is off by ${Math.abs(score.timing_offset_s).toFixed(1)} s`);
  if (pass.walkRatio && has('walk_ratio') && (score.walk_ratio < pass.walkRatio[0] || score.walk_ratio > pass.walkRatio[1])) reasons.push(score.walk_ratio < pass.walkRatio[0] ? 'walks less than you did' : 'walks further than you did');
  if (pass.walkCorrMin != null && has('walk_corr') && score.walk_corr < pass.walkCorrMin) reasons.push('walks at the wrong moments');
  return { pass: reasons.length === 0, reasons };
}

/** Rank scored candidates: lower is better. Turn error after timing shift, plus penalties for timing and walking. */
export function badness(score) {
  if (!score) return Infinity;
  let b = score.turn_rms_after_shift_deg ?? 50;
  b += Math.abs(score.timing_offset_s ?? 0) * 20;
  if (typeof score.walk_ratio === 'number') b += Math.abs(1 - score.walk_ratio) * 30;
  return b;
}

/** 0 to 100 for people: how closely the video follows the move. A readable summary of badness, not a measurement; calibrate on real takes. */
export function matchPercent(score) {
  const b = badness(score);
  return Number.isFinite(b) ? Math.max(0, Math.min(100, Math.round(100 - b))) : null;
}

export async function loadRecipes(dir) {
  const out = {};
  for (const f of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'))) {
    const r = JSON.parse(await readFile(join(dir, f), 'utf8'));
    const errors = checkRecipe(r);
    if (errors.length) throw new Error(`${f}: ${errors.join('; ')}`);
    out[r.id] = r;
  }
  return out;
}

/** The quality to use: the one asked for if the recipe offers it, else the recipe's first (cheapest test) one. */
export function pickQuality(recipe, asked) {
  const q = Object.keys(recipe.qualities || {});
  if (!q.length) return null;
  if (asked == null || asked === '') return q[0];
  if (!q.includes(asked)) throw Object.assign(new Error(`${recipe.label} can’t make ${asked}; choose ${q.join(', ')}`), { status: 400 });
  return asked;
}

/** A version whose move match is below this is not charged, and the studio offers to try again. */
export const FREE_BELOW_MATCH = 70;
export const MAX_VERSIONS = 4;

/** How many versions to make: the number asked for (1 to MAX_VERSIONS), else the recipe's default. */
export function pickVersions(recipe, asked) {
  if (asked == null || asked === '') return recipe.candidates;
  const n = Number(asked);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VERSIONS) throw Object.assign(new Error(`choose 1 to ${MAX_VERSIONS} versions`), { status: 400 });
  return n;
}

/** What the AI provider charges us for one video of this length and quality (USD), from the recipe. */
export function videoCost(recipe, resolution, seconds) {
  const perSecond = recipe.qualities?.[resolution];
  return perSecond != null ? perSecond * seconds : (recipe.cost?.video ?? 0);
}
