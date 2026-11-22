# Reproduce

Ten minutes of setup, then the render time of three clips. Rendering spends credits or GPU time on your side; nothing in this folder renders for you.

## Path A: the CLI

Requirements: Node.js 20.3+, `ffmpeg`, and a backend. The CLI ships a ComfyUI adapter; the original clips used P-Video, which that adapter does not call, so results will differ with another model.

```bash
git clone https://github.com/fueledximagination/fxi-frame-chain.git
cd fxi-frame-chain
node bin/fxi-frame-chain.js validate templates/01-farmhouse-door-and-window/scenes.json
node bin/fxi-frame-chain.js run templates/01-farmhouse-door-and-window/scenes.json \
  --workflow my-workflow.api.json --out ./out
node bin/fxi-frame-chain.js stitch out/clips/scene-*.mp4 -o farmhouse.mp4
```

`scenes.json` starts from `inputs/clip-1-first-frame-derived.jpg`. That image is frame 0 of the finished clip 1, used only because the tool needs a starting image. Replace it with your own opening frame if you have one.

To do the hand-off by hand, take the chain frame by index:

```bash
ffmpeg -i clip1.mp4 -vf "select=eq(n\,119)" -frames:v 1 clip-2-first-frame.png
```

## Path B: run it on FXI Studio

You need an FXI Studio account. Generation uses credits from that account.

Through the connector (ChatGPT or Claude with the FXI Studio connector added), paste:

> Use frame_chain with the image at the URL I give you as the initial frame, aspect_ratio 16:9, and these three scenes, 5 seconds each, in order: (paste the three files in `prompts/` as the three prompts). Then show me the clip URLs.

The `frame_chain` tool takes `initial_frame_uri`, `scenes` (2 to 8, each with `prompt`, `duration_seconds`, optional `target_frame_uri`), `aspect_ratio` and `speed_ramping`. It returns separate clips, not one file; stitch them with the command above.

In the web studio at https://www.fxi.studio, follow the [frame chaining walkthrough](https://www.fxi.studio/tutorials/frame-chaining-storyboard-to-continuous-shot): generate clip 1 with P-Video, pull its last frame, start clip 2 on it, repeat.

## Check your seams

Compare the last chain frame of each clip with the first frame of the next. `ffmpeg -i a.png -i b.png -lavfi ssim -f null -` prints the score; this template measured 0.96 and 0.90.
