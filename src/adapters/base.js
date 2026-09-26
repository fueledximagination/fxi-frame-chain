// The backend adapter interface.
//
// A backend turns ONE scene into ONE video clip. The chain loop owns everything
// else (validation, ordering, last-frame hand-off, idempotency), so an adapter
// for a new video model or server is usually a single method.
//
//   class MyBackend extends VideoBackend {
//     get name() { return 'my-backend'; }
//     async generateClip(job) {
//       // job.firstFramePath    local image the clip must START on
//       // job.targetFramePath   local image the clip should END on, or null
//       // job.prompt            scene prompt
//       // job.durationSeconds   3-10
//       // job.aspectRatio       '16:9' | '9:16' | '1:1'
//       // job.outputPath        suggested path for the clip (.mp4); you may change the extension
//       // job.index             0-based scene index
//       // job.signal            AbortSignal (may be undefined)
//       ...
//       return { path: job.outputPath };   // path of the finished clip on local disk
//     }
//   }

import { FrameChainError } from '../errors.js';

export class VideoBackend {
  /** Short identifier recorded in the manifest. */
  get name() {
    return this.constructor.name;
  }

  /**
   * Generate one clip. Must resolve to `{ path }` pointing at a finished,
   * non-empty video file on local disk.
   * @param {object} job
   * @returns {Promise<{ path: string, metadata?: object }>}
   */
  // eslint-disable-next-line no-unused-vars
  async generateClip(job) {
    throw new FrameChainError(`${this.name}.generateClip() is not implemented`, { code: 'NOT_IMPLEMENTED' });
  }
}

/** Duck-typed check so plain objects `{ generateClip() {} }` work too. */
export function assertBackend(backend) {
  if (!backend || typeof backend.generateClip !== 'function') {
    throw new FrameChainError('backend must implement generateClip(job)', { code: 'BAD_BACKEND' });
  }
  return backend;
}
