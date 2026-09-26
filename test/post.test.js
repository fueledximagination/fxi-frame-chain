// stitch + ramp tests against real ffmpeg. Skipped automatically when ffmpeg/ffprobe are not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { stitchClips, speedRamp, hasFfmpeg, FrameChainError } from '../src/index.js';
import { ffmpeg, probeDuration, probeFrameCount } from '../src/frames.js';
import { tempDir } from './helpers.js';

const ffmpegAvailable = await hasFfmpeg();
const skip = !ffmpegAvailable && 'ffmpeg not installed';

async function makeClip(dir, name, { color = 'red', size = '64x64', rate = 10, seconds = 1 } = {}) {
  const out = path.join(dir, name);
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${rate}:d=${seconds}`,
    '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', '-y', out,
  ]);
  return out;
}

test('stitch: matching clips use a lossless stream copy', { skip }, async () => {
  const dir = await tempDir();
  const a = await makeClip(dir, 'a.mp4', { color: 'red' });
  const b = await makeClip(dir, 'b.mp4', { color: 'blue' });
  const res = await stitchClips([a, b], path.join(dir, 'out', 'film.mp4'));
  assert.equal(res.method, 'concat-copy');
  assert.equal(res.clips, 2);
  assert.equal(await probeFrameCount(res.output), 20);
  assert.ok(Math.abs((await probeDuration(res.output)) - 2) < 0.2);
});

test('stitch: mismatched clips fall back to a re-encode automatically', { skip }, async () => {
  const dir = await tempDir();
  const a = await makeClip(dir, 'a.mp4', { size: '64x64', rate: 10 });
  const b = await makeClip(dir, 'b.mp4', { size: '64x64', rate: 20 });
  const res = await stitchClips([a, b], path.join(dir, 'film.mp4'));
  assert.equal(res.method, 'concat-reencode');
  assert.ok(Math.abs((await probeDuration(res.output)) - 2) < 0.3);
});

test('stitch: --reencode forces the re-encode path', { skip }, async () => {
  const dir = await tempDir();
  const a = await makeClip(dir, 'a.mp4');
  const b = await makeClip(dir, 'b.mp4');
  const res = await stitchClips([a, b], path.join(dir, 'film.mp4'), { reencode: true });
  assert.equal(res.method, 'concat-reencode');
});

test('stitch: rejects fewer than 2 clips and missing files', async () => {
  await assert.rejects(stitchClips(['only.mp4'], 'x.mp4'), FrameChainError);
  await assert.rejects(stitchClips(['missing-a.mp4', 'missing-b.mp4'], 'x.mp4'), /not found/);
});

test('ramp: 2x before the split, 1x after', { skip }, async () => {
  const dir = await tempDir();
  const clip = await makeClip(dir, 'clip.mp4', { seconds: 2 });
  const res = await speedRamp(clip, path.join(dir, 'ramped.mp4'), { fast: 2, hold: 1, split: 1 });
  assert.equal(res.expectedDuration, 1.5);
  assert.ok(Math.abs((await probeDuration(res.output)) - 1.5) < 0.2, 'ramped clip is ~1.5 s');
});

test('ramp: validates split and speeds', { skip }, async () => {
  const dir = await tempDir();
  const clip = await makeClip(dir, 'clip.mp4', { seconds: 2 });
  await assert.rejects(speedRamp(clip, path.join(dir, 'x.mp4'), { split: 5 }), /split must be between/);
  await assert.rejects(speedRamp(clip, path.join(dir, 'x.mp4'), { fast: 0 }), /positive/);
});
