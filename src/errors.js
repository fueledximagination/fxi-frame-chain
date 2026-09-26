// Error types shared across the library.

/** Base error for everything this package throws on purpose. */
export class FrameChainError extends Error {
  constructor(message, { code = 'FRAME_CHAIN_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FrameChainError';
    this.code = code;
  }
}

/** The request (initial frame + scenes) failed validation. `issues` lists every problem found. */
export class ValidationError extends FrameChainError {
  constructor(issues) {
    super(`Invalid frame-chain request:\n  - ${issues.join('\n  - ')}`, { code: 'VALIDATION_ERROR' });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** A video backend (adapter) failed to produce a clip. */
export class BackendError extends FrameChainError {
  constructor(message, { cause } = {}) {
    super(message, { code: 'BACKEND_ERROR', cause });
    this.name = 'BackendError';
  }
}
