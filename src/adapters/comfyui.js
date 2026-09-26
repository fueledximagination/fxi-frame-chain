// Reference adapter for a local ComfyUI install, using ComfyUI's standard HTTP API:
//
//   POST /upload/image      upload the start (and optional target) frame
//   POST /prompt            queue the workflow
//   GET  /history/{id}      poll until the prompt finishes
//   GET  /view?filename=... download the rendered video
//
// You bring the workflow. Export it from ComfyUI with "Save (API Format)"
// ("Export (API)" in newer builds) and put these placeholder tokens in the
// node inputs you want filled per scene:
//
//   {{FIRST_FRAME}}       uploaded start image name   (e.g. LoadImage.image)      required
//   {{LAST_FRAME}}        uploaded target image name  (only when a scene has target_frame_uri)
//   {{PROMPT}}            scene prompt
//   {{DURATION_SECONDS}}  scene duration (number)
//   {{NUM_FRAMES}}        round(duration * fps) + 1 (number)
//   {{FPS}}               frames per second (number)
//   {{WIDTH}} {{HEIGHT}}  from aspect_ratio (numbers)
//   {{SEED}}              random per clip unless `seed` is set (number)
//   {{FILENAME_PREFIX}}   unique output prefix for this clip
//
// A value that is exactly one token (e.g. "{{NUM_FRAMES}}") is replaced with a
// typed value; tokens inside longer strings are replaced as text.
//
// Target-frame nodes: when a scene has no target_frame_uri, every node that
// contains {{LAST_FRAME}}, or whose _meta.title starts with "[target]", is
// removed, and any input on other nodes that pointed at a removed node is
// dropped (so those inputs must be optional, e.g. an end_image input).

import { randomUUID, randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { VideoBackend } from './base.js';
import { BackendError, FrameChainError } from '../errors.js';

export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

/** Generic starting resolutions per aspect ratio. Override with `resolutions`. */
export const DEFAULT_RESOLUTIONS = Object.freeze({
  '16:9': [832, 480],
  '9:16': [480, 832],
  '1:1': [640, 640],
});

const TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif|webp)$/i;
const TARGET_TITLE = /^\s*\[target\]/i;

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);

function containsToken(value, token) {
  if (typeof value === 'string') return value.includes(`{{${token}}}`);
  if (Array.isArray(value)) return value.some((v) => containsToken(v, token));
  if (value && typeof value === 'object') return Object.values(value).some((v) => containsToken(v, token));
  return false;
}

/**
 * Fill a ComfyUI API-format workflow with per-clip values. Pure function (exported for tests).
 * @param {object} workflow   API-format workflow: { "<node id>": { class_type, inputs, _meta? } }
 * @param {object} values     token -> value, e.g. { FIRST_FRAME: 'a.png', NUM_FRAMES: 81 }
 * @param {object} [opts]
 * @param {boolean} [opts.hasTarget]  keep target-frame nodes
 */
export function buildWorkflow(workflow, values, { hasTarget = false } = {}) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new FrameChainError('ComfyUI workflow must be an API-format JSON object ({ "<id>": { class_type, inputs } })');
  }
  if (Object.values(workflow).some((n) => !n || typeof n.class_type !== 'string')) {
    throw new FrameChainError(
      'ComfyUI workflow does not look like API format (nodes need "class_type"). ' +
        'Export it with "Save (API Format)" / "Export (API)".'
    );
  }
  if (!containsToken(workflow, 'FIRST_FRAME')) {
    throw new FrameChainError('ComfyUI workflow must contain the {{FIRST_FRAME}} token (e.g. in a LoadImage node)');
  }

  const wf = structuredClone(workflow);

  if (!hasTarget) {
    const removed = new Set(
      Object.entries(wf)
        .filter(([, node]) => containsToken(node.inputs, 'LAST_FRAME') || TARGET_TITLE.test(node._meta?.title ?? ''))
        .map(([id]) => id)
    );
    for (const id of removed) delete wf[id];
    for (const node of Object.values(wf)) {
      for (const [key, v] of Object.entries(node.inputs ?? {})) {
        if (isLink(v) && removed.has(v[0])) delete node.inputs[key];
      }
    }
  }

  const substitute = (v) => {
    if (typeof v === 'string') {
      const whole = /^\{\{([A-Z_]+)\}\}$/.exec(v);
      if (whole && whole[1] in values) return values[whole[1]];
      return v.replace(TOKEN_RE, (m, name) => (name in values ? String(values[name]) : m));
    }
    if (Array.isArray(v)) return isLink(v) ? v : v.map(substitute);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x)]));
    return v;
  };
  for (const node of Object.values(wf)) node.inputs = substitute(node.inputs ?? {});

  const leftover = JSON.stringify(Object.values(wf).map((n) => n.inputs)).match(TOKEN_RE);
  if (leftover) {
    throw new FrameChainError(`Unresolved workflow token(s): ${[...new Set(leftover)].join(', ')}`);
  }
  return wf;
}

/** Find the first video file in a ComfyUI /history outputs object. */
export function findVideoOutput(outputs) {
  for (const nodeOut of Object.values(outputs ?? {})) {
    for (const list of Object.values(nodeOut ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && typeof item.filename === 'string' && VIDEO_EXT.test(item.filename)) return item;
      }
    }
  }
  return null;
}

export class ComfyUIBackend extends VideoBackend {
  /**
   * @param {object} opts
   * @param {object} [opts.workflow]        API-format workflow object
   * @param {string} [opts.workflowPath]    or a path to one
   * @param {string} [opts.endpoint]        default http://127.0.0.1:8188
   * @param {number} [opts.fps=16]
   * @param {object} [opts.resolutions]     { '16:9': [w, h], ... }
   * @param {number} [opts.seed]            fixed seed (default: random per clip)
   * @param {number} [opts.pollIntervalMs=2000]
   * @param {number} [opts.timeoutMs=1800000]  per clip (30 min)
   * @param {Function} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    super();
    if (!opts.workflow && !opts.workflowPath) {
      throw new FrameChainError('ComfyUIBackend needs `workflow` or `workflowPath`');
    }
    this.workflow = opts.workflow ?? null;
    this.workflowPath = opts.workflowPath ?? null;
    this.endpoint = (opts.endpoint ?? DEFAULT_COMFYUI_URL).replace(/\/+$/, '');
    this.fps = opts.fps ?? 16;
    this.resolutions = { ...DEFAULT_RESOLUTIONS, ...(opts.resolutions ?? {}) };
    this.seed = opts.seed;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    this.clientId = randomUUID();
  }

  get name() {
    return 'comfyui';
  }

  async _loadWorkflow() {
    if (!this.workflow) this.workflow = JSON.parse(await readFile(this.workflowPath, 'utf8'));
    return this.workflow;
  }

  async _request(method, route, { body, headers, timeoutMs = 30_000, signal } = {}) {
    const signals = [AbortSignal.timeout(timeoutMs), signal].filter(Boolean);
    let res;
    try {
      res = await this.fetch(`${this.endpoint}${route}`, {
        method,
        body,
        headers,
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      throw new BackendError(`ComfyUI ${method} ${route} failed (is ComfyUI running at ${this.endpoint}?): ${err.message}`, {
        cause: err,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BackendError(`ComfyUI ${method} ${route} returned HTTP ${res.status}: ${text.slice(0, 2000)}`);
    }
    return res;
  }

  async _upload(filePath, signal) {
    const form = new FormData();
    const name = `frame-chain-${randomUUID().slice(0, 8)}-${path.basename(filePath)}`;
    form.append('image', new Blob([await readFile(filePath)]), name);
    form.append('overwrite', 'true');
    const res = await this._request('POST', '/upload/image', { body: form, signal });
    const json = await res.json();
    return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
  }

  async generateClip(job) {
    const workflow = await this._loadWorkflow();
    const [width, height] = this.resolutions[job.aspectRatio] ?? DEFAULT_RESOLUTIONS['16:9'];
    const hasTarget = Boolean(job.targetFramePath);

    const firstName = await this._upload(job.firstFramePath, job.signal);
    const lastName = hasTarget ? await this._upload(job.targetFramePath, job.signal) : undefined;

    const values = {
      FIRST_FRAME: firstName,
      PROMPT: job.prompt,
      DURATION_SECONDS: job.durationSeconds,
      NUM_FRAMES: Math.round(job.durationSeconds * this.fps) + 1,
      FPS: this.fps,
      WIDTH: width,
      HEIGHT: height,
      SEED: this.seed ?? randomInt(0, 2 ** 47),
      FILENAME_PREFIX: `frame-chain/scene-${String(job.index + 1).padStart(2, '0')}-${randomUUID().slice(0, 8)}`,
      ...(hasTarget ? { LAST_FRAME: lastName } : {}),
    };
    const prompt = buildWorkflow(workflow, values, { hasTarget });

    const queued = await (
      await this._request('POST', '/prompt', {
        body: JSON.stringify({ prompt, client_id: this.clientId }),
        headers: { 'content-type': 'application/json' },
        signal: job.signal,
      })
    ).json();
    if (!queued.prompt_id) {
      throw new BackendError(`ComfyUI did not queue the prompt: ${JSON.stringify(queued).slice(0, 2000)}`);
    }

    const entry = await this._waitForHistory(queued.prompt_id, job.signal);
    const video = findVideoOutput(entry.outputs);
    if (!video) {
      throw new BackendError(
        'ComfyUI finished but produced no video output. Make sure the workflow ends in a video save node.'
      );
    }

    const qs = new URLSearchParams({ filename: video.filename, subfolder: video.subfolder ?? '', type: video.type ?? 'output' });
    const res = await this._request('GET', `/view?${qs}`, { timeoutMs: 10 * 60 * 1000, signal: job.signal });
    const ext = path.extname(video.filename) || '.mp4';
    const outPath = job.outputPath.replace(/\.[^./\\]+$/, '') + ext;
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return { path: outPath, metadata: { prompt_id: queued.prompt_id, seed: values.SEED } };
  }

  async _waitForHistory(promptId, signal) {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new FrameChainError('Aborted while waiting for ComfyUI', { code: 'ABORTED' });
      const history = await (await this._request('GET', `/history/${encodeURIComponent(promptId)}`, { signal })).json();
      const entry = history?.[promptId];
      if (entry) {
        const status = entry.status ?? {};
        if (status.status_str === 'error') {
          const msg = (status.messages ?? [])
            .filter(([kind]) => kind === 'execution_error')
            .map(([, d]) => `${d?.node_type ?? 'node'}: ${d?.exception_message ?? 'error'}`)
            .join('; ');
          throw new BackendError(`ComfyUI execution failed${msg ? `: ${msg}` : ''}`);
        }
        if (status.completed !== false && entry.outputs && Object.keys(entry.outputs).length > 0) return entry;
        if (status.completed === true) return entry;
      }
      if (Date.now() > deadline) {
        throw new BackendError(`Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ComfyUI prompt ${promptId}`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }
}
