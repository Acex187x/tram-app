"""Bounded read-only collection; caller owns the exact Simulator lease.

Never unlink a live writer's file or relaunch during background tests.
Only complete JSONL lines are copied; truncation/rotation resets the cursor.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', required=True)
    parser.add_argument('--duration', type=float, default=3600)
    parser.add_argument('--interval', type=float, default=30)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    cursors = {}
    deadline = time.monotonic() + max(0, args.duration)
    while True:
        try:
            result = subprocess.run(['xcrun', 'simctl', 'get_app_container', args.device,
                                     'cz.zabolotny.tramspotter', 'data'],
                                    capture_output=True, text=True, timeout=15)
        except subprocess.TimeoutExpired:
            result = subprocess.CompletedProcess([], 124, stdout='')
        copied = 0
        if result.returncode == 0:
            source = Path(result.stdout.strip()) / 'Documents/tramspotter-motion/motionlogs'
            for path in sorted(source.glob('*.jsonl')):
                try:
                    with path.open('rb') as stream:
                        stat = os.fstat(stream.fileno())
                        inode, offset = cursors.get(str(path), (stat.st_ino, 0))
                        if inode != stat.st_ino or stat.st_size < offset:
                            offset = 0
                        stream.seek(offset)
                        data = stream.read()
                    end = data.rfind(b'\n') + 1
                    if end:
                        with (args.out / path.name).open('ab') as dest:
                            dest.write(data[:end])
                        copied += data[:end].count(b'\n')
                        offset += end
                    cursors[str(path)] = (stat.st_ino, offset)
                except FileNotFoundError:
                    continue
        with (args.out / 'harvest-status.jsonl').open('a') as log:
            log.write(json.dumps({'atMs': round(time.time() * 1000), 'device': args.device,
                                  'lines': copied, 'containerAvailable': result.returncode == 0}) + '\n')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(max(1, args.interval), remaining))


if __name__ == '__main__':
    main()
