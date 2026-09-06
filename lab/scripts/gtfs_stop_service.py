#!/usr/bin/env python3
"""Bounded public PID GTFS stop-service metadata refresh; no credentials/DB.
Writes an atomic derived file. Intended as a nonblocking optional Lab child.
"""
import csv, datetime, email.utils, io, json, os, pathlib, tempfile, urllib.request, zipfile
SOURCE='https://data.pid.cz/PID_GTFS.zip'
MAX_ZIP=100*1024*1024

def export(output):
    output=pathlib.Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gtfs-service-',dir=output.parent) as temporary:
        archive=pathlib.Path(temporary)/'feed.zip'
        with urllib.request.urlopen(SOURCE,timeout=30) as response,archive.open('wb') as sink:
            modified=response.headers.get('Last-Modified');size=0
            while chunk:=response.read(1024*1024):
                size+=len(chunk)
                if size>MAX_ZIP:raise ValueError('GTFS ZIP exceeds100MiB budget')
                sink.write(chunk)
        with zipfile.ZipFile(archive) as z:
            def rows(name):
                if z.getinfo(name).file_size>2*1024*1024*1024:raise ValueError('GTFS member exceeds2GiB budget')
                return csv.DictReader(io.TextIOWrapper(z.open(name),encoding='utf-8-sig'))
            routes={r['route_id'] for r in rows('routes.txt') if r['route_type']=='0'}
            trips={r['trip_id'] for r in rows('trips.txt') if r['route_id'] in routes}
            selected={};count=0
            for i,r in enumerate(rows('stop_times.txt')):
                if i>8000000:raise ValueError('GTFS row budget exceeded')
                if r['trip_id'] not in trips:continue
                seq=int(r['stop_sequence']);pickup=r.get('pickup_type');drop=r.get('drop_off_type')
                known=pickup in ('0','1','2','3') and drop in ('0','1','2','3')
                if not known:continue
                # Preserve duplicates; the consumer rejects an ambiguous join.
                selected.setdefault(r['trip_id'],[]).append([r['stop_id'],seq,pickup=='3' and drop=='3']);count+=1
        now=datetime.datetime.now(datetime.timezone.utc).timestamp()*1000
        source_at=email.utils.parsedate_to_datetime(modified).timestamp()*1000 if modified else now
        result={'version':1,'source':SOURCE,'sourceAtMs':source_at,'fetchedAtMs':now,'trips':selected,'rows':count}
        pending=pathlib.Path(temporary)/'metadata.json';pending.write_text(json.dumps(result,separators=(',',':')))
        os.replace(pending,output)
        print(json.dumps({'ok':True,'sourceAtMs':source_at,'trips':len(selected),'rows':count}))
if __name__=='__main__':
    import sys
    export(sys.argv[1])
