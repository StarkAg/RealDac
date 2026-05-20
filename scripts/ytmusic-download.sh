#!/usr/bin/env bash
# Download MP3s from YouTube Music by song title.
# Source: ytmusicapi (YouTube Music search) + yt-dlp (download)
#
# Usage:
#   bash scripts/ytmusic-download.sh "Brown Rang" "Love Dose" "Blue Eyes"
#   bash scripts/ytmusic-download.sh "Yo Yo Honey Singh Brown Rang"
#   bash scripts/ytmusic-download.sh Brown Rang Love Dose
#
# Dependencies: yt-dlp, Python 3, ytmusicapi (pip install ytmusicapi)
# Output: MP3s in ./downloads/ (or --dir path)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/public/realdac-songs/downloads}"
VENV="$REPO_ROOT/.venv-ytmusic"

# Parse --dir
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir=*) OUT_DIR="${1#*=}"; shift ;;
    --dir)   OUT_DIR="$2"; shift 2 ;;
    *)       ARGS+=("$1"); shift ;;
  esac
done

if [[ ${#ARGS[@]} -eq 0 ]]; then
  echo "Usage: $0 [--dir=OUTPUT_DIR] \"Song Title 1\" \"Song Title 2\" ..."
  echo ""
  echo "Examples:"
  echo "  $0 \"Brown Rang\" \"Love Dose\""
  echo "  $0 \"Yo Yo Honey Singh Blue Eyes\""
  echo "  $0 --dir=./my-music \"Song 1\" \"Song 2\""
  exit 1
fi

if ! command -v yt-dlp &>/dev/null; then
  echo "yt-dlp not found. Install: brew install yt-dlp"
  exit 1
fi

# Ensure ytmusicapi venv
if [[ ! -f "$VENV/bin/python" ]]; then
  echo "Creating venv and installing ytmusicapi..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q ytmusicapi
fi

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

for query in "${ARGS[@]}"; do
  safe=$(echo "$query" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  [[ -z "$safe" ]] && safe="track"
  outfile="${safe}.mp3"

  if [[ -f "$outfile" ]]; then
    echo "[SKIP] $outfile (exists)"
    continue
  fi

  vid=$(QUERY="$query" "$VENV/bin/python" -c "
import os
from ytmusicapi import YTMusic
yt = YTMusic()
q = os.environ.get('QUERY', '')
for r in yt.search(q, filter='songs', limit=5):
    vid = r.get('videoId')
    if vid:
        print(vid)
        break
else:
    for r in yt.search(q, filter='videos', limit=5):
        vid = r.get('videoId')
        if vid:
            print(vid)
            break
" 2>/dev/null || true)

  if [[ -z "$vid" ]]; then
    echo "[FAIL] $query (no result)"
    continue
  fi

  echo "[DL] $query -> $outfile"
  yt-dlp -x --audio-format mp3 --audio-quality 0 \
    -o "${safe}.%(ext)s" \
    --no-overwrites \
    "https://www.youtube.com/watch?v=$vid" || echo "[FAIL] $query"
  sleep 1
done

echo ""
echo "Done. Files in: $OUT_DIR"
