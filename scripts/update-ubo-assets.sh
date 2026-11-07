#!/bin/sh

set -e
echo "update-ubo-assets.sh"
echo

echo "-> Downloading Helium uBlock assets.json from imputnet/uBlock"
python3 - << 'EOF'
import json
import urllib.request
from pathlib import Path

url = "https://raw.githubusercontent.com/imputnet/uBlock/refs/heads/main/assets/assets.json"
with urllib.request.urlopen(url, timeout=30) as resp:
    assets = json.loads(resp.read().decode("utf-8"))

# Point assets.json bootstrap update location to Argon's repository
assets["assets.json"].pop("cdnURLs", None)
assets["assets.json"]["contentURL"] = (
    "https://raw.githubusercontent.com/Argon-Browser/Argon/main/assets/uBOAssets.json"
)

# Use remote URLs directly for Helium filters since AMO's uBO XPI does not bundle local assets/helium/*
if "helium-annoyances" in assets:
    assets["helium-annoyances"]["contentURL"] = (
        "https://raw.githubusercontent.com/imputnet/helium-services/main/filters/helium-annoyances.txt"
    )
if "helium-unbreak" in assets:
    assets["helium-unbreak"]["contentURL"] = (
        "https://raw.githubusercontent.com/imputnet/helium-services/main/filters/helium-unbreak.txt"
    )

out_path = Path("assets/uBOAssets.json")
out_path.write_text(json.dumps(assets, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"-> Wrote {out_path} with {len(assets)} entries")
EOF

rm -f /tmp/helium_assets.json /tmp/upstream_assets.json
echo "Done!"
