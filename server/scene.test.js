import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateScene } from './validate-scene.js';
import { matchTemplate, listTemplates, loadTemplate, buildScene, DEFAULT_MODEL } from './scene.js';

const ACCEPT_PROMPT = 'parking lot at night, one car, a guy stuck between two cars';
const minimal = () => ({ units: 'm', spawn: { p: [0, 1.6, 6] }, objects: [{ id: 'ground', type: 'plane', size: [20, 20] }] });

// ---- validator ---------------------------------------------------------------
test('validator accepts a minimal scene', () => {
  assert.deepEqual(validateScene(minimal()), []);
});

test('validator rejects the mistakes an LLM is likely to make', () => {
  const bad = (mutate) => { const s = minimal(); mutate(s); return validateScene(s); };
  assert.ok(bad(s => { s.units = 'cm'; }).length);
  assert.ok(bad(s => { s.spawn.p = [0, 1.6]; }).length);
  assert.ok(bad(s => { s.objects.push({ id: 'Car 1', type: 'box' }); }).length, 'bad id');
  assert.ok(bad(s => { s.objects.push({ id: 'ground', type: 'box' }); }).length, 'duplicate id');
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'cone' }); }).length, 'unknown type');
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'box', size: [1, 1] }); }).length, 'box needs 3 sizes');
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'box', size: [1, 0, 1] }); }).length, 'zero size');
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'box', colour: '#fff' }); }).length, 'unknown field');
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'box', color: 'red' }); }).length, 'color format');
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'stickfigure', pose: 'dancing' }); }).length);
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'stickfigure', height: 3 }); }).length);
  assert.ok(bad(s => { s.objects.push({ id: 'x', type: 'stickfigure', size: [1] }); }).length);
  assert.ok(bad(s => { for (let i = 0; i < 60; i++) s.objects.push({ id: `b${i}`, type: 'box' }); }).length, '> 60 objects');
  assert.deepEqual(validateScene(null), ['scene must be an object']);
});

// ---- templates ---------------------------------------------------------------
test('every template is a valid scene with a ground plane', async () => {
  const names = await listTemplates();
  assert.deepEqual(names.sort(), ['empty-room', 'parking-lot', 'street-corner']);
  for (const n of names) {
    const s = await loadTemplate(n);
    assert.deepEqual(validateScene(s), [], n);
    assert.equal(s.objects[0].type, 'plane', `${n}: ground plane first`);
  }
});

test('parking lot template meets the Phase 1 acceptance test', async () => {
  const s = await loadTemplate('parking-lot');
  const cars = s.objects.filter(o => o.label === 'car');
  assert.ok(cars.length >= 2, '≥ 2 cars');
  for (const c of cars) assert.ok(Math.abs(c.size[2] - 4.5) < 0.3, 'car ~4.5 m long');
  assert.equal(s.objects.filter(o => o.type === 'stickfigure').length, 1, 'one stick figure');
});

test('template matcher', () => {
  assert.equal(matchTemplate(ACCEPT_PROMPT), 'parking-lot');
  assert.equal(matchTemplate('a man at his desk in a small office'), 'empty-room');
  assert.equal(matchTemplate('two pedestrians at a street corner downtown'), 'street-corner');
  assert.equal(matchTemplate('a car parked on a city street'), 'street-corner'); // most words wins
  assert.equal(matchTemplate('the surface of the moon'), 'parking-lot');         // fallback
  assert.equal(matchTemplate(''), 'parking-lot');
});

// ---- /api/scene logic --------------------------------------------------------
const quiet = { warn() {} };
const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const llmReply = (scene, stop_reason = 'end_turn') => reply({ stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(scene) }] });

test('no API key → template, with a note', async () => {
  const r = await buildScene(ACCEPT_PROMPT, { env: {} });
  assert.equal(r.source, 'template');
  assert.match(r.note, /ANTHROPIC_API_KEY/);
  assert.equal(r.scene.prompt, ACCEPT_PROMPT);
  assert.match(r.scene.id, /^scene-\d+$/);
});

test('with a key → calls Claude with the expected request and returns its scene', async () => {
  let call;
  const fetchImpl = async (url, init) => { call = { url, init }; return llmReply(minimal())(); };
  const r = await buildScene('an empty field', { env: { ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl });
  assert.equal(r.source, 'llm');
  assert.equal(r.scene.objects[0].id, 'ground');
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'sk-test');
  assert.ok(call.init.headers['anthropic-version']);
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.output_config.format, undefined, 'structured output truncates scenes; see DECISIONS §12');
  assert.match(body.system, /Real sizes/);
  assert.match(body.system, /"stickfigure"/, 'schema is included in the system prompt');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'an empty field' }]);
});

test('fields that do not apply to a type are dropped from Claude output, not fatal', async () => {
  const s = minimal();
  s.objects[0].height = 0.5; s.objects[0].pose = 'standing';
  s.objects.push({ id: 'guy', type: 'stickfigure', size: [1], height: 1.8 });
  const r = await buildScene('x', { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: llmReply(s), log: quiet });
  assert.equal(r.source, 'llm');
  assert.ok(!('height' in r.scene.objects[0]) && !('size' in r.scene.objects[1]));
  assert.equal(r.scene.objects[1].height, 1.8);
});

test('JSON wrapped in a code fence is still accepted', async () => {
  const fenced = reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n' + JSON.stringify(minimal()) + '\n```' }] });
  const r = await buildScene('x', { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: fenced, log: quiet });
  assert.equal(r.source, 'llm');
});

test('ANTHROPIC_MODEL overrides the model', async () => {
  let model;
  const fetchImpl = async (url, init) => { model = JSON.parse(init.body).model; return llmReply(minimal())(); };
  await buildScene('x', { env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-opus-5-5' }, fetchImpl });
  assert.equal(model, 'claude-opus-5-5');
});

test('any Claude failure falls back to a template', async () => {
  const env = { ANTHROPIC_API_KEY: 'k' };
  const cases = {
    'http error': reply({ error: 'overloaded' }, 529),
    'network': async () => { throw new Error('ECONNRESET'); },
    'refusal': llmReply(minimal(), 'refusal'),
    'truncated': llmReply(minimal(), 'max_tokens'),
    'not json': reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure! Here is' }] }),
    'no content': reply({ stop_reason: 'end_turn', content: [] }),
    'invalid scene': llmReply({ units: 'm', spawn: { p: [0, 1.6, 6] }, objects: [{ id: 'a', type: 'cone' }] }),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    const r = await buildScene(ACCEPT_PROMPT, { env, fetchImpl, log: quiet });
    assert.equal(r.source, 'template', name);
    assert.match(r.note, /AI blockout failed/, name);
    assert.deepEqual(validateScene(r.scene), [], name);
  }
});

test('edit with words: Claude gets the current set and the change; ids and setId are kept', async () => {
  const current = { ...minimal(), id: 'scene-1', setId: 'scene-0', prompt: 'a field' };
  let body;
  const edited = { ...minimal(), objects: [...minimal().objects] };
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return llmReply(edited)(); };
  const r = await buildScene('turn the guy to face the camera', { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl, current });
  assert.equal(r.source, 'edit');
  assert.match(body.messages[0].content, /current set/);
  assert.match(body.messages[0].content, /turn the guy to face the camera/);
  assert.equal(r.scene.setId, 'scene-0');
  assert.notEqual(r.scene.id, 'scene-1', 'an edit is a new version of the set');
  assert.equal(r.scene.prompt, 'a field');
});

test('edit with words without a key or on failure keeps the current set and says why', async () => {
  const current = { ...minimal(), id: 'scene-1', setId: 'scene-1' };
  const none = await buildScene('move it', { env: {}, current });
  assert.equal(none.unchanged, true);
  assert.equal(none.scene, current);
  const bad = await buildScene('move it', { env: { ANTHROPIC_API_KEY: 'k' }, current, fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'x' }), log: quiet });
  assert.equal(bad.unchanged, true);
  assert.match(bad.note, /Could not/);
});
