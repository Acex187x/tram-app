const mockFiles=new Map<string,string>();
const mockDirs=new Set<string>();
let mockFailWrite=false;
jest.mock('expo-file-system',()=>{
 const uri=(parts:any[])=>parts.map(p=>typeof p==='string'?p:p.uri).join('/');
 class File {
  uri:string; constructor(...parts:any[]){this.uri=uri(parts);}
  get name(){return this.uri.split('/').pop()!;} get exists(){return mockFiles.has(this.uri);}
  textSync(){if(!this.exists)throw Error('missing');return mockFiles.get(this.uri)!;}
  write(value:string){if(mockFailWrite){mockFiles.set(this.uri,'{partial');throw Error('disk full');}mockFiles.set(this.uri,value);}
  delete(){mockFiles.delete(this.uri);}
 }
 class Directory {
  uri:string;constructor(...parts:any[]){this.uri=uri(parts);}
  get name(){return this.uri.split('/').pop()!;}get exists(){return mockDirs.has(this.uri);}
  create(){mockDirs.add(this.uri);}
  list(){return [...mockDirs].filter(p=>p.startsWith(this.uri+'/')&&!p.slice(this.uri.length+1).includes('/')).map(p=>new Directory(p)).concat([...mockFiles.keys()].filter(p=>p.startsWith(this.uri+'/')&&!p.slice(this.uri.length+1).includes('/')).map(p=>new File(p)) as any);}
  delete(){mockDirs.delete(this.uri);for(const key of mockFiles.keys())if(key.startsWith(this.uri+'/'))mockFiles.delete(key);}
 }
 return {Directory,File,Paths:{document:'doc'}};
});
import {readSkinLibrary,useSkinsStore} from '@/stores/skins';
import type {SkinRecord} from '@/lib/skins/registry';
const skin=(directory:string):SkinRecord=>({id:'test',title:'Test',modelId:'t3',directory,mapKeys:['t3','t3-open'],viewerKeys:['t3'],bytes:20,mapTextureBytes:0,viewerTextureBytes:0,importedAtMs:1});
const index=(n:number,directory:string)=>{mockDirs.add('doc/tram-skins/'+directory);mockFiles.set(`doc/tram-skins/index-${n}.json`,JSON.stringify({version:1,skins:[skin(directory)],assignments:{}}));};
beforeEach(()=>{mockFiles.clear();mockDirs.clear();mockDirs.add('doc/tram-skins');mockFailWrite=false;useSkinsStore.setState({skins:[],assignments:{},revision:0});});
it('recovers preceding complete generation after an interrupted save',()=>{index(100,'test-100');mockFiles.set('doc/tram-skins/index-101.json','{partial');expect(readSkinLibrary().skins[0].directory).toBe('test-100');expect(mockDirs.has('doc/tram-skins/test-100')).toBe(true);});
it('does not delete any asset directory when every index is corrupt',()=>{mockDirs.add('doc/tram-skins/valuable');mockFiles.set('doc/tram-skins/index-1.json','oops');expect(readSkinLibrary().skins).toEqual([]);expect(mockDirs.has('doc/tram-skins/valuable')).toBe(true);});
it('retains three valid recovery generations and collects only unreferenced assets on startup',()=>{for(let i=1;i<=4;i++)index(i,'test-'+i);mockDirs.add('doc/tram-skins/orphan');expect(readSkinLibrary().skins[0].directory).toBe('test-4');expect(mockDirs.has('doc/tram-skins/test-1')).toBe(false);expect(mockDirs.has('doc/tram-skins/orphan')).toBe(false);for(let i=2;i<=4;i++)expect(mockDirs.has('doc/tram-skins/test-'+i)).toBe(true);});
it('failed save does not publish new library state or overwrite the old generation',()=>{index(1,'test-1');useSkinsStore.setState(readSkinLibrary());mockFailWrite=true;expect(()=>useSkinsStore.getState().add(skin('test-2'))).toThrow('disk full');expect(useSkinsStore.getState().skins[0].directory).toBe('test-1');expect(readSkinLibrary().skins[0].directory).toBe('test-1');});
it('replacement and reset save first and defer file deletion until cold startup',()=>{index(1,'test-1');useSkinsStore.setState(readSkinLibrary());mockDirs.add('doc/tram-skins/test-2');useSkinsStore.getState().add(skin('test-2'));useSkinsStore.getState().assign('007001','test');expect(useSkinsStore.getState().assignments['7001'].skinId).toBe('test');useSkinsStore.getState().reset('7001');expect(useSkinsStore.getState().assignments).toEqual({});expect(mockDirs.has('doc/tram-skins/test-1')).toBe(true);});
