// Scene from a sentence. Claude when ANTHROPIC_API_KEY is set, otherwise (or on any failure) a template.
// Kept out of index.js so tests can import it without starting the server.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateScene } from './validate-scene.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, 'templates');
const SCHEMA_PATH = join(here, '..', 'public', 'shared', 'scene-schema.json');
const PROMPT_PATH = join(here, 'scene-prompt.md');

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const TIMEOUT_MS = 45_000;

// ---- templates -------------------------------------------------------------
// Words that point at each template. The first template listed wins ties and is the fallback.
const TEMPLATE_WORDS = {
  'parking-lot': ['parking', 'lot', 'garage', 'car', 'cars', 'truck', 'van', 'driveway'],
  'street-corner': ['street', 'corner', 'road', 'city', 'sidewalk', 'crosswalk', 'intersection', 'alley', 'building', 'buildings', 'downtown', 'traffic'],
  'empty-room': ['room', 'office', 'kitchen', 'bedroom', 'living', 'interior', 'indoors', 'inside', 'apartment', 'house', 'table', 'chair', 'desk', 'sofa', 'couch'],
};

/** Pick the template name whose words appear most in the prompt. */
export function matchTemplate(prompt) {
  const words = new Set(String(prompt).toLowerCase().match(/[a-z]+/g) || []);
  let best = 'parking-lot', bestScore = 0;
  for (const [name, keys] of Object.entries(TEMPLATE_WORDS)) {
    const score = keys.filter(k => words.has(k)).length;
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return best;
}

export async function listTemplates() {
  return (await readdir(TEMPLATE_DIR)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
}

export async function loadTemplate(name) {
  return JSON.parse(await readFile(join(TEMPLATE_DIR, `${name}.json`), 'utf8'));
}

// ---- Claude ----------------------------------------------------------------
let cachedPrompt, cachedSchema;

/** The shared schema can't say "height/pose only on stick figures", so Claude sometimes adds them elsewhere.
 *  Drop fields that don't apply to the object's type; they carry no meaning, so nothing is lost. */
export function tidy(scene) {
  for (const o of scene?.objects || []) {
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'stickfigure') delete o.size;
    else { delete o.height; delete o.pose; }
  }
  return scene;
}

/** Ask Claude for a scene. Throws on anything unexpected; the caller falls back to a template. */
export async function llmScene(prompt, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  cachedPrompt ??= await readFile(PROMPT_PATH, 'utf8');
  cachedSchema ??= await readFile(SCHEMA_PATH, 'utf8');
  const system = `${cachedPrompt}\n\n## JSON schema your output must match\n\n${cachedSchema}`;

  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system,
      // low effort: a blockout is a quick spatial sketch, and the user is waiting (SPEC: ~5 s).
      // No json_schema structured output: with it Claude returned 1–3 objects instead of ~12 (DECISIONS §12).
      // The schema goes in the prompt instead, and validateScene() is the real check.
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = await res.json();
  if (msg.stop_reason !== 'end_turn') throw new Error(`model stopped with ${msg.stop_reason}`);
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const start = text.indexOf('{'), end = text.lastIndexOf('}'); // tolerate a stray code fence or sentence
  const scene = tidy(JSON.parse(text.slice(start, end + 1)));
  const errors = validateScene(scene);
  if (errors.length) throw new Error(`invalid scene: ${errors.slice(0, 5).join('; ')}`);
  return scene;
}

// ---- the one entry point used by /api/scene --------------------------------
/** → { scene, source: 'llm'|'template', note? }. Never throws for a bad prompt or a dead API. */
export async function buildScene(prompt, { env = process.env, fetchImpl, log = console } = {}) {
  prompt = String(prompt || '').slice(0, 2000);
  let scene, source = 'template', note;
  if (env.ANTHROPIC_API_KEY && prompt.trim()) {
    try {
      scene = await llmScene(prompt, { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || DEFAULT_MODEL, fetchImpl });
      source = 'llm';
    } catch (e) {
      note = `AI blockout failed, using a template (${e.message})`;
      log.warn(`[scene] ${note}`);
    }
  } else if (!env.ANTHROPIC_API_KEY) {
    note = 'no ANTHROPIC_API_KEY, using a template';
  }
  if (!scene) scene = await loadTemplate(matchTemplate(prompt));
  scene.prompt = prompt;
  scene.id = `scene-${Date.now()}`;
  return { scene, source, ...(note && { note }) };
}
