#!/usr/bin/env bash
# Installs ComfyUI and the open models Gantrix's media skills use, then you start ComfyUI yourself.
#   scripts/setup-comfyui.sh images   # Z-Image-Turbo only (~20.7 GB)
#   scripts/setup-comfyui.sh video    # Wan 2.2 5B only (~22.8 GB)
#   scripts/setup-comfyui.sh all      # both (default)
# Set COMFYUI_DIR to install somewhere other than ~/ComfyUI. Safe to re-run: downloads resume.
set -euo pipefail

WHAT="${1:-all}"
DIR="${COMFYUI_DIR:-$HOME/ComfyUI}"
VERSION="v0.42.1" # pinned: the version Gantrix's workflows were tested with
HF="https://huggingface.co/Comfy-Org"

case "$WHAT" in images | video | all) ;; *) echo "usage: $0 [images|video|all]" >&2; exit 1 ;; esac
command -v uv >/dev/null || { echo "Needs uv (https://docs.astral.sh/uv/): brew install uv" >&2; exit 1; }

if [ ! -d "$DIR/.git" ]; then
  echo "== Cloning ComfyUI $VERSION into $DIR"
  git clone -q --depth 1 --branch "$VERSION" https://github.com/Comfy-Org/ComfyUI.git "$DIR"
fi
cd "$DIR"

if [ ! -x .venv/bin/python ]; then
  echo "== Python environment"
  # On Apple Silicon use a native arm64 Python: an Intel (Rosetta) one has no GPU support.
  if [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ]; then
    uv venv -q --python cpython-3.12-macos-aarch64 .venv
  else
    uv venv -q --python 3.12 .venv
  fi
  uv pip install -q --python .venv/bin/python torch torchvision torchaudio
  uv pip install -q --python .venv/bin/python -r requirements.txt
fi
.venv/bin/python -c "import torch; print('torch', torch.__version__, '| Apple GPU (MPS):', torch.backends.mps.is_available(), '| CUDA:', torch.cuda.is_available())"

get() { # repo, path inside split_files, target folder
  mkdir -p "models/$3"
  local out="models/$3/$(basename "$2")"
  echo "== $out"
  curl -fL -C - --progress-bar -o "$out" "$HF/$1/resolve/main/split_files/$2"
}
# Full-precision files: the smaller fp8/fp4 builds don't work on Apple's GPU.
if [ "$WHAT" != video ]; then
  get z_image_turbo diffusion_models/z_image_turbo_bf16.safetensors diffusion_models
  get z_image_turbo text_encoders/qwen_3_4b.safetensors text_encoders
  get z_image_turbo vae/ae.safetensors vae
fi
if [ "$WHAT" != images ]; then
  get Wan_2.2_ComfyUI_Repackaged diffusion_models/wan2.2_ti2v_5B_fp16.safetensors diffusion_models
  get Wan_2.2_ComfyUI_Repackaged text_encoders/umt5_xxl_fp16.safetensors text_encoders
  get Wan_2.2_ComfyUI_Repackaged vae/wan2.2_vae.safetensors vae
fi

echo
echo "Done. Start ComfyUI (keep it running while Gantrix generates media):"
echo "  cd $DIR && .venv/bin/python main.py --listen 127.0.0.1 --port 8188"
