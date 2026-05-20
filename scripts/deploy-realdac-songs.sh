#!/usr/bin/env bash
# Deploy RealDac songs/albums to VPS
# Usage: bash scripts/deploy-realdac-songs.sh
#        bash scripts/deploy-realdac-songs.sh honey-singh  (deploy one album)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$REPO_ROOT/public/realdac-songs"
VPS_HOST="${VPS_HOST:-65.20.69.64}"
VPS_PORT="${VPS_PORT:-2222}"
VPS_USER="${VPS_USER:-root}"
VPS_PATH="${VPS_PATH:-/opt/gradex}"

echo "Deploying RealDac songs to VPS..."
# Try Tailscale first, fallback to public IP
if ssh -o ConnectTimeout=5 root@gradex-vps "exit" 2>/dev/null; then
  rsync -avz "$SOURCE/" root@gradex-vps:${VPS_PATH}/realdac-songs/
else
  rsync -avz -e "ssh -p ${VPS_PORT}" "$SOURCE/" "${VPS_USER}@${VPS_HOST}:${VPS_PATH}/realdac-songs/"
fi

echo "Done. Albums deployed to ${VPS_PATH}/realdac-songs/"
echo "RealDac: https://gradex.bond/realdac"
