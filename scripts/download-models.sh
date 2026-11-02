#!/usr/bin/env bash
# Phase 0: sherpa-onnx の日本語対応モデルと VAD を .cache/models/ に取得する。
# 各アーカイブはモデル名のディレクトリに展開する（取得済みならスキップ）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.cache/models"
BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
mkdir -p "$DEST"

fetch_file() {
  local name="$1"
  if [ -f "$DEST/$name" ]; then echo "skip $name"; return; fi
  curl -fsSL --retry 3 -o "$DEST/$name.part" "$BASE/$name"
  mv "$DEST/$name.part" "$DEST/$name"
  echo "done $name"
}

fetch_archive() {
  local name="$1" dir="$DEST/$1"
  if [ -d "$dir" ]; then echo "skip $name"; return; fi
  local start=$SECONDS
  curl -fsSL --retry 3 -o "$DEST/$name.tar.bz2" "$BASE/$name.tar.bz2"
  rm -rf "$dir.tmp" && mkdir -p "$dir.tmp"
  tar -xjf "$DEST/$name.tar.bz2" -C "$dir.tmp" --strip-components=1
  mv "$dir.tmp" "$dir"
  rm "$DEST/$name.tar.bz2"
  echo "done $name ($((SECONDS - start))s)"
}

fetch_file silero_vad.onnx
fetch_file silero_vad_v5.onnx

# 小さい順（先に取れたものからベンチマークできるように）
for m in "$@"; do fetch_archive "$m"; done
