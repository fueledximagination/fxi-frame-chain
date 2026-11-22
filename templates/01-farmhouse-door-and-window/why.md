# Why it works, and what the record shows

## Why chaining

An image-to-video model generates one clip and forgets it. Three clips started from three separate stills jump at every cut: the light moves, the camera snaps. Starting clip 2 from the real last frame of clip 1 gives the model the exact pixels the camera ended on, so the move continues instead of restarting.

## Choices that mattered here

- **One camera move per clip, and each prompt says where the move ends.** Clip 1 ends "framed on the farmhouse door"; clip 2 ends "framed on a wooden table with an oil lamp beside the window"; clip 3 starts "past the oil lamp toward the window". Each ending names the thing the next clip grows out of.
- **Each prompt after the first says "continuous" and "steady, unbroken".** The prompts describe motion only; the first frame supplies the scene.
- **Frame 119, not frame 120.** The frame used as the input to clip 2 matches frame 119 of clip 1 (SSIM 0.99) and not frame 120 (0.84). Taking the very last frame was not what was used. If you extract by timestamp on a variable frame rate file you can land on a different frame; select by index.
- **First frame only.** No clip was given a target last frame. Clip 3 ends on whatever the model made of "a wide aerial of the wheat field".

## What failed first

The generation records contain one finished take per clip and no failed attempts, so this section does not invent a ladder. What the finished chain does show:

1. A slightly weak second join (clip 3 frame 0 against its input: 0.90).
2. A grade shift in clip 2 (blue dusk between two golden shots).
3. Props from the prompt that the model dropped (open door, table).

General fixes for those, from the FXI frame-chaining guide: match camera speed across the hand-off, and repeat the lighting language in every prompt so the look does not drift. These were not tested on this chain.

## Prompts that differ from the public guide

The public FXI guide shows a recipe whose steps 2 and 3 use different wording (kitchen table, then out to a garden rose). The three prompts in this folder are the ones actually sent for the clips shown here; the guide's step 1 is identical to prompt 1.
