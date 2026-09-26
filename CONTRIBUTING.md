# Contributing

Thanks for helping. This repo is a small reference implementation, and the goal is to keep it small and readable.

## Setup

```bash
node --version   # 20.3 or newer
ffmpeg -version  # optional for most tests; the real-extraction test is skipped without it
npm test
npm run lint
```

There are no npm dependencies. Please keep it that way unless there is a strong reason; propose it in an issue first.

## Good contributions

- Bug fixes in the chaining loop, frame extraction, validation, or the ComfyUI adapter.
- New backend adapters that target **local or self-hosted** servers, with tests that run against a mock (no GPU in CI).
- Example ComfyUI workflows that you have actually run, built from public nodes and public models, with a note on the model license.
- Docs that make the technique easier to understand.

## Ground rules

- Every change ships with tests. `npm test` must pass without a GPU or network access.
- Never commit secrets, API keys, private hostnames or IP addresses, or personal file paths. Use `.env` (ignored) and `.env.example` (placeholders only).
- Do not add model weights or code under licenses incompatible with MIT.
- Keep the request schema compatible: the fields and limits in the README are the public contract.

## Pull requests

1. Fork, branch, and keep the change focused.
2. Run `npm test` and `npm run lint`.
3. Describe what changed and how you tested it.
