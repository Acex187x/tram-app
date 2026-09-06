"""Stage/remove one explicitly synthetic ride for native metadata UI testing.
Caller must hold the exact Simulator lease. Existing user rides are untouched.
"""
from pathlib import Path
import subprocess
import sys

action, udid = sys.argv[1:3]
if action not in ('stage', 'remove'):
    raise SystemExit('Use stage or remove with the exact leased UDID')
source = Path(__file__).resolve().parents[2] / 'docs/testing/fixtures/ride-timing-ui-only.jsonl'
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', udid,
    'cz.zabolotny.tramspotter', 'data'], text=True).strip())
target = container / 'Documents/tramspotter-motion/rides/ui-only-timing-fixture.jsonl'
expected = source.read_bytes()
if target.exists() and target.read_bytes() != expected:
    raise SystemExit('Refusing to overwrite/remove a changed fixture file')
if action == 'stage':
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(expected)
elif target.exists():
    target.unlink()
