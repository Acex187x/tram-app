#!/usr/bin/env python3
"""Copy explicit UI-test screenshots to stable names, preserving xcresult exports.

Usage: name-screenshots.py /path/to/exported/attachments
The manifest remains authoritative for timestamps, devices and original names.
"""
import json
import re
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
destination = root / "named"
destination.mkdir(exist_ok=True)
prefixes = ("inspector-", "map-", "t3-", "t3rp-", "t3rplf-", "kt8d5-", "14t-", "15t-", "52t-")
for group in json.loads((root / "manifest.json").read_text()):
    for attachment in group["attachments"]:
        suggested = Path(attachment["suggestedHumanReadableName"]).name
        name = re.sub(r"_0_[A-F0-9-]+(?=\.[^.]+$)", "", suggested)
        if name.endswith(".png") and name.startswith(prefixes):
            source = root / Path(attachment["exportedFileName"]).name
            shutil.copy2(source, destination / name)
