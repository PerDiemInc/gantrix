---
name: media-video
description: Create short MP4 clips with Wan 2.2 5B (Apache-2.0) running in a local ComfyUI, from a prompt or a start image.
version: 1.0.0
tools: [list_files]
mcp-servers:
  media:
    command: gantrix-media-mcp
    env: { MEDIA_MODELS: wan-2.2-5b, MEDIA_VIDEO_QUALITY: standard }
    timeout-seconds: 3600
auto-approve: [media_list_media_models]
---
Use media_generate_video to create clips. Save them under clips/, for example clips/intro.mp4.
Clips have no sound. Each call needs approval, because a clip takes minutes: a 2 s clip at the
standard quality (832x480) takes about 3.5 minutes on a 48 GB Mac. Use quality "high"
(1280x704, about 12 minutes) only when the goal asks for it.

To animate an existing image, pass it as from_image; this keeps the character and the look.
Describe the motion in the prompt, and pick a camera move.

In your final reply, list each clip's path, size, length and what happens in it.
