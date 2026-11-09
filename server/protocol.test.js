import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoomCode, MSG, ROLES } from '../public/shared/protocol.js';

test('room codes are 4 chars from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const c = makeRoomCode();
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  }
});

test('protocol has the documented message types', () => {
  assert.deepEqual(Object.values(MSG).sort(), ['ack', 'anchor', 'hello', 'peer', 'pose', 'rec', 'scene', 'spawn', 'take']);
  assert.deepEqual(ROLES, ['cam', 'desk']);
});
