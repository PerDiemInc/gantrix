---
name: media-images
description: Create and vary PNG images with Z-Image-Turbo (Apache-2.0) running in a local ComfyUI.
version: 1.0.0
tools: [list_files]
mcp-servers:
  media:
    command: gantrix-media-mcp
    env: { MEDIA_MODELS: z-image-turbo }
    timeout-seconds: 600
auto-approve: [media_list_media_models, media_generate_image]
---
Use media_generate_image to create images. Save them under art/ with clear file names, for
example art/hero.png. A 1024x1024 image takes about half a minute.

from_image makes variations of an existing image: up to strength 0.8 it keeps the layout and
colours; 0.95 makes a new picture loosely based on it. It can't keep a character while changing
the scene, so for a new scene write a full new prompt instead.

In your final reply, list each image's path, its size and what it shows.
