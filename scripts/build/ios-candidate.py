"""Build the isolated private tracking candidate under a caller-owned build lease.

The generated native Info.plist is restored even on build failure. Production
config never gains an arbitrary-load exception; only this candidate permits its
single IPsec endpoint. See docs/testing/tracking-candidate.md for the runbook.
"""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--destination', required=True)
parser.add_argument('--derived-data', required=True)
parser.add_argument('--build-number', default='31')
parser.add_argument('--development-team', help='Apple development team for a signed device build')
args = parser.parse_args()
plist = ROOT / 'ios/TramSpotter/Info.plist'
original = plist.read_bytes()
config = plistlib.loads(original)
ats = config.setdefault('NSAppTransportSecurity', {})
ats.setdefault('NSExceptionDomains', {})['10.10.10.1'] = {
    'NSExceptionAllowsInsecureHTTPLoads': True,
}
config['NSLocalNetworkUsageDescription'] = 'Tram Spotter connects to the private test tracking server on your home network.'
config['CFBundleVersion'] = args.build_number
env = dict(os.environ)
env['EXPO_PUBLIC_TRAJECTORY_CONVEX_URL'] = 'http://10.10.10.1:13210'
env['EXPO_PUBLIC_LAB_DEBUG_URL'] = 'http://10.10.10.1:18090/api/vehicle'
command = ['xcodebuild', '-workspace', 'ios/TramSpotter.xcworkspace',
           '-scheme', 'TramSpotter', '-configuration', 'Release',
           '-destination', args.destination, '-derivedDataPath', args.derived_data,
           '-jobs', '4']
if 'Simulator' in args.destination:
    command.append('CODE_SIGNING_ALLOWED=NO')
elif args.development_team:
    command.append(f'DEVELOPMENT_TEAM={args.development_team}')
command.append('build')
try:
    plist.write_bytes(plistlib.dumps(config))
    result = subprocess.run(command, cwd=ROOT, env=env)
finally:
    plist.write_bytes(original)
raise SystemExit(result.returncode)
