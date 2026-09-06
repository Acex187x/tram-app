import {useState} from 'react';
import {Alert,Button,Text,TextInput,View,useColorScheme,ActivityIndicator,Keyboard} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import {File,Paths} from 'expo-file-system';
import {isPickerCacheCopy} from '@/lib/skins/pickerCache';
import {router,type Href} from 'expo-router';
import {SheetSurface} from '@/components/ui/SheetSurface';
import {SheetHeader} from '@/components/ui/SheetHeader';
import {InsetGroup,InsetRow,SectionLabel,RowSeparator} from '@/components/ui/Inset';
import {appleScheme} from '@/constants/theme';
import {MODEL_SPECS} from '@/lib/fleet/modelSpecs';
import {useSkinsStore} from '@/stores/skins';
import {importSkin} from '@/lib/skins/importSkin';
import {registrationNumber,type SkinRecord} from '@/lib/skins/registry';
import {getRuntime} from '@/hooks/tramData';

export default function SkinsScreen(){
  const registry=useSkinsStore();const [busy,setBusy]=useState(false);const [selected,setSelected]=useState<string|null>(null);const [registration,setRegistration]=useState('');
  const colors=appleScheme(useColorScheme()==='dark'?'dark':'light');
  const skin=registry.skins.find(s=>s.id===selected);
  const message=(e:unknown)=>Alert.alert('Skin could not be applied',e instanceof Error?e.message:String(e));
  const load=async()=>{let copiedUri:string|undefined;try{const result=await DocumentPicker.getDocumentAsync({type:'application/json',copyToCacheDirectory:true,multiple:false});if(result.canceled)return;
    copiedUri=result.assets[0].uri;setBusy(true);const added=await importSkin(copiedUri);setSelected(added.id);
  }catch(e){message(e);}finally{
    if(copiedUri&&isPickerCacheCopy(copiedUri,Paths.cache.uri)){try{const file=new File(copiedUri);if(file.exists)file.delete();}catch{/* The system may reclaim a busy cache copy later. */}}
    setBusy(false);}};
  const preview=(s:SkinRecord)=>router.push(`/model/${s.modelId}?skin=${encodeURIComponent(s.id)}` as Href);
  const assign=()=>{try{if(!skin)return;const reg=registrationNumber(registration);const live=getRuntime().fleet.getState(reg,Date.now());
    if(live&&live.model.id!==skin.modelId)throw new Error(`Vehicle ${reg} is ${MODEL_SPECS[live.model.id].name}; this skin fits ${MODEL_SPECS[skin.modelId].name}`);
    registry.assign(reg,skin.id);setRegistration('');Keyboard.dismiss();Alert.alert('Assignment saved',`Vehicle ${reg} will use ${skin.title} when its model matches. This is your local assignment.`);
  }catch(e){message(e);}};
  return <SheetSurface header={<SheetHeader title="Tram skins" subtitle="Authored liveries · local assignments"/>}>
    <InsetGroup><InsetRow icon="square.and.arrow.down" title={busy?'Importing skin…':'Import skin package'} subtitle="Choose an authored JSON package from Files" subtitleLines={2} onPress={busy?undefined:()=>void load()} trailing={busy?<ActivityIndicator/>:undefined}/></InsetGroup>
    <Text style={{color:colors.secondary,margin:16}}>Import a livery, preview it, and assign it by vehicle number. Assignments stay on this device.</Text>
    <SectionLabel>Library</SectionLabel>
    {registry.skins.length===0?<InsetGroup><InsetRow title="No imported skins" subtitle="Create a model-specific package with the companion authoring tool, then import it here." subtitleLines={3}/></InsetGroup>:registry.skins.map(s=><InsetGroup key={s.id}>
      <InsetRow title={s.title} subtitle={MODEL_SPECS[s.modelId].name} checked={s.id===selected} onPress={()=>setSelected(s.id)} label={`Select skin ${s.title}`}/>
      <RowSeparator/><InsetRow title="Preview all sides" icon="cube" onPress={()=>preview(s)} label={`Preview skin ${s.title}`}/>
    </InsetGroup>)}
    {skin&&<><SectionLabel>{`Assign ${skin.title}`}</SectionLabel><InsetGroup><View style={{padding:16,gap:12}}>
      <Text style={{color:colors.text}}>Vehicle registration</Text><TextInput accessibilityLabel="Vehicle registration for skin" value={registration} onChangeText={setRegistration} keyboardType="number-pad" maxLength={6} placeholder={skin.modelId==='kt8d5'?'e.g. 9102':skin.modelId==='15t'?'e.g. 9286':skin.modelId==='14t'?'e.g. 9128':skin.modelId==='52t'?'e.g. 9501':'Vehicle number'} placeholderTextColor={colors.secondary} style={{color:colors.text,fontSize:20,minHeight:44}}/>
      <Button title="Assign to vehicle" onPress={assign} disabled={!registration.trim()}/>
      <Text style={{color:colors.secondary}}>Applies only to {MODEL_SPECS[skin.modelId].name}.</Text>
    </View></InsetGroup>
    {skin.sourceUrl&&<Text selectable style={{margin:16,color:colors.secondary}}>Reference: {skin.sourceUrl}</Text>}
    {skin.notes&&<Text selectable style={{margin:16,color:colors.secondary}}>{skin.notes}</Text>}
    <InsetGroup><InsetRow destructive title="Remove this skin" onPress={()=>Alert.alert('Remove skin?', 'Its local vehicle assignments will return to standard paint.',[{text:'Cancel',style:'cancel'},{text:'Remove',style:'destructive',onPress:()=>{try{registry.remove(skin.id);setSelected(null);}catch(e){message(e);}}}])}/></InsetGroup></>}
    <SectionLabel>Vehicle assignments</SectionLabel>
    {Object.keys(registry.assignments).length===0?<Text style={{color:colors.secondary,margin:16}}>No vehicles assigned.</Text>:<InsetGroup>{Object.entries(registry.assignments).map(([reg,a])=><View key={reg}><InsetRow title={`Vehicle ${reg}`} subtitle={registry.skins.find(s=>s.id===a.skinId)?.title??'Unavailable skin'} trailing={<Button title="Reset" accessibilityLabel={`Reset skin for vehicle ${reg}`} onPress={()=>{try{registry.reset(reg);}catch(e){message(e);}}}/>}/><RowSeparator/></View>)}</InsetGroup>}
  </SheetSurface>;
}
