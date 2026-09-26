import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runChain, FrameChainError, ValidationError, deriveIdempotencyKey } from '../src/index.js';
import { tempDir, fakeImage, mockBackend, mockExtract } from './helpers.js';

async function setup(sceneCount = 3) {
  const dir = await tempDir();
  const initial = await fakeImage(dir, 'start.png', 'initial');
  const request = {
    initial_frame_uri: initial,
    scenes: Array.from({ length: sceneCount }, (_, i) => ({ prompt: `scene ${i + 1}` })),
    idempotency_key: 'test-run',
  };
  return { dir, initial, request, outDir: path.join(dir, 'out') };
}

test('chains each clip from the previous clip\'s last frame, in order', async () => {
  const { request, outDir } = await setup(3);
  const backend = mockBackend();
  const res = await runChain(request, { backend, outDir, extractLastFrame: mockExtract });

  assert.equal(res.clips.length, 3);
  assert.deepEqual(backend.calls.map((c) => c.firstFrameContent), [
    'IMG:initial',
    'IMG:last-of-CLIP:0',
    'IMG:last-of-CLIP:1',
  ]);
  assert.deepEqual(backend.calls.map((c) => c.prompt), ['scene 1', 'scene 2', 'scene 3']);
  assert.ok(backend.calls.every((c) => c.aspectRatio === '16:9' && c.durationSeconds === 5));
  for (const [i, clip] of res.clips.entries()) assert.equal(await readFile(clip, 'utf8'), `CLIP:${i}`);
  assert.equal(res.resumed, 0);
  assert.equal(res.idempotency_key, 'test-run');
  assert.deepEqual(res.speed_ramping, { enabled: false });
});

test('passes target frames through and applies aspect ratio / durations', async () => {
  const { dir, request, outDir } = await setup(2);
  const target = await fakeImage(dir, 'target.png', 'target');
  request.scenes[1] = { prompt: 'end on this', duration_seconds: 8, target_frame_uri: target };
  request.aspect_ratio = '9:16';
  request.speed_ramping = true;
  const backend = mockBackend();
  const res = await runChain(request, { backend, outDir, extractLastFrame: mockExtract });

  assert.equal(backend.calls[0].targetFramePath, null);
  assert.equal(backend.calls[1].targetFramePath, target);
  assert.equal(backend.calls[1].durationSeconds, 8);
  assert.ok(backend.calls.every((c) => c.aspectRatio === '9:16'));
  assert.equal(res.speed_ramping.enabled, true);
});

test('re-running with the same key skips completed clips and resumes', async () => {
  const { request, outDir } = await setup(4);

  const failing = mockBackend({ failAt: new Set([2]) });
  await assert.rejects(runChain(request, { backend: failing, outDir, extractLastFrame: mockExtract }), /Scene 3\/4 failed/);
  assert.equal(failing.calls.length, 3);

  const retry = mockBackend();
  const res = await runChain(request, { backend: retry, outDir, extractLastFrame: mockExtract });
  assert.equal(res.resumed, 2);
  assert.equal(res.clips.length, 4);
  assert.deepEqual(retry.calls.map((c) => c.index), [2, 3]);
  // Resumed scene 3 still starts from scene 2's last frame.
  assert.equal(retry.calls[0].firstFrameContent, 'IMG:last-of-CLIP:1');

  const again = mockBackend();
  const res2 = await runChain(request, { backend: again, outDir, extractLastFrame: mockExtract });
  assert.equal(again.calls.length, 0, 'fully completed chain dispatches nothing');
  assert.deepEqual(res2.clips, res.clips);
});

test('a completed clip whose file was deleted is regenerated', async () => {
  const { request, outDir } = await setup(2);
  const res = await runChain(request, { backend: mockBackend(), outDir, extractLastFrame: mockExtract });
  await rm(res.clips[1]);
  const backend = mockBackend();
  await runChain(request, { backend, outDir, extractLastFrame: mockExtract });
  assert.deepEqual(backend.calls.map((c) => c.index), [1]);
});

test('reusing a key with a different request is rejected', async () => {
  const { request, outDir } = await setup(2);
  await runChain(request, { backend: mockBackend(), outDir, extractLastFrame: mockExtract });
  const changed = { ...request, scenes: [{ prompt: 'different' }, { prompt: 'b' }] };
  await assert.rejects(
    runChain(changed, { backend: mockBackend(), outDir, extractLastFrame: mockExtract }),
    (err) => err instanceof FrameChainError && err.code === 'IDEMPOTENCY_MISMATCH'
  );
});

test('without a key, an identical request derives the same key', async () => {
  const { request, outDir } = await setup(2);
  delete request.idempotency_key;
  const a = await runChain(request, { backend: mockBackend(), outDir, extractLastFrame: mockExtract });
  const backend = mockBackend();
  const b = await runChain(request, { backend, outDir, extractLastFrame: mockExtract });
  assert.equal(a.idempotency_key, b.idempotency_key);
  assert.match(a.idempotency_key, /^auto-[0-9a-f]{32}$/);
  assert.equal(backend.calls.length, 0);
  assert.equal(deriveIdempotencyKey({ ...request, aspect_ratio: '16:9', speed_ramping: false, scenes: request.scenes.map((s) => ({ ...s, duration_seconds: 5 })) }), a.idempotency_key);
});

test('a held lock blocks a concurrent run', async () => {
  const { request, outDir } = await setup(2);
  const first = await runChain(request, { backend: mockBackend(), outDir, extractLastFrame: mockExtract });
  await writeFile(`${first.manifest_path}.lock`, '12345');
  await assert.rejects(
    runChain(request, { backend: mockBackend(), outDir, extractLastFrame: mockExtract }),
    (err) => err.code === 'IDEMPOTENCY_LOCKED'
  );
});

test('rejects invalid requests before dispatching anything', async () => {
  const { outDir } = await setup(2);
  const backend = mockBackend();
  await assert.rejects(
    runChain({ initial_frame_uri: 'custom://x', scenes: [{ prompt: 'a' }, { prompt: 'b' }] }, { backend, outDir }),
    ValidationError
  );
  assert.equal(backend.calls.length, 0);
});

test('rejects a backend that returns no file', async () => {
  const { request, outDir } = await setup(2);
  const backend = { name: 'broken', generateClip: async (job) => ({ path: job.outputPath }) };
  await assert.rejects(runChain(request, { backend, outDir, extractLastFrame: mockExtract }), /no clip file/);
});

test('downloads https frames via the injected fetch', async () => {
  const { request, outDir } = await setup(2);
  request.initial_frame_uri = 'https://example.com/start.png';
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://example.com/start.png');
    return new Response(Buffer.from('IMG:remote'), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const backend = mockBackend();
  await runChain(request, { backend, outDir, extractLastFrame: mockExtract, fetchImpl });
  assert.equal(backend.calls[0].firstFrameContent, 'IMG:remote');
});
