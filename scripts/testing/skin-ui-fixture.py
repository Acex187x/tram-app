"""Stage/remove the explicitly synthetic UV package for native Files testing.
Removal clears only synthetic campaign assignments in a new immutable index.
The optional --purge-library also removes that labelled QA record after testing.
Other campaigns, vehicle assignments, asset files and documents are retained.
"""
from pathlib import Path
import subprocess,sys,json,time

action,udid,source=sys.argv[1:4]
purge_library='--purge-library' in sys.argv[4:]
if sys.argv[4:] not in ([],['--purge-library']) or (purge_library and action!='remove'):
    raise SystemExit('--purge-library is allowed only with remove')
if action not in ('stage','remove'):
    raise SystemExit('Use stage/remove, exact leased UDID, QA package path')
expected=Path(source).read_bytes()
package=json.loads(expected)
if package.get('id')!='qa-uv-kt8' or 'not a real advertisement' not in package.get('title',''):
    raise SystemExit('Only the clearly synthetic UV QA package may be staged')
container=Path(subprocess.check_output(['xcrun','simctl','get_app_container',udid,'cz.zabolotny.tramspotter','data'],text=True).strip())
target=container/'Documents/qa-uv-kt8.skin.json'
if target.exists() and target.read_bytes()!=expected:
    raise SystemExit('Refusing to overwrite/remove a changed file')
if action=='stage':
    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(expected)
else:
    if target.exists():
        target.unlink()
    # XCTest assertion aborts need not unwind Swift defer. Stop our test app
    # before writing one new immutable generation, removing only this clearly
    # synthetic campaign's assignments. Other campaigns/vehicles are retained.
    subprocess.run(['xcrun','simctl','terminate',udid,'cz.zabolotny.tramspotter'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    library=container/'Documents/tram-skins'
    if library.exists():
        candidates=sorted(library.glob('index-*.json'),key=lambda p:int(p.stem.split('-')[1]),reverse=True)
        for entry in candidates:
            try:
                data=json.loads(entry.read_text())
                if data.get('version')!=1 or not isinstance(data.get('assignments'),dict) or not isinstance(data.get('skins'),list):
                    continue
            except (OSError,ValueError):
                continue
            removed=[reg for reg,a in data['assignments'].items() if a.get('skinId')=='qa-uv-kt8']
            qa_skins=[skin for skin in data['skins'] if skin.get('id')=='qa-uv-kt8']
            if purge_library and any('not a real advertisement' not in skin.get('title','') for skin in qa_skins):
                raise SystemExit('Refusing to remove an unlabelled campaign record')
            if removed or (purge_library and qa_skins):
                data['assignments']={reg:a for reg,a in data['assignments'].items() if reg not in removed}
                if purge_library:
                    data['skins']=[skin for skin in data['skins'] if skin.get('id')!='qa-uv-kt8']
                generation=max(int(time.time()*1000),int(entry.stem.split('-')[1])+1)
                destination=library/f'index-{generation}.json'
                temporary=library/f'index-{generation}.qa-temp'
                temporary.write_text(json.dumps(data))
                if json.loads(temporary.read_text())!=data:
                    raise SystemExit('QA cleanup index verification failed')
                temporary.replace(destination)
                print('Removed simulator-only UV test assignments:',','.join(removed) or 'none')
                if purge_library:print('Removed labelled QA library records:',len(qa_skins))
            break
