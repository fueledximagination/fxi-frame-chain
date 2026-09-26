// Real ffmpeg tests. Skipped automatically when ffmpeg/ffprobe are not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractLastFrame, hasFfmpeg, resolveFrameSource } from '../src/index.js';
import { ffmpeg, probeFrameCount } from '../src/frames.js';
import { tempDir } from './helpers.js';

const ffmpegAvailable = await hasFfmpeg();

/** Average RGB of an image, via ffmpeg scaling it to a single pixel. */
async function averageColor(imagePath) {
  const buf = await ffmpeg(['-i', imagePath, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return { r: buf[0], g: buf[1], b: buf[2] };
}

test('extracts the true last frame of a real clip', { skip: !ffmpegAvailable && 'ffmpeg not installed' }, async () => {
  const dir = await tempDir();
  const clip = path.join(dir, 'clip.mp4');
  // 1.0 s of red followed by 0.2 s of blue at 10 fps = 12 frames; only the last 2 are blue.
  await ffmpeg([
    '-filter_complex',
    'color=c=red:s=64x64:r=10:d=1[a];color=c=blue:s=64x64:r=10:d=0.2[b];[a][b]concat=n=2:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'mpeg4', '-q:v', '2', '-y', clip,
  ]);
  assert.equal(await probeFrameCount(clip), 12);

  const res = await extractLastFrame(clip, path.join(dir, 'frames', 'last.png'));
  assert.equal(res.method, 'select-by-index');
  assert.equal(res.frameIndex, 11);
  const { r, b } = await averageColor(res.path);
  assert.ok(b > 150 && r < 100, `expected a blue last frame, got r=${r} b=${b}`);
});

test('resolveFrameSource rejects missing local files', async () => {
  await assert.rejects(resolveFrameSource('./definitely-missing.png'), /not found/);
});
