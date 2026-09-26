// Run a frame chain against a local ComfyUI.
//
//   node examples/basic-chain.js <request.json> <your-workflow.api.json>
//
// The workflow is your own ComfyUI workflow, exported with "Save (API Format)",
// with placeholder tokens added (see workflows/README.md).
// Set COMFYUI_URL to point somewhere other than http://127.0.0.1:8188.
// Put your start image at ./start-frame.png (or edit initial_frame_uri).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runChain, ComfyUIBackend, DEFAULT_COMFYUI_URL } from '../src/index.js';

const [requestPath, workflowPath] = process.argv.slice(2);
if (!requestPath || !workflowPath) {
  console.error('Usage: node examples/basic-chain.js <request.json> <your-workflow.api.json>');
  console.error('Example request: examples/scenes.example.json. Workflow tokens: workflows/README.md');
  process.exit(2);
}

const request = JSON.parse(await readFile(requestPath, 'utf8'));
const backend = new ComfyUIBackend({
  workflowPath,
  endpoint: process.env.COMFYUI_URL ?? DEFAULT_COMFYUI_URL,
});

const result = await runChain(request, {
  backend,
  outDir: './frame-chain-output',
  onProgress: (e) => {
    if (e.type === 'scene-start') console.log(`[${e.index + 1}/${e.total}] generating from ${path.basename(e.firstFrame)}`);
    if (e.type === 'scene-done') console.log(`[${e.index + 1}/${e.total}] clip ready: ${e.clip}`);
    if (e.type === 'scene-skipped') console.log(`[${e.index + 1}/${e.total}] already done (idempotent resume)`);
  },
});

console.log('\nClips in order:');
for (const clip of result.clips) console.log(`  ${clip}`);
console.log('\nStitch them:  node bin/fxi-frame-chain.js stitch ' + result.clips.map((c) => JSON.stringify(c)).join(' ') + ' -o film.mp4');
