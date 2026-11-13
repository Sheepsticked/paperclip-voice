#!/usr/bin/env bash
# Sets up the speech models for the plugin: a Python venv with onnx-asr and Parakeet v3, using the GPU build of
# ONNX Runtime when nvidia-smi finds an NVIDIA GPU. With --whisper it also sets up faster-whisper and the Whisper
# "small" model for the language re-check. Safe to run again; a model already on disk is not downloaded again.
#
#   scripts/install-models.sh [--whisper] [--cpu]
#
# --cpu installs the CPU build even when there is a GPU. The folders are under ${XDG_DATA_HOME:-~/.local/share}/paperclip-voice,
# which is where the plugin looks by default.
set -euo pipefail

with_whisper=false
force_cpu=false
for arg in "$@"; do
  case "$arg" in
    --whisper) with_whisper=true ;;
    --cpu) force_cpu=true ;;
    *) echo "install-models: unknown option $arg (use --whisper, --cpu)" >&2; exit 1 ;;
  esac
done

base="${XDG_DATA_HOME:-$HOME/.local/share}/paperclip-voice"
command -v python3 >/dev/null 2>&1 || { echo "install-models: python3 is not on PATH" >&2; exit 1; }

venv() {
  [ -x "$1/bin/python" ] || python3 -m venv "$1" || { echo "install-models: could not create $1 (is python3-venv installed?)" >&2; exit 1; }
}
pip_install() {
  "$1/bin/python" -m pip install --quiet --disable-pip-version-check --no-input "${@:2}"
}

parakeet="$base/parakeet"
venv "$parakeet"
if ! $force_cpu && nvidia-smi >/dev/null 2>&1; then
  runtime="onnxruntime-gpu[cuda,cudnn]==1.31.1"
  other=onnxruntime
  echo "NVIDIA GPU found: installing the GPU build (a few GB with the CUDA libraries)"
else
  runtime="onnxruntime==1.31.1"
  other=onnxruntime-gpu
  echo "installing the CPU build"
fi
# Both builds provide the same module, so the one not wanted is removed first.
"$parakeet/bin/python" -m pip uninstall --quiet --disable-pip-version-check --yes "$other" >/dev/null 2>&1 || true
pip_install "$parakeet" "onnx-asr[hub]==0.12.0" "$runtime" "av>=15,<17"
mkdir -p "$parakeet/models"
echo "loading Parakeet v3 (downloads about 2.4 GB the first time)"
# The first load downloads the model into its folder; later loads only read it.
"$parakeet/bin/python" -c 'import sys, onnx_asr; onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path=sys.argv[1], providers=["CPUExecutionProvider"])' "$parakeet/models/parakeet-v3"
echo "Parakeet is ready in $parakeet"

if $with_whisper; then
  whisper="$base/whisper"
  venv "$whisper"
  # PyAV 16 and later break faster-whisper 1.2.1, so it stays below 16.
  pip_install "$whisper" "faster-whisper==1.2.1" "av>=15,<16"
  mkdir -p "$whisper/models"
  echo "loading Whisper small (downloads about 500 MB the first time)"
  "$whisper/bin/python" -c 'import sys; from faster_whisper import download_model; download_model("small", cache_dir=sys.argv[1])' "$whisper/models"
  echo "Whisper is ready in $whisper"
fi
