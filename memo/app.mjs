import {clientId} from './config.mjs';
import {scope,newState,project,sync} from './sync.mjs';
const $=id=>document.getElementById(id),status=text=>$('status').textContent=text;
let token='',expires=0,user=null,state=newState(),selected=null,busy=false,editing=false;
const scopes=['openid','email','https://www.googleapis.com/auth/calendar.app.created',scope];
const key=()=>`haru-memo-v1:${user.sub}`;
function ask(text){return new Promise(resolve=>{const dialog=$('confirm');if(dialog.open){resolve(false);return;}$('confirmText').textContent=text;dialog.returnValue='cancel';dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'),{once:true});dialog.showModal();});}
function persist(value){localStorage.setItem(key(),JSON.stringify(value));}
function read(){const value=JSON.parse(localStorage.getItem(key())||'null')||newState();if(!value.revisions||!Array.isArray(value.pending)||!value.drafts)throw Error('이 기기의 메모 저장 정보를 확인할 수 없습니다.');project(value.revisions);return value;}
function setBusy(value){busy=value;for(const id of ['save','remove','new','refresh','login','logout'])$(id).disabled=value;}
function message(error){status(error?.status===401?'로그인 유효 시간이 지났습니다. Google로 다시 로그인하세요. 입력 내용은 이 기기에 보존돼 있습니다.':error?.status===403?'메모 저장 권한을 확인할 수 없습니다. Google로 다시 로그인하여 메모 권한을 승인하세요.':error?.status===429?'잠시 요청이 많습니다. 입력 내용을 보존했으며 다음 확인 때 다시 시도합니다.':error?.message||'연결하지 못했습니다. 이 기기에 저장한 내용은 보존됩니다.');}
async function request(url,options={}){
  if(!token||Date.now()>=expires){const e=Error();e.status=401;throw e;}
  const response=await fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(40000),cache:'no-store'});
  if(!response.ok){const e=Error(`연결 요청 실패 (${response.status}). 저장 내용은 보존됩니다.`);e.status=response.status;if(response.status===401){token='';expires=0;}throw e;}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();throw Error('메모 응답이 너무 큽니다. 기존 내용을 보존했습니다.');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
function notes(){const all=new Map(project(state.revisions).map(n=>[n.Id,n]));for(const [id,n] of Object.entries(state.drafts))all.set(id,n);return [...all.values()];}
function render(){
  const query=$('search').value.toLocaleLowerCase(),deleted=$('trash').checked;
  const visible=notes().filter(n=>n.Deleted===deleted&&n.Text.toLocaleLowerCase().includes(query)).sort((a,b)=>(b.UpdatedUtc||'').localeCompare(a.UpdatedUtc||'')||a.Id.localeCompare(b.Id));
  $('list').replaceChildren();$('empty').hidden=!!visible.length;$('empty').textContent=deleted?'삭제한 메모가 없습니다.':query?'일치하는 메모가 없습니다.':'첫 메모를 작성해 보세요.';
  for(const note of visible){const b=document.createElement('button');b.type='button';b.className='note';b.setAttribute('aria-pressed',String(note.Id===selected?.Id));b.textContent=(note.Text.split('\n').find(l=>l.trim())||note.Subject||'메모').slice(0,100);const small=document.createElement('small');small.textContent=note.DriveHeads.length>1?'동시 수정 내용 보존됨':state.drafts[note.Id]||note.DriveHeads.some(id=>state.pending.includes(id))?'전송 대기':note.Deleted?'삭제됨 · 열어서 복원 가능':'동기화됨';b.append(small);b.addEventListener('click',()=>open(note));$('list').append(b);}
}
function remember(){if(!user||!selected)return;sessionStorage.setItem(key()+':editor',JSON.stringify({...selected,Text:$('text').value}));}
function open(note){
  if(editing&&selected?.Id!==note.Id){ask('아직 저장하지 않은 내용이 있습니다. 다른 메모로 이동할까요?').then(ok=>{if(ok){editing=false;open(note);}});return;}
  selected=structuredClone(note);editing=false;$('editor').hidden=false;$('selectHint').hidden=true;$('text').value=note.Text;$('conflict').hidden=note.DriveHeads.length<=1;$('save').textContent=note.Deleted?'복원':'저장';$('remove').hidden=note.Deleted;$('draftHint').textContent='';remember();render();
}
async function locked(work){
  if(busy||!user)return;setBusy(true);
  try{if(!navigator.locks)throw Error('이 브라우저는 안전한 메모 저장을 지원하지 않습니다. 최신 Chrome 또는 Safari에서 열어 주세요.');await navigator.locks.request(key(),async()=>{state=read();await work();});}
  catch(e){message(e);}finally{setBusy(false);if(selected&&!editing){const latest=notes().find(n=>n.Id===selected.Id);if(latest)open(latest);}render();}
}
async function refresh(){
  if(!token||busy||!user||$('confirm').open)return;
  await locked(async()=>{status('변경 내용을 확인하고 있습니다…');await sync(state,request,persist);status('동기화 완료 · '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    if(selected&&!editing){const latest=notes().find(n=>n.Id===selected.Id);if(latest)open(latest);}});
}
async function save(deleted=false){
  if(!selected)return;if(deleted&&!await ask('이 메모를 삭제할까요? 연결된 PC에도 반영됩니다. 삭제한 메모 목록에서 복원할 수 있습니다.'))return;
  const text=$('text').value;if(!deleted&&!text.trim()){status('메모 내용을 입력해 주세요.');return;}
  const draft={...selected,Text:text,Deleted:deleted,Subject:selected.Subject||text.split('\n')[0].slice(0,1000),UpdatedUtc:new Date().toISOString()};
  await locked(async()=>{state.drafts[draft.Id]=draft;persist(state);editing=false;selected=draft;remember();$('draftHint').textContent='이 기기에 저장됨';status('저장했습니다. 구글로 전송하고 있습니다…');
    if(token&&Date.now()<expires){await sync(state,request,persist);selected=notes().find(n=>n.Id===draft.Id)||draft;remember();status('저장 및 동기화 완료');$('draftHint').textContent='구글 저장 완료';}
    else status('이 기기에 저장했습니다. 다시 로그인하면 구글로 전송됩니다.');
    if(deleted){selected=null;$('editor').hidden=true;$('selectHint').hidden=false;sessionStorage.removeItem(key()+':editor');}else open(selected);
  });
}
$('login').addEventListener('click',()=>{
  if(!clientId){status('구글 연결 준비 중입니다. 기존 PC 메모는 그대로 보관돼 있습니다.');return;}
  if(!window.google?.accounts?.oauth2){status('구글 로그인 화면을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.');return;}
  const auth=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:scopes.join(' '),include_granted_scopes:false,error_callback:()=>status('로그인 창이 닫혔거나 열리지 않았습니다. 다시 시도하세요.'),callback:async response=>{
    if(response.error){status('구글 로그인을 완료하지 못했습니다. 다시 시도하세요.');return;}
    if(!google.accounts.oauth2.hasGrantedAllScopes(response,...scopes)){status('캘린더와 하루 메모 권한을 모두 승인해 주세요.');return;}
    token=response.access_token;expires=Date.now()+Math.max(0,Number(response.expires_in)-60)*1000;setBusy(true);
    try{const identity=await request('https://openidconnect.googleapis.com/v1/userinfo');if(identity.email_verified!==true||typeof identity.sub!=='string'||!identity.sub||typeof identity.email!=='string')throw Error('구글 계정을 확인할 수 없습니다.');
      if(user&&user.sub!==identity.sub)throw Error('PC에서 연결한 것과 같은 계정으로 로그인하세요. 계정을 바꾸려면 먼저 로그아웃하세요.');
      user=identity;state=read();selected=null;editing=false;$('account').textContent=identity.email;$('workspace').hidden=false;$('logout').hidden=false;$('login').textContent='Google 다시 로그인';render();
      const editor=JSON.parse(sessionStorage.getItem(key()+':editor')||'null');if(editor){open(editor);editing=$('text').value!==(notes().find(n=>n.Id===editor.Id)?.Text||'');if(editing)$('draftHint').textContent='작성하던 내용 복원됨 · 저장을 눌러 주세요';}
      status('계정 연결 완료');
    }catch(e){token='';expires=0;message(e);}finally{setBusy(false);}if(token)await refresh();
  }});auth.requestAccessToken({prompt:'',...(user?{hint:user.email}:{})});
});
$('text').addEventListener('input',()=>{editing=true;$('draftHint').textContent='작성 중 · 저장을 눌러 주세요';try{remember();}catch{status('임시 저장 공간이 부족합니다. 내용을 복사해 보관해 주세요.');}});
$('new').addEventListener('click',()=>{open({Id:crypto.randomUUID().replaceAll('-',''),Subject:'',Text:'',TextColor:null,Deleted:false,DriveHeads:[]});$('text').focus();});
$('save').addEventListener('click',()=>save(false));$('remove').addEventListener('click',()=>save(true));$('refresh').addEventListener('click',refresh);$('search').addEventListener('input',render);$('trash').addEventListener('change',render);
$('logout').addEventListener('click',async()=>{
  if(busy)return;if(editing||state.pending.length||Object.keys(state.drafts).length){status('아직 전송하지 않은 내용이 있습니다. 저장·동기화를 완료한 뒤 로그아웃해 주세요.');return;}
  if(!await ask('이 브라우저에 저장한 메모 사본을 지우고 이 화면에서 로그아웃할까요? 구글에 저장된 메모는 유지됩니다.'))return;
  localStorage.removeItem(key());sessionStorage.removeItem(key()+':editor');token='';expires=0;user=null;state=newState();selected=null;editing=false;$('workspace').hidden=true;$('logout').hidden=true;$('account').textContent='';$('text').value='';$('list').replaceChildren();$('login').textContent='Google로 로그인';status('로그아웃했습니다.');
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});window.addEventListener('online',refresh);setInterval(()=>{if(!document.hidden)refresh();},15000);
window.addEventListener('beforeunload',e=>{if(editing){e.preventDefault();e.returnValue='';}});
