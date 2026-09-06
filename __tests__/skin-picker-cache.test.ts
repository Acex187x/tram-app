import {isPickerCacheCopy} from '@/lib/skins/pickerCache';
const cache='file:///app/Library/Caches/';
it('recognizes only direct files inside the native picker cache',()=>{expect(isPickerCacheCopy(cache+'DocumentPicker/UUID.json',cache)).toBe(true);expect(isPickerCacheCopy(cache+'DocumentPicker/My%20livery.json',cache)).toBe(true);});
it.each([
 'file:///app/Documents/campaign.json',
 'file:///app/Library/Caches-other/DocumentPicker/a.json',
 'file:///app/Library/Caches/DocumentPicker/',
 'file:///app/Library/Caches/DocumentPicker/../owned.json',
 'file:///app/Library/Caches/DocumentPicker/%2e%2e%2fowned.json',
 'file:///app/Library/Caches/DocumentPicker/folder/a.json',
 'file:///app/Library/Caches/DocumentPicker/a%00.json',
 'file:///app/Library/Caches/DocumentPicker/a%5c..json',
 'file:///app/Library/Caches/DocumentPicker/a.json?x=1',
 'https://host/DocumentPicker/a.json',
 'file://another-host/app/Library/Caches/DocumentPicker/a.json',
 'not a URL',
])('preserves an unverified or original document: %s',uri=>expect(isPickerCacheCopy(uri,cache)).toBe(false));
