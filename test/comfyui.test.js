import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ComfyUIBackend, buildWorkflow, findVideoOutput, runChain, DEFAULT_COMFYUI_URL } from '../src/index.js';
import { tempDir, fakeImage, mockExtract } from './helpers.js';

const WF = {
  1: { class_type: 'LoadImage', inputs: { image: '{{FIRST_FRAME}}' } },
  2: { class_type: 'LoadImage', inputs: { image: '{{LAST_FRAME}}' } },
  3: { class_type: 'CLIPVisionEncode', inputs: { image: ['2', 0] }, _meta: { title: '[target] encode end' } },
  4: { class_type: 'CLIPTextEncode', inputs: { text: 'Scene: {{PROMPT}}' } },
  5: {
    class_type: 'SomeImageToVideo',
    inputs: { start_image: ['1', 0], end_image: ['2', 0], clip_vision_end: ['3', 0], length: '{{NUM_FRAMES}}', width: '{{WIDTH}}', height: '{{HEIGHT}}' },
  },
  6: { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: '{{FILENAME_PREFIX}}' } },
};

const VALUES = { FIRST_FRAME: 'a.png', LAST_FRAME: 'b.png', PROMPT: 'rain', NUM_FRAMES: 81, WIDTH: 832, HEIGHT: 480, FILENAME_PREFIX: 'p' };

test('default endpoint is local ComfyUI', () => {
  assert.equal(DEFAULT_COMFYUI_URL, 'http://127.0.0.1:8188');
});

test('buildWorkflow substitutes typed and embedded tokens', () => {
  const wf = buildWorkflow(WF, VALUES, { hasTarget: true });
  assert.equal(wf[1].inputs.image, 'a.png');
  assert.equal(wf[2].inputs.image, 'b.png');
  assert.equal(wf[4].inputs.text, 'Scene: rain');
  assert.equal(wf[5].inputs.length, 81);
  assert.equal(typeof wf[5].inputs.width, 'number');
  assert.deepEqual(wf[5].inputs.start_image, ['1', 0]);
  assert.equal(WF[1].inputs.image, '{{FIRST_FRAME}}', 'input workflow is not mutated');
});

test('buildWorkflow drops target-frame nodes and links when there is no target', () => {
  const { LAST_FRAME, ...noTarget } = VALUES; // eslint-disable-line no-unused-vars
  const wf = buildWorkflow(WF, noTarget, { hasTarget: false });
  assert.equal(wf[2], undefined);
  assert.equal(wf[3], undefined);
  assert.equal(wf[5].inputs.end_image, undefined);
  assert.equal(wf[5].inputs.clip_vision_end, undefined);
  assert.deepEqual(wf[5].inputs.start_image, ['1', 0]);
});

test('buildWorkflow rejects bad workflows and unresolved tokens', () => {
  assert.throws(() => buildWorkflow({ 1: { inputs: {} } }, VALUES), /API format/);
  assert.throws(() => buildWorkflow({ 1: { class_type: 'X', inputs: {} } }, VALUES), /FIRST_FRAME/);
  assert.throws(
    () => buildWorkflow({ 1: { class_type: 'LoadImage', inputs: { image: '{{FIRST_FRAME}}', x: '{{TYPO}}' } } }, VALUES),
    /\{\{TYPO\}\}/
  );
});

test('findVideoOutput finds video files in any output list', () => {
  assert.equal(findVideoOutput({ 9: { images: [{ filename: 'a.png' }] } }), null);
  assert.equal(findVideoOutput({ 9: { images: [{ filename: 'a.mp4', subfolder: '', type: 'output' }], animated: [true] } }).filename, 'a.mp4');
  assert.equal(findVideoOutput({ 9: { gifs: [{ filename: 'b.webm' }] } }).filename, 'b.webm');
});

test('pruning target nodes never leaves dangling links', () => {
  const withTarget = buildWorkflow(WF, VALUES, { hasTarget: true });
  const without = buildWorkflow(WF, VALUES, { hasTarget: false });
  assert.ok(Object.keys(without).length < Object.keys(withTarget).length);
  for (const node of Object.values(without)) {
    for (const v of Object.values(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string') assert.ok(without[v[0]], `dangling link to ${v[0]}`);
    }
  }
});

/** Minimal fake ComfyUI server implementing the standard endpoints. */
function fakeComfy({ failExecution = false } = {}) {
  const state = { uploads: [], prompts: [], polls: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      const name = /filename="([^"]+)"/.exec(body.toString('latin1'))[1];
      state.uploads.push({ name, body: body.toString('latin1') });
      return json({ name, subfolder: '', type: 'input' });
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      const parsed = JSON.parse(body.toString());
      state.prompts.push(parsed.prompt);
      return json({ prompt_id: `p${state.prompts.length}`, number: state.prompts.length, node_errors: {} });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      state.polls++;
      if (state.polls % 2 === 1) return json({}); // first poll: still running
      if (failExecution) {
        return json({
          [id]: {
            outputs: {},
            status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'KSampler', exception_message: 'OOM' }]] },
          },
        });
      }
      return json({
        [id]: {
          outputs: { 6: { images: [{ filename: `${id}.mp4`, subfolder: 'frame-chain', type: 'output' }], animated: [true] } },
          status: { status_str: 'success', completed: true, messages: [] },
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end(`VIDEO:${url.searchParams.get('subfolder')}/${url.searchParams.get('filename')}`);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test('ComfyUIBackend runs a full chain against the standard HTTP API', async (t) => {
  const { server, state, url } = await fakeComfy();
  t.after(() => server.close());
  const dir = await tempDir();
  const initial = await fakeImage(dir, 'start.png', 'initial');
  const target = await fakeImage(dir, 'target.png', 'target');
  const backend = new ComfyUIBackend({ workflow: WF, endpoint: url, pollIntervalMs: 5, seed: 42 });

  const res = await runChain(
    {
      initial_frame_uri: initial,
      scenes: [{ prompt: 'first' }, { prompt: 'second', duration_seconds: 3, target_frame_uri: target }],
      aspect_ratio: '1:1',
    },
    { backend, outDir: path.join(dir, 'out'), extractLastFrame: mockExtract }
  );

  assert.equal(res.clips.length, 2);
  assert.equal(await readFile(res.clips[0], 'utf8'), 'VIDEO:frame-chain/p1.mp4');
  assert.equal(state.prompts.length, 2);
  // Scene 1: no target -> target nodes removed.
  assert.equal(state.prompts[0][2], undefined);
  assert.equal(state.prompts[0][5].inputs.length, 81);
  assert.equal(state.prompts[0][5].inputs.width, 640);
  // Scene 2: second upload is scene 1's last frame, third is the target.
  assert.equal(state.uploads.length, 3);
  assert.match(state.uploads[1].body, /IMG:last-of-VIDEO:frame-chain\/p1\.mp4/);
  assert.match(state.uploads[2].body, /IMG:target/);
  assert.equal(state.prompts[1][2].inputs.image, state.uploads[2].name);
  assert.equal(state.prompts[1][5].inputs.length, 49);
  assert.equal(state.prompts[1][4].inputs.text, 'Scene: second');
});

test('ComfyUIBackend surfaces execution errors', async (t) => {
  const { server, url } = await fakeComfy({ failExecution: true });
  t.after(() => server.close());
  const dir = await tempDir();
  const backend = new ComfyUIBackend({ workflow: WF, endpoint: url, pollIntervalMs: 5 });
  await assert.rejects(
    backend.generateClip({
      index: 0, prompt: 'x', durationSeconds: 5, aspectRatio: '16:9',
      firstFramePath: await fakeImage(dir, 's.png'), targetFramePath: null, outputPath: path.join(dir, 'c.mp4'),
    }),
    /KSampler: OOM/
  );
});

test('ComfyUIBackend gives a clear error when ComfyUI is not reachable', async () => {
  const dir = await tempDir();
  const backend = new ComfyUIBackend({ workflow: WF, endpoint: 'http://127.0.0.1:9' });
  await assert.rejects(
    backend.generateClip({
      index: 0, prompt: 'x', durationSeconds: 5, aspectRatio: '16:9',
      firstFramePath: await fakeImage(dir, 's.png'), targetFramePath: null, outputPath: path.join(dir, 'c.mp4'),
    }),
    /is ComfyUI running/
  );
});
