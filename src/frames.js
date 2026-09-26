// Frame utilities: exact last-frame extraction (system ffmpeg/ffprobe) and
// resolving a frame URI (https:// or local path) to a local file.
//
// No third-party dependencies: ffmpeg and ffprobe are invoked as system binaries.

import { spawn } from 'node:child_process';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameChainError } from './errors.js';
import { classifyFrameUri } from './schema.js';

function runBinary(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new FrameChainError(
            `'${bin}' was not found on PATH. Install ffmpeg (macOS: brew install ffmpeg, ` +
              'Debian/Ubuntu: sudo apt-get install ffmpeg, Windows: winget install Gyan.FFmpeg).',
            { code: 'FFMPEG_NOT_FOUND' }
          )
        );
      } else {
        reject(new FrameChainError(`Failed to run ${bin}: ${err.message}`, { cause: err }));
      }
    });
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        const tail = stderr.trim().split('\n').slice(-10).join('\n');
        reject(new FrameChainError(`${bin} exited with code ${exitCode}\n${tail}`, { code: 'FFMPEG_FAILED' }));
        return;
      }
      resolve(Buffer.concat(out));
    });
  });
}

export function ffmpeg(args) {
  return runBinary('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
}

export async function ffprobe(args) {
  return (await runBinary('ffprobe', ['-v', 'error', ...args])).toString().trim();
}

/** True when both ffmpeg and ffprobe can be executed. */
export async function hasFfmpeg() {
  try {
    await runBinary('ffmpeg', ['-version']);
    await runBinary('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function nonEmptyFile(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

/** Video-stream frame count: container metadata first, then a full decode count. */
export async function probeFrameCount(input) {
  const attempts = [
    ['-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'default=nokey=1:noprint_wrappers=1', input],
    [
      '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames',
      '-of', 'default=nokey=1:noprint_wrappers=1', input,
    ],
  ];
  for (const args of attempts) {
    try {
      const n = parseInt(await ffprobe(args), 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // try the next strategy
    }
  }
  return null;
}

export async function probeDuration(input) {
  try {
    const n = parseFloat(await ffprobe(['-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', input]));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Extract the exact last decoded frame of a video to an image file (PNG recommended:
 * lossless, so the next clip starts from exactly what the previous one ended on).
 *
 * 1. Exact: count frames, then select the frame at index (count - 1) by decode order.
 *    Correct for variable frame rate and odd GOP structures.
 * 2. Fallback: seek near end-of-file and keep the last frame ffmpeg can decode.
 */
export async function extractLastFrame(videoPath, outputPath) {
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });

  const count = await probeFrameCount(videoPath);
  if (count) {
    try {
      await ffmpeg([
        '-i', videoPath,
        '-vf', `select=eq(n\\,${count - 1})`,
        '-fps_mode', 'passthrough',
        '-frames:v', '1',
        '-y', outputPath,
      ]);
      if (await nonEmptyFile(outputPath)) {
        return { path: outputPath, method: 'select-by-index', frameIndex: count - 1, frameCount: count };
      }
    } catch {
      // fall through to the seek-based fallback
    }
  }

  const duration = await probeDuration(videoPath);
  const offset = duration ? Math.min(3, Math.max(0.2, duration * 0.5)) : 3;
  await ffmpeg(['-sseof', `-${offset}`, '-i', videoPath, '-update', '1', '-y', outputPath]);
  if (!(await nonEmptyFile(outputPath))) {
    throw new FrameChainError(`Could not extract the last frame of ${videoPath}`, { code: 'EXTRACT_FAILED' });
  }
  return { path: outputPath, method: 'sseof-fallback', offsetSeconds: offset };
}

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Resolve a frame URI to a local file path.
 *   - local paths (and file:// URLs) must exist and are returned as absolute paths
 *   - https:// URLs are downloaded into `downloadDir` (50 MB cap, 60 s timeout)
 */
export async function resolveFrameSource(uri, { downloadDir, name = 'frame', fetchImpl = globalThis.fetch } = {}) {
  const cls = classifyFrameUri(uri);
  if (cls.error) throw new FrameChainError(`Frame URI ${cls.error}: ${uri}`, { code: 'BAD_FRAME_URI' });

  if (cls.kind === 'local') {
    const p = /^file:\/\//i.test(uri) ? fileURLToPath(uri) : path.resolve(uri);
    if (!(await nonEmptyFile(p))) {
      throw new FrameChainError(`Frame file not found or empty: ${p}`, { code: 'FRAME_NOT_FOUND' });
    }
    return p;
  }

  if (!downloadDir) throw new FrameChainError('downloadDir is required to fetch remote frames');
  const res = await fetchImpl(uri, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new FrameChainError(`Failed to download ${uri}: HTTP ${res.status}`, { code: 'FRAME_DOWNLOAD_FAILED' });
  }
  if (res.url && !/^https:\/\//i.test(res.url)) {
    throw new FrameChainError(`Refusing non-https redirect while downloading ${uri}`, { code: 'FRAME_DOWNLOAD_FAILED' });
  }
  const type = res.headers.get('content-type') || '';
  if (type && !type.startsWith('image/')) {
    throw new FrameChainError(`Expected an image at ${uri}, got content-type ${type}`, { code: 'FRAME_DOWNLOAD_FAILED' });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_DOWNLOAD_BYTES) {
    throw new FrameChainError(`Downloaded frame is empty or larger than 50 MB: ${uri}`, { code: 'FRAME_DOWNLOAD_FAILED' });
  }
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type.split(';')[0]] ||
    path.extname(new URL(uri).pathname) || '.png';
  await mkdir(downloadDir, { recursive: true });
  const dest = path.join(downloadDir, `${name}${ext}`);
  await writeFile(dest, buf);
  return dest;
}
