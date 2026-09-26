// Request / scene schema and validation.
//
// Shape (mirrors the hosted `frame_chain` tool's public interface):
//
//   {
//     initial_frame_uri: string,             // https:// URL or local file path; anchors clip 1
//     scenes: [                              // 2-8 items
//       { prompt: string,                    // required, non-empty
//         duration_seconds?: number,         // 3-10, default 5
//         target_frame_uri?: string }        // optional explicit end frame for this scene
//     ],
//     aspect_ratio?: '16:9' | '9:16' | '1:1',  // default '16:9', applied to every clip
//     idempotency_key?: string,              // <= 200 chars; safe retry without redoing finished clips
//     speed_ramping?: boolean                // metadata hint only (2x transitions, 1x holds)
//   }

import { ValidationError } from './errors.js';

export const LIMITS = Object.freeze({
  minScenes: 2,
  maxScenes: 8,
  minDurationSeconds: 3,
  maxDurationSeconds: 10,
  defaultDurationSeconds: 5,
  maxIdempotencyKeyLength: 200,
  maxPromptLength: 4000,
});

export const ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
export const DEFAULT_ASPECT_RATIO = '16:9';

const KNOWN_TOP_LEVEL = new Set([
  'initial_frame_uri',
  'scenes',
  'aspect_ratio',
  'idempotency_key',
  'speed_ramping',
]);
const KNOWN_SCENE = new Set(['prompt', 'duration_seconds', 'target_frame_uri']);

/**
 * Classify a frame URI. Only `https://` URLs and local file paths are accepted.
 * Returns { kind: 'https' | 'local' } or { error }.
 */
export function classifyFrameUri(uri) {
  if (typeof uri !== 'string' || uri.trim() === '') {
    return { error: 'must be a non-empty string' };
  }
  const value = uri.trim();
  if (/^https:\/\//i.test(value)) {
    try {
      // eslint-disable-next-line no-new
      new URL(value);
    } catch {
      return { error: 'is not a valid URL' };
    }
    return { kind: 'https' };
  }
  if (/^file:\/\//i.test(value)) return { kind: 'local' };
  // Any other scheme (http://, data:, s3://, custom://...) is rejected.
  // A Windows drive letter ("C:\...") is a local path, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return { error: 'must be an https:// URL or a local file path (other URI schemes are not supported)' };
  }
  return { kind: 'local' };
}

/**
 * Validate and normalize a frame-chain request. Returns a new object with
 * defaults applied. Throws ValidationError listing every issue found.
 */
export function validateRequest(input) {
  const issues = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(['request must be a JSON object']);
  }

  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL.has(key)) issues.push(`unknown field "${key}"`);
  }

  const initial = classifyFrameUri(input.initial_frame_uri);
  if (initial.error) issues.push(`initial_frame_uri ${initial.error}`);

  const aspect = input.aspect_ratio ?? DEFAULT_ASPECT_RATIO;
  if (!ASPECT_RATIOS.includes(aspect)) {
    issues.push(`aspect_ratio must be one of ${ASPECT_RATIOS.join(', ')} (got ${JSON.stringify(aspect)})`);
  }

  let idempotencyKey = input.idempotency_key;
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      issues.push('idempotency_key must be a non-empty string');
    } else if (idempotencyKey.length > LIMITS.maxIdempotencyKeyLength) {
      issues.push(`idempotency_key must be at most ${LIMITS.maxIdempotencyKeyLength} characters`);
    }
  } else {
    idempotencyKey = undefined;
  }

  const speedRamping = input.speed_ramping ?? false;
  if (typeof speedRamping !== 'boolean') issues.push('speed_ramping must be a boolean');

  const scenes = [];
  if (!Array.isArray(input.scenes)) {
    issues.push('scenes must be an array');
  } else {
    if (input.scenes.length < LIMITS.minScenes || input.scenes.length > LIMITS.maxScenes) {
      issues.push(
        `scenes must contain ${LIMITS.minScenes}-${LIMITS.maxScenes} items (got ${input.scenes.length})`
      );
    }
    input.scenes.forEach((scene, i) => {
      const at = `scenes[${i}]`;
      if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
        issues.push(`${at} must be an object`);
        return;
      }
      for (const key of Object.keys(scene)) {
        if (!KNOWN_SCENE.has(key)) issues.push(`${at}: unknown field "${key}"`);
      }
      if (typeof scene.prompt !== 'string' || scene.prompt.trim() === '') {
        issues.push(`${at}.prompt is required and must be a non-empty string`);
      } else if (scene.prompt.length > LIMITS.maxPromptLength) {
        issues.push(`${at}.prompt must be at most ${LIMITS.maxPromptLength} characters`);
      }
      const duration = scene.duration_seconds ?? LIMITS.defaultDurationSeconds;
      if (
        typeof duration !== 'number' ||
        !Number.isFinite(duration) ||
        duration < LIMITS.minDurationSeconds ||
        duration > LIMITS.maxDurationSeconds
      ) {
        issues.push(
          `${at}.duration_seconds must be a number between ${LIMITS.minDurationSeconds} and ${LIMITS.maxDurationSeconds}`
        );
      }
      let target;
      if (scene.target_frame_uri !== undefined && scene.target_frame_uri !== null) {
        const t = classifyFrameUri(scene.target_frame_uri);
        if (t.error) issues.push(`${at}.target_frame_uri ${t.error}`);
        target = typeof scene.target_frame_uri === 'string' ? scene.target_frame_uri.trim() : undefined;
      }
      scenes.push({
        prompt: typeof scene.prompt === 'string' ? scene.prompt.trim() : scene.prompt,
        duration_seconds: duration,
        ...(target ? { target_frame_uri: target } : {}),
      });
    });
  }

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    initial_frame_uri: input.initial_frame_uri.trim(),
    scenes,
    aspect_ratio: aspect,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    speed_ramping: speedRamping,
  };
}
