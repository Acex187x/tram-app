import type { TramModelId } from '@/lib/types';
export interface SkinRecord { id:string;title:string;modelId:TramModelId;directory:string;mapKeys:string[];viewerKeys:string[];sourceUrl?:string;notes?:string;bytes:number;mapTextureBytes:number;viewerTextureBytes:number;importedAtMs:number; }
export interface SkinAssignment { skinId:string;modelId:TramModelId; }
export const skinModelKey=(version:string,base:string)=>`skin-${version}-${base}`;
export function assignedSkin(reg:string,model:TramModelId,skins:SkinRecord[],assignments:Record<string,SkinAssignment>):SkinRecord|undefined {
  const assignment=assignments[reg];
  return assignment?.modelId===model?skins.find(s=>s.id===assignment.skinId&&s.modelId===model):undefined;
}
export function registrationNumber(input:string):string {
  const value=input.trim();
  if(!/^[0-9]{1,6}$/.test(value))throw new Error('Enter a vehicle registration number, not a line number or route');
  if(Number(value)===0)throw new Error('Vehicle registration cannot be zero');
  return String(Number(value));
}
