# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately, either way works:

- GitHub private vulnerability reporting: "Report a vulnerability" under this repository's **Security** tab, or
- email **contact@fxi.studio** with "SECURITY: fxi-frame-chain" in the subject.

You should get a response within a few days.

## Scope and hardening notes

- This tool talks to a video backend you run yourself. The ComfyUI adapter defaults to `http://127.0.0.1:8188`. Do not point it at a ComfyUI instance exposed to the internet without authentication in front of it.
- Frame URIs are limited to `https://` URLs and local file paths. Remote frames are downloaded with a 60-second timeout and a 50 MB size cap, must be served as `image/*`, and must not redirect to non-https URLs.
- Workflows are user-supplied JSON sent to your own ComfyUI. Only run workflows you trust; custom nodes can execute arbitrary code.
- Keep credentials in `.env` (git-ignored). `.env.example` holds placeholders only.

## Supported versions

Only the latest release receives fixes.
