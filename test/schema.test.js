import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, classifyFrameUri, ValidationError } from '../src/index.js';

const base = () => ({
  initial_frame_uri: './start.png',
  scenes: [{ prompt: 'a' }, { prompt: 'b' }],
});

const issuesOf = (req) => {
  try {
    validateRequest(req);
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    return err.issues.join('\n');
  }
  return '';
};

test('applies defaults', () => {
  const r = validateRequest(base());
  assert.equal(r.aspect_ratio, '16:9');
  assert.equal(r.speed_ramping, false);
  assert.deepEqual(r.scenes.map((s) => s.duration_seconds), [5, 5]);
  assert.equal(r.idempotency_key, undefined);
});

test('scene count must be 2-8', () => {
  assert.match(issuesOf({ ...base(), scenes: [{ prompt: 'x' }] }), /2-8 items/);
  assert.match(issuesOf({ ...base(), scenes: Array.from({ length: 9 }, () => ({ prompt: 'x' })) }), /2-8 items/);
  assert.equal(issuesOf({ ...base(), scenes: Array.from({ length: 8 }, () => ({ prompt: 'x' })) }), '');
});

test('prompt is required', () => {
  assert.match(issuesOf({ ...base(), scenes: [{ prompt: '  ' }, {}] }), /scenes\[0\]\.prompt/);
});

test('duration must be 3-10', () => {
  assert.match(issuesOf({ ...base(), scenes: [{ prompt: 'a', duration_seconds: 2 }, { prompt: 'b' }] }), /duration_seconds/);
  assert.match(issuesOf({ ...base(), scenes: [{ prompt: 'a', duration_seconds: 11 }, { prompt: 'b' }] }), /duration_seconds/);
  assert.match(issuesOf({ ...base(), scenes: [{ prompt: 'a', duration_seconds: '5' }, { prompt: 'b' }] }), /duration_seconds/);
  const ok = validateRequest({ ...base(), scenes: [{ prompt: 'a', duration_seconds: 3 }, { prompt: 'b', duration_seconds: 10 }] });
  assert.deepEqual(ok.scenes.map((s) => s.duration_seconds), [3, 10]);
});

test('aspect ratio enum', () => {
  for (const ar of ['16:9', '9:16', '1:1']) assert.equal(validateRequest({ ...base(), aspect_ratio: ar }).aspect_ratio, ar);
  assert.match(issuesOf({ ...base(), aspect_ratio: '4:3' }), /aspect_ratio/);
});

test('idempotency key <= 200 chars', () => {
  assert.equal(validateRequest({ ...base(), idempotency_key: 'k'.repeat(200) }).idempotency_key.length, 200);
  assert.match(issuesOf({ ...base(), idempotency_key: 'k'.repeat(201) }), /idempotency_key/);
});

test('speed_ramping must be boolean', () => {
  assert.equal(validateRequest({ ...base(), speed_ramping: true }).speed_ramping, true);
  assert.match(issuesOf({ ...base(), speed_ramping: 'yes' }), /speed_ramping/);
});

test('frame URIs: https and local paths only', () => {
  assert.equal(classifyFrameUri('https://example.com/a.png').kind, 'https');
  assert.equal(classifyFrameUri('./a.png').kind, 'local');
  assert.equal(classifyFrameUri('/abs/a.png').kind, 'local');
  assert.equal(classifyFrameUri('file:///abs/a.png').kind, 'local');
  assert.equal(classifyFrameUri('C:\\frames\\a.png').kind, 'local');
  for (const bad of ['http://example.com/a.png', 'custom://asset/123', 's3://bucket/a.png', 'data:image/png;base64,xx', '']) {
    assert.ok(classifyFrameUri(bad).error, bad);
  }
  assert.match(issuesOf({ ...base(), initial_frame_uri: 'custom://asset/1' }), /initial_frame_uri/);
  assert.match(
    issuesOf({ ...base(), scenes: [{ prompt: 'a', target_frame_uri: 'http://x/y.png' }, { prompt: 'b' }] }),
    /target_frame_uri/
  );
});

test('rejects unknown fields and reports all issues at once', () => {
  const msg = issuesOf({ initial_frame_uri: 'custom://x', scenes: [{ prompt: '' }], extra: 1 });
  assert.match(msg, /unknown field "extra"/);
  assert.match(msg, /initial_frame_uri/);
  assert.match(msg, /2-8 items/);
  assert.match(msg, /prompt/);
});
