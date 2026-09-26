// File-based idempotency manifest.
//
// Each chain run is identified by an idempotency key: the caller-supplied
// `idempotency_key`, or (if none) a SHA-256 of the canonicalized request, so an
// identical retry is deduplicated even without an explicit key.
//
// The manifest records every completed clip. Re-running the same request with
// the same key skips clips that are already done and resumes from the first
// missing one, using the stored last frame as its start frame. Reusing a key
// with a *different* request is an error rather than a silent mix of clips.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FrameChainError } from './errors.js';

/** Stable JSON with sorted object keys, so identical shapes hash identically. */
export function canonicalStringify(value) {
  const walk = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Fingerprint of the parts of a request that determine the clips (everything but the key). */
export function requestFingerprint(request) {
  // eslint-disable-next-line no-unused-vars
  const { idempotency_key, ...rest } = request;
  return sha256(canonicalStringify(rest));
}

/** Caller-supplied key wins; otherwise derive one from the request itself. */
export function deriveIdempotencyKey(request) {
  return request.idempotency_key || `auto-${requestFingerprint(request).slice(0, 32)}`;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class Manifest {
  constructor(filePath, data) {
    this.filePath = filePath;
    this.data = data;
    this.lockPath = `${filePath}.lock`;
    this._lockHandle = null;
  }

  /**
   * Open (or create) the manifest for `request` under `stateDir`.
   * Throws if the key was previously used with a different request.
   */
  static async open(stateDir, request) {
    const key = deriveIdempotencyKey(request);
    const fingerprint = requestFingerprint(request);
    await mkdir(stateDir, { recursive: true });
    const filePath = path.join(stateDir, `${sha256(key).slice(0, 40)}.json`);

    let data;
    if (await exists(filePath)) {
      data = JSON.parse(await readFile(filePath, 'utf8'));
      if (data.fingerprint !== fingerprint) {
        throw new FrameChainError(
          `idempotency_key "${key}" was already used for a different request. ` +
            'Use a new key, or delete the manifest to start over: ' + filePath,
          { code: 'IDEMPOTENCY_MISMATCH' }
        );
      }
    } else {
      data = {
        version: 1,
        idempotency_key: key,
        fingerprint,
        created_at: new Date().toISOString(),
        clips: {},
      };
    }
    return new Manifest(filePath, data);
  }

  get key() {
    return this.data.idempotency_key;
  }

  /**
   * Take an exclusive lock so two processes never run the same chain at once.
   * A stale lock (from a crashed run) must be deleted manually; the error says where.
   */
  async lock() {
    try {
      this._lockHandle = await open(this.lockPath, 'wx');
      await this._lockHandle.writeFile(String(process.pid));
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new FrameChainError(
          `Another run holds the lock for "${this.key}". If no other run is active, delete ${this.lockPath}`,
          { code: 'IDEMPOTENCY_LOCKED' }
        );
      }
      throw err;
    }
  }

  async unlock() {
    if (this._lockHandle) {
      await this._lockHandle.close();
      this._lockHandle = null;
      await rm(this.lockPath, { force: true });
    }
  }

  /** The completed record for scene `index`, but only if its clip file still exists. */
  async completed(index) {
    const rec = this.data.clips[String(index)];
    if (!rec || rec.status !== 'completed') return null;
    if (!(await exists(rec.clip_path))) return null;
    return rec;
  }

  async markCompleted(index, record) {
    this.data.clips[String(index)] = {
      ...record,
      status: 'completed',
      completed_at: new Date().toISOString(),
    };
    await this.save();
  }

  /** Atomic write: temp file + rename, so a crash never leaves a half-written manifest. */
  async save() {
    this.data.updated_at = new Date().toISOString();
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    await rename(tmp, this.filePath);
  }
}
