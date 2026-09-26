import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function tempDir(prefix = 'fxi-frame-chain-test-') {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Writes a small fake "image" file. */
export async function fakeImage(dir, name, content = name) {
  const p = path.join(dir, name);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `IMG:${content}`);
  return p;
}

/**
 * In-memory backend: writes a fake clip whose content records the frame it
 * started on, so tests can verify the last-frame hand-off.
 */
export function mockBackend({ failAt = new Set() } = {}) {
  const calls = [];
  return {
    name: 'mock',
    calls,
    async generateClip(job) {
      calls.push({ ...job, firstFrameContent: (await readFile(job.firstFramePath, 'utf8')) });
      if (failAt.has(job.index)) throw new Error(`boom at ${job.index}`);
      await mkdir(path.dirname(job.outputPath), { recursive: true });
      await writeFile(job.outputPath, `CLIP:${job.index}`);
      return { path: job.outputPath };
    },
  };
}

/** Fake extractor: the "last frame" of clip N is an image whose content says "last-of-CLIP:N". */
export async function mockExtract(clipPath, outPath) {
  const clip = await readFile(clipPath, 'utf8');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `IMG:last-of-${clip}`);
  return { path: outPath, method: 'mock' };
}
