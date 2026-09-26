// The core frame-chaining loop.
//
//   start = initial frame
//   for each scene:
//     clip  = backend.generateClip(start, scene.prompt, scene.target?)
//     start = last frame of clip          <- the whole trick
//
// Every clip therefore begins on exactly the pixel content the previous clip
// ended on, so the clips play head-to-tail as one continuous shot.

import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { validateRequest } from './schema.js';
import { extractLastFrame as defaultExtractLastFrame, resolveFrameSource } from './frames.js';
import { Manifest } from './idempotency.js';
import { assertBackend } from './adapters/base.js';
import { BackendError, FrameChainError } from './errors.js';

const pad = (n) => String(n + 1).padStart(2, '0');

async function nonEmptyFile(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Run a frame chain.
 *
 * @param {object} request   see schema.js
 * @param {object} options
 * @param {object} options.backend            a VideoBackend (or any object with generateClip)
 * @param {string} [options.outDir='./frame-chain-output']
 * @param {Function} [options.extractLastFrame]  override (tests); defaults to ffmpeg extraction
 * @param {Function} [options.onProgress]     called with { type, index, total, ... } events
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetchImpl]      fetch used to download https:// frames
 * @returns {Promise<object>} { idempotency_key, clips, last_frames, aspect_ratio, speed_ramping, resumed, manifest_path }
 */
export async function runChain(request, options = {}) {
  const req = validateRequest(request);
  const backend = assertBackend(options.backend);
  const outDir = path.resolve(options.outDir ?? './frame-chain-output');
  const extract = options.extractLastFrame ?? defaultExtractLastFrame;
  const emit = options.onProgress ?? (() => {});
  const { signal, fetchImpl } = options;

  const dirs = {
    clips: path.join(outDir, 'clips'),
    frames: path.join(outDir, 'frames'),
    inputs: path.join(outDir, 'inputs'),
    state: path.join(outDir, '.frame-chain'),
  };
  await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));

  const manifest = await Manifest.open(dirs.state, req);
  await manifest.lock();

  const total = req.scenes.length;
  const clips = [];
  const lastFrames = [];
  let resumed = 0;

  try {
    let startFrame = await resolveFrameSource(req.initial_frame_uri, {
      downloadDir: dirs.inputs,
      name: 'initial',
      fetchImpl,
    });

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new FrameChainError('Frame chain aborted', { code: 'ABORTED' });
      const scene = req.scenes[i];

      // Idempotency: skip clips a previous run already finished.
      const done = await manifest.completed(i);
      if (done) {
        let lastFrame = done.last_frame_path;
        if (!(await nonEmptyFile(lastFrame))) {
          lastFrame = (await extract(done.clip_path, path.join(dirs.frames, `scene-${pad(i)}-last.png`))).path;
        }
        clips.push(done.clip_path);
        lastFrames.push(lastFrame);
        startFrame = lastFrame;
        resumed++;
        emit({ type: 'scene-skipped', index: i, total, clip: done.clip_path });
        continue;
      }

      const targetFrame = scene.target_frame_uri
        ? await resolveFrameSource(scene.target_frame_uri, {
            downloadDir: dirs.inputs,
            name: `scene-${pad(i)}-target`,
            fetchImpl,
          })
        : null;

      emit({ type: 'scene-start', index: i, total, firstFrame: startFrame, targetFrame });

      let result;
      try {
        result = await backend.generateClip({
          index: i,
          prompt: scene.prompt,
          durationSeconds: scene.duration_seconds,
          aspectRatio: req.aspect_ratio,
          firstFramePath: startFrame,
          targetFramePath: targetFrame,
          outputPath: path.join(dirs.clips, `scene-${pad(i)}.mp4`),
          signal,
        });
      } catch (err) {
        if (err instanceof FrameChainError) throw err;
        throw new BackendError(`Scene ${i + 1}/${total} failed: ${err.message}`, { cause: err });
      }
      if (!result?.path || !(await nonEmptyFile(result.path))) {
        throw new BackendError(`Scene ${i + 1}/${total}: backend returned no clip file`);
      }

      const frame = await extract(result.path, path.join(dirs.frames, `scene-${pad(i)}-last.png`));

      await manifest.markCompleted(i, {
        backend: backend.name ?? 'custom',
        prompt: scene.prompt,
        clip_path: result.path,
        first_frame_path: startFrame,
        last_frame_path: frame.path,
        ...(targetFrame ? { target_frame_path: targetFrame } : {}),
      });

      clips.push(result.path);
      lastFrames.push(frame.path);
      emit({ type: 'scene-done', index: i, total, clip: result.path, lastFrame: frame.path });

      // The hand-off: the next clip starts where this one actually ended.
      startFrame = frame.path;
    }
  } finally {
    await manifest.unlock();
  }

  return {
    idempotency_key: manifest.key,
    clips,
    last_frames: lastFrames,
    aspect_ratio: req.aspect_ratio,
    speed_ramping: req.speed_ramping
      ? { enabled: true, hint: 'play transitions/travel at 2x, detail holds at 1x' }
      : { enabled: false },
    resumed,
    manifest_path: manifest.filePath,
  };
}
