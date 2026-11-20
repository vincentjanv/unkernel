#!/bin/bash
cd "$(dirname "$0")/web/cloudflare" && npm run deploy:page
echo; read -n 1 -s -r -p "Done. Press any key to close."
