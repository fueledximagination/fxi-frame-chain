# Bring your own ComfyUI workflow

`fxi-frame-chain` works with any video model. You provide a ComfyUI workflow that already renders **one** good clip from a start image. For each scene, frame-chain fills in placeholder tokens, queues the workflow, and downloads the result.

## 1. Add tokens

Put these tokens in the node inputs you want filled for each scene:

| Token | Filled with | Typical node / input |
|---|---|---|
| `{{FIRST_FRAME}}` | uploaded start image (**required**) | `LoadImage.image` |
| `{{LAST_FRAME}}` | uploaded target image; only used for scenes with `target_frame_uri` | `LoadImage.image` |
| `{{PROMPT}}` | scene prompt | `CLIPTextEncode.text` |
| `{{NUM_FRAMES}}` | `round(duration_seconds * fps) + 1` | video latent `length` |
| `{{DURATION_SECONDS}}` | scene duration | any |
| `{{FPS}}` | `--fps` (default 16) | video create / save node |
| `{{WIDTH}}` / `{{HEIGHT}}` | from `aspect_ratio` (defaults: 832×480, 480×832, 640×640) | video latent `width` / `height` |
| `{{SEED}}` | random per clip | sampler `seed` |
| `{{FILENAME_PREFIX}}` | unique per clip | save node `filename_prefix` |

If an input's whole value is a single token, such as `"{{NUM_FRAMES}}"`, the token is replaced with a number. Tokens inside longer strings are replaced as text. A token left unfilled, for example a typo like `{{PROMT}}`, is an error.

## 2. Export in API format

In ComfyUI, use **Save (API Format)** (called **Export (API)** in newer builds). The regular "Save" format has a different structure and will be rejected.

The exported file maps node ids to nodes. After adding tokens, the start-image part looks like this:

```json
{
  "12": { "class_type": "LoadImage", "inputs": { "image": "{{FIRST_FRAME}}" } },
  "13": { "class_type": "LoadImage", "inputs": { "image": "{{LAST_FRAME}}" },
          "_meta": { "title": "[target] end frame" } },
  "20": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{PROMPT}}", "clip": ["4", 0] } }
}
```

## 3. Optional target (end) frame

First-last frame (FLF) workflows take a second image for the clip to end on. When a scene has **no** `target_frame_uri`:

- nodes that contain `{{LAST_FRAME}}`, or whose `_meta.title` starts with `[target]`, are removed;
- any input on another node that linked to a removed node is dropped.

For this to work, the end-frame branch must feed **optional** inputs, such as an `end_image` input. If your model has no end-frame support, leave `{{LAST_FRAME}}` out entirely. Target frames are then simply not used.

## Tips

- Make one clip look right in ComfyUI first. Chaining won't fix a workflow that produces weak single clips.
- Some models need the frame count in a particular form (for example `4n + 1`). With the default 16 fps, `{{NUM_FRAMES}}` always has that form. If you change `--fps`, check the value your model expects.
- The workflow must end in a node that saves a **video** file (mp4, webm, mov, mkv, gif, or webp).
