// See the chaining loop work with no GPU and no model: a toy backend that
// "generates" each clip by slowly zooming and hue-shifting its start frame with ffmpeg.
// Every clip really does start on the previous clip's extracted last frame.
//
//   node examples/mock-chain.js
//
// Requires ffmpeg. Output goes to ./frame-chain-mock-output.

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runChain, stitchClips, VideoBackend, hasFfmpeg } from '../src/index.js';
import { ffmpeg } from '../src/frames.js';

class ToyFfmpegBackend extends VideoBackend {
  get name() {
    return 'toy-ffmpeg';
  }

  async generateClip({ index, firstFramePath, outputPath }) {
    const fps = 12;
    const frames = fps * 1; // keep the demo fast: 1 s per clip regardless of duration_seconds
    await ffmpeg([
      '-loop', '1', '-i', firstFramePath,
      '-vf',
      `zoompan=z='1+0.004*on':d=${frames}:s=320x180:fps=${fps},hue=h='${20 + index * 5}*t'`,
      '-frames:v', String(frames),
      '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p',
      '-y', outputPath,
    ]);
    return { path: outputPath };
  }
}

if (!(await hasFfmpeg())) {
  console.error('This example needs ffmpeg on PATH.');
  process.exit(1);
}

const outDir = path.resolve('./frame-chain-mock-output');
await mkdir(outDir, { recursive: true });
const start = path.join(outDir, 'start-frame.png');
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180', '-frames:v', '1', '-y', start]);

const result = await runChain(
  {
    initial_frame_uri: start,
    scenes: [{ prompt: 'push in' }, { prompt: 'keep pushing' }, { prompt: 'and again' }],
    idempotency_key: 'mock-demo',
  },
  {
    backend: new ToyFfmpegBackend(),
    outDir,
    onProgress: (e) => e.type !== 'scene-start' && console.log(`${e.type} ${e.index + 1}/${e.total}`),
  }
);

console.log(`\n${result.clips.length} clips (resumed ${result.resumed}):`);
result.clips.forEach((c, i) => console.log(`  ${c}\n    last frame -> ${result.last_frames[i]}`));
const film = await stitchClips(result.clips, path.join(outDir, 'film.mp4'));
console.log(`\nStitched -> ${film.output} (${film.method})`);
console.log('Run it again: every clip is skipped thanks to the idempotency manifest.');
