#!/usr/bin/env node
// Command-line entry point.
//
//   fxi-frame-chain run <request.json> --workflow <workflow.api.json> [--endpoint URL] [--out DIR] [--fps N] [--json]
//   fxi-frame-chain validate <request.json>
//   fxi-frame-chain last-frame <video> [-o out.png]
//   fxi-frame-chain stitch <clip1> <clip2> ... -o film.mp4 [--reencode]
//   fxi-frame-chain ramp <clip> -o out.mp4 [--fast 2] [--hold 1] [--split seconds]

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runChain, validateRequest, extractLastFrame, stitchClips, speedRamp, ComfyUIBackend, DEFAULT_COMFYUI_URL, FrameChainError } from '../src/index.js';

const HELP = `fxi-frame-chain: seamless multi-clip AI video by chaining last frame -> first frame.

Usage:
  fxi-frame-chain run <request.json> --workflow <workflow.api.json> [options]
  fxi-frame-chain validate <request.json>
  fxi-frame-chain last-frame <video> [-o out.png]
  fxi-frame-chain stitch <clip1> <clip2> ... -o film.mp4 [--reencode]
  fxi-frame-chain ramp <clip> -o out.mp4 [--fast 2] [--hold 1] [--split seconds]

Options (run):
  --workflow <path>   ComfyUI workflow exported in API format, with {{TOKENS}} (see README)
  --endpoint <url>    ComfyUI URL (default: $COMFYUI_URL or ${DEFAULT_COMFYUI_URL})
  --out <dir>         Output directory (default: ./frame-chain-output)
  --fps <n>           Frames per second used for {{NUM_FRAMES}} / {{FPS}} (default: 16)
  --json              Print the result as JSON

Options (stitch / ramp):
  -o, --output <path> Output video
  --reencode          (stitch) skip the lossless stream-copy attempt and re-encode
  --fast <x>          (ramp) speed before the split (default 2)
  --hold <x>          (ramp) speed after the split (default 1)
  --split <seconds>   (ramp) where travel ends and the hold begins (default: half the clip)
  -h, --help          Show this help
`;

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (err) {
    throw new FrameChainError(`Could not read JSON from ${p}: ${err.message}`);
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workflow: { type: 'string' },
      endpoint: { type: 'string' },
      out: { type: 'string' },
      fps: { type: 'string' },
      output: { type: 'string', short: 'o' },
      reencode: { type: 'boolean', default: false },
      fast: { type: 'string' },
      hold: { type: 'string' },
      split: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, target, ...more] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case 'validate': {
      if (!target) throw new FrameChainError('validate needs a request JSON path');
      const req = validateRequest(await readJson(target));
      process.stdout.write(values.json ? JSON.stringify(req, null, 2) + '\n' : `OK: ${req.scenes.length} scenes, ${req.aspect_ratio}\n`);
      return 0;
    }
    case 'last-frame': {
      if (!target) throw new FrameChainError('last-frame needs a video path');
      const out = values.output ?? target.replace(/\.[^./\\]+$/, '') + '.last.png';
      const res = await extractLastFrame(target, out);
      process.stdout.write(values.json ? JSON.stringify(res, null, 2) + '\n' : `Last frame -> ${res.path} (${res.method})\n`);
      return 0;
    }
    case 'stitch': {
      const clips = [target, ...more].filter(Boolean);
      if (clips.length < 2) throw new FrameChainError('stitch needs at least 2 clips');
      const res = await stitchClips(clips, values.output ?? 'film.mp4', { reencode: values.reencode });
      process.stdout.write(values.json ? JSON.stringify(res, null, 2) + '\n' : `Stitched ${res.clips} clips -> ${res.output} (${res.method})\n`);
      return 0;
    }
    case 'ramp': {
      if (!target) throw new FrameChainError('ramp needs a clip path');
      const num = (v, name) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new FrameChainError(`--${name} must be a number`);
        return n;
      };
      const res = await speedRamp(target, values.output ?? target.replace(/\.[^./\\]+$/, '') + '.ramped.mp4', {
        fast: num(values.fast, 'fast') ?? 2,
        hold: num(values.hold, 'hold') ?? 1,
        split: num(values.split, 'split'),
      });
      process.stdout.write(
        values.json
          ? JSON.stringify(res, null, 2) + '\n'
          : `Ramped -> ${res.output} (${res.fast}x until ${res.splitAt.toFixed(2)}s, then ${res.hold}x)\n`
      );
      return 0;
    }
    case 'run': {
      if (!target) throw new FrameChainError('run needs a request JSON path');
      if (!values.workflow) throw new FrameChainError('run needs --workflow <workflow.api.json>');
      const backend = new ComfyUIBackend({
        workflowPath: values.workflow,
        endpoint: values.endpoint ?? process.env.COMFYUI_URL ?? DEFAULT_COMFYUI_URL,
        ...(values.fps ? { fps: Number(values.fps) } : {}),
      });
      const result = await runChain(await readJson(target), {
        backend,
        outDir: values.out,
        onProgress: (e) => {
          if (values.json) return;
          if (e.type === 'scene-start') process.stderr.write(`[${e.index + 1}/${e.total}] generating...\n`);
          if (e.type === 'scene-done') process.stderr.write(`[${e.index + 1}/${e.total}] done -> ${e.clip}\n`);
          if (e.type === 'scene-skipped') process.stderr.write(`[${e.index + 1}/${e.total}] already done, skipping\n`);
        },
      });
      if (values.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(`\n${result.clips.length} clips (in order):\n${result.clips.map((c) => `  ${c}`).join('\n')}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`Error: ${err instanceof FrameChainError ? err.message : err.stack ?? err}\n`);
  process.exitCode = 1;
}
