#!/usr/bin/env bash
# Download Honey Singh songs from youtube-ids.txt into realdac-songs/honey-singh
# Requires: yt-dlp (pip install yt-dlp), ffmpeg
#
# Usage: bash scripts/download-honey-singh.sh
# Or:    bash scripts/download-honey-singh.sh path/to/youtube-ids.txt

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IDS_FILE="${1:-$REPO_ROOT/public/realdac-songs/honey-singh/youtube-ids.txt}"
OUT_DIR="$REPO_ROOT/public/realdac-songs/honey-singh"

if ! command -v yt-dlp &>/dev/null; then
  echo "yt-dlp not found. Install: pip install yt-dlp"
  exit 1
fi

if ! command -v ffmpeg &>/dev/null; then
  echo "ffmpeg not found. Install: brew install ffmpeg"
  exit 1
fi

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

while IFS= read -r line; do
  [[ "$line" =~ ^# ]] && continue
  [[ -z "$line" ]] && continue

  # Parse: "Song Name | VIDEO_ID | URL"
  name=$(echo "$line" | cut -d'|' -f1 | xargs)
  vid=$(echo "$line" | cut -d'|' -f2 | xargs)
  url=$(echo "$line" | cut -d'|' -f3 | xargs)

  [[ -z "$vid" ]] && continue

  # Safe filename: replace spaces/special chars with -
  safe=$(echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  [[ -z "$safe" ]] && safe="$vid"

  outfile="${safe}.mp3"
  if [[ -f "$outfile" ]]; then
    echo "[SKIP] $outfile (exists)"
    continue
  fi

  echo "[DL] $name -> $outfile"
  yt-dlp -x --audio-format mp3 --audio-quality 0 \
    -o "${safe}.%(ext)s" \
    --no-overwrites \
    "https://www.youtube.com/watch?v=$vid" || echo "[FAIL] $name"
  sleep 2
done < "$IDS_FILE"

echo "Done. Check: $OUT_DIR"
