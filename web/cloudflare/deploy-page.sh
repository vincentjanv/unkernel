#!/usr/bin/env bash
# Build the page and deploy it together with the disk Worker, on one address.
#   web/cloudflare/deploy-page.sh        (from anywhere in the repo; needs `wrangler login` done once)
# The page syncs its data disk to /disks/home on the same address (VITE_KW_REMOTE below).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web="$here/.."
bucket="${BUCKET:-unkernel-disks}"

cd "$web"
[ -d node_modules ] || npm install
VITE_KW_REMOTE="${VITE_KW_REMOTE:-/disks/home}" VITE_KW_WISP="${VITE_KW_WISP:-/wisp}" NITRO_PRESET=static npx vite build
out="$web/.output/public"

# Static assets: the isolation headers, and leave out what must not be uploaded as assets:
# the images (25 MiB a file; they go to R2) and the pre-compressed copies (Cloudflare compresses itself).
cp "$here/assets/_headers" "$out/_headers"
printf 'distros/\n*.br\n*.gz\n*.zst\n' > "$out/.assetsignore"

cd "$here"
[ -d node_modules ] || npm install
# The image names carry a content hash, so name + size says whether R2 already has one.
# A marker file remembers what this machine uploaded (FORCE=1 uploads everything again).
marker="$here/.uploaded-distros"
touch "$marker"
for f in "$out"/distros/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  key="$bucket/$name:$(wc -c < "$f" | tr -d ' ')"
  if [ -z "${FORCE:-}" ] && grep -qxF "$key" "$marker"; then
    echo "R2: $name already uploaded, skipping"
    continue
  fi
  echo "R2: $name ($(du -h "$f" | cut -f1))"
  npx wrangler r2 object put "$bucket/_distros/$name" --file "$f" --content-type application/octet-stream --remote
  echo "$key" >> "$marker"
done
npx wrangler deploy
