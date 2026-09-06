/** Only the Expo57 DocumentPicker copy may be removed, never the source
 * document. Decode before checking segments so encoded traversal is rejected. */
export function isPickerCacheCopy(candidate:string,cacheUri:string):boolean {
  try {
    const file=new URL(candidate),cache=new URL(cacheUri);
    if(file.protocol!=='file:'||cache.protocol!=='file:'||file.hostname!==cache.hostname||file.search||file.hash)return false;
    const path=decodeURIComponent(file.pathname),base=decodeURIComponent(cache.pathname).replace(/\/$/,'');
    if(path.includes('\\')||path.includes('\0')||path.split('/').some(part=>part==='.'||part==='..'))return false;
    const prefix=`${base}/DocumentPicker/`;
    return path.startsWith(prefix)&&path.length>prefix.length&&!path.slice(prefix.length).includes('/');
  } catch {return false;}
}
