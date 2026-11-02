// Hand-written check of a scene against public/shared/scene-schema.json, plus the rules
// the schema can't express (unique ids, size length per type). No deps on purpose.
// Returns a list of human-readable problems; empty list = valid.

const TYPES = ['plane', 'box', 'cylinder', 'sphere', 'stickfigure'];
const POSES = ['standing', 'sitting', 'lying', 'crouching'];
const SIZE_LEN = { plane: 2, box: 3, cylinder: 2, sphere: 1 }; // plane:[w,d] box:[w,h,d] cylinder:[r,h] sphere:[r]
const KEYS = new Set(['id', 'type', 'label', 'p', 'rot', 'size', 'color', 'height', 'pose']);
const MAX_OBJECTS = 60;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

export function validateScene(scene) {
  const errors = [];
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return ['scene must be an object'];
  if (scene.units !== 'm') errors.push('units must be "m"');
  if (!scene.spawn || !isVec3(scene.spawn.p)) errors.push('spawn.p must be [x,y,z]');
  if (scene.spawn && scene.spawn.yaw !== undefined && !isNum(scene.spawn.yaw)) errors.push('spawn.yaw must be a number');
  if (!Array.isArray(scene.objects)) return [...errors, 'objects must be an array'];
  if (scene.objects.length > MAX_OBJECTS) errors.push(`at most ${MAX_OBJECTS} objects`);

  const seen = new Set();
  scene.objects.forEach((o, i) => {
    const at = `objects[${i}]${o && o.id ? ` (${o.id})` : ''}`;
    if (!o || typeof o !== 'object') return errors.push(`${at} must be an object`);
    for (const k of Object.keys(o)) if (!KEYS.has(k)) errors.push(`${at} has unknown field "${k}"`);
    if (typeof o.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(o.id)) errors.push(`${at} id must match ^[a-z0-9_-]{1,32}$`);
    else if (seen.has(o.id)) errors.push(`${at} duplicate id`);
    else seen.add(o.id);
    if (!TYPES.includes(o.type)) return errors.push(`${at} type must be one of ${TYPES.join('/')}`);
    if (o.p !== undefined && !isVec3(o.p)) errors.push(`${at} p must be [x,y,z]`);
    if (o.rot !== undefined && !isVec3(o.rot)) errors.push(`${at} rot must be [rx,ry,rz]`);
    if (o.label !== undefined && (typeof o.label !== 'string' || o.label.length > 40)) errors.push(`${at} label must be a string ≤ 40 chars`);
    if (o.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(o.color)) errors.push(`${at} color must be #rrggbb`);
    if (o.type === 'stickfigure') {
      if (o.size !== undefined) errors.push(`${at} stickfigure takes height, not size`);
      if (o.height !== undefined && !(isNum(o.height) && o.height >= 0.5 && o.height <= 2.5)) errors.push(`${at} height must be 0.5–2.5`);
      if (o.pose !== undefined && !POSES.includes(o.pose)) errors.push(`${at} pose must be one of ${POSES.join('/')}`);
    } else {
      if (o.height !== undefined || o.pose !== undefined) errors.push(`${at} height/pose are stickfigure only`);
      const n = SIZE_LEN[o.type];
      if (o.size !== undefined && !(Array.isArray(o.size) && o.size.length === n && o.size.every(v => isNum(v) && v >= 0.01))) {
        errors.push(`${at} size must be ${n} number(s) ≥ 0.01 for ${o.type}`);
      }
    }
  });
  return errors;
}
