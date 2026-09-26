// Post-processing for a finished chain: stitch clips into one file, and a
// simple two-speed ramp (fast travel, normal-speed hold).
//
// Both use the system ffmpeg/ffprobe; no third-party dependencies.

import path from 'node:path';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ffmpeg, ffprobe, probeDuration } from './frames.js';
import { FrameChainError } from './errors.js';

async function nonEmptyFile(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

/** Codec, size, pixel format and frame rate of the first video stream ('' if unreadable). */
async function streamSignature(clip) {
  try {
    return await ffprobe([
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate',
      '-of', 'csv=p=0',
      clip,
    ]);
  } catch {
    return '';
  }
}

/** A stream copy is only attempted when every clip has the same video stream parameters. */
async function streamsMatch(clips) {
  const sigs = await Promise.all(clips.map(streamSignature));
  return sigs[0] !== '' && sigs.every((s) => s === sigs[0]);
}

/**
 * Lossless stream-copy concat. Only valid when every clip shares codec,
 * resolution, pixel format and timebase. ffmpeg's concat demuxer can exit 0 on
 * a mismatch while writing a file with broken timing, so the output duration
 * is cross-checked against the sum of the inputs; a mismatch counts as failure.
 */
async function tryConcatCopy(clips, output) {
  const listDir = await mkdtemp(path.join(tmpdir(), 'fxi-frame-chain-'));
  const listFile = path.join(listDir, 'concat.txt');
  try {
    const lines = clips.map((c) => `file '${path.resolve(c).replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listFile, lines, 'utf8');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', output]);
    if (!(await nonEmptyFile(output))) return false;

    const [outDuration, ...inDurations] = await Promise.all([probeDuration(output), ...clips.map((c) => probeDuration(c))]);
    const expected = inDurations.reduce((sum, d) => sum + (d || 0), 0);
    if (!outDuration || !expected) return true; // cannot verify; trust ffmpeg's exit code
    return Math.abs(outDuration - expected) <= Math.max(0.5, expected * 0.03);
  } catch {
    return false;
  } finally {
    await rm(listDir, { recursive: true, force: true });
  }
}

/**
 * Video-only re-encode concat. Works across mismatched clips. Audio is left
 * out on purpose: AI clips are often silent or carry mismatched audio streams.
 */
async function concatReencode(clips, output) {
  const inputs = clips.flatMap((c) => ['-i', c]);
  const filter = `${clips.map((_, i) => `[${i}:v:0]`).join('')}concat=n=${clips.length}:v=1:a=0[outv]`;
  try {
    await ffmpeg([...inputs, '-filter_complex', filter, '-map', '[outv]', '-pix_fmt', 'yuv420p', '-y', output]);
  } catch (err) {
    throw new FrameChainError(`Re-encoded concat failed: ${err.message}`, { code: 'STITCH_FAILED', cause: err });
  }
  if (!(await nonEmptyFile(output))) {
    throw new FrameChainError('Re-encoded concat produced no output', { code: 'STITCH_FAILED' });
  }
}

/**
 * Stitch clips (in order) into one video. Tries a fast lossless stream copy
 * first and falls back to a re-encode automatically.
 *
 * @param {string[]} clips   2+ video paths, in play order
 * @param {string} output    output path (e.g. film.mp4)
 * @param {object} [opts]
 * @param {boolean} [opts.reencode=false]  skip the stream-copy attempt
 * @returns {Promise<{ output, method: 'concat-copy'|'concat-reencode', clips: number }>}
 */
export async function stitchClips(clips, output, { reencode = false } = {}) {
  if (!Array.isArray(clips) || clips.length < 2) {
    throw new FrameChainError('stitch needs at least 2 clips', { code: 'STITCH_FAILED' });
  }
  for (const c of clips) {
    if (!(await nonEmptyFile(c))) throw new FrameChainError(`Clip not found or empty: ${c}`, { code: 'STITCH_FAILED' });
  }
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  if (!reencode && (await streamsMatch(clips)) && (await tryConcatCopy(clips, output))) {
    return { output, method: 'concat-copy', clips: clips.length };
  }
  await concatReencode(clips, output);
  return { output, method: 'concat-reencode', clips: clips.length };
}

/**
 * Two-segment speed ramp: play 0..split at `fast`x (travel / transition) and
 * split..end at `hold`x (the detail hold). This is the "2x transitions, 1x
 * holds" edit that the `speed_ramping` request flag hints at.
 * Video-only: ramped audio would need pitch correction, which is out of scope.
 *
 * @param {string} input
 * @param {string} output
 * @param {object} [opts]
 * @param {number} [opts.fast=2]   speed multiplier before the split
 * @param {number} [opts.hold=1]   speed multiplier after the split
 * @param {number} [opts.split]    split point in seconds (default: half the clip)
 */
export async function speedRamp(input, output, { fast = 2, hold = 1, split } = {}) {
  if (!(fast > 0) || !(hold > 0)) {
    throw new FrameChainError('fast and hold must be positive numbers', { code: 'RAMP_FAILED' });
  }
  const duration = await probeDuration(input);
  if (!duration) throw new FrameChainError(`Could not read the duration of ${input}`, { code: 'RAMP_FAILED' });
  const splitAt = split != null ? Number(split) : duration / 2;
  if (!(splitAt > 0 && splitAt < duration)) {
    throw new FrameChainError(`split must be between 0 and the clip duration (${duration.toFixed(2)}s)`, { code: 'RAMP_FAILED' });
  }
  const filter =
    `[0:v]trim=0:${splitAt},setpts=(PTS-STARTPTS)/${fast}[v1];` +
    `[0:v]trim=${splitAt}:${duration},setpts=(PTS-STARTPTS)/${hold}[v2];` +
    '[v1][v2]concat=n=2:v=1:a=0[outv]';
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await ffmpeg(['-i', input, '-filter_complex', filter, '-map', '[outv]', '-pix_fmt', 'yuv420p', '-y', output]);
  if (!(await nonEmptyFile(output))) {
    throw new FrameChainError(`Speed ramp produced no output for ${input}`, { code: 'RAMP_FAILED' });
  }
  return {
    output,
    splitAt,
    fast,
    hold,
    inputDuration: duration,
    expectedDuration: splitAt / fast + (duration - splitAt) / hold,
  };
}
