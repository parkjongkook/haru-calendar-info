export const scope='https://www.googleapis.com/auth/drive.appdata';
export const prefix='haru-memo-v1-';
const files='https://www.googleapis.com/drive/v3/files';
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(id);
export function validate(r,id){
  if(!r||r.Schema!==1||r.Id!==id||!safeId(id)||!/^\w{32}$/.test(r.NoteId)||!/^[a-f0-9]{32}$/.test(r.NoteId)
    ||!Array.isArray(r.Parents)||r.Parents.length>128||r.Parents.some(p=>!safeId(p)||p===id)||new Set(r.Parents).size!==r.Parents.length
    ||typeof r.Text!=='string'||r.Text.length>200000||typeof r.Subject!=='string'||r.Subject.length>1000||typeof r.Deleted!=='boolean'
    ||r.TextColor!==null&&!/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/.test(r.TextColor)||typeof r.UpdatedUtc!=='string'||!Number.isFinite(Date.parse(r.UpdatedUtc)))throw Error('메모 응답을 확인할 수 없어 기존 내용을 보존했습니다.');
}
export function project(revisions){
  const remaining=new Map(),children=new Map(),superseded=new Set();
  for(const [id,r] of Object.entries(revisions)){
    validate(r,id);remaining.set(id,r.Parents.length);
    for(const p of r.Parents){if(!revisions[p]||revisions[p].NoteId!==r.NoteId)throw Error('이전 메모 내용을 불러오는 중입니다. 잠시 후 다시 시도하세요.');superseded.add(p);if(!children.has(p))children.set(p,[]);children.get(p).push(id);}
  }
  const queue=[...remaining].filter(([,n])=>!n).map(([id])=>id);
  for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[]){remaining.set(child,remaining.get(child)-1);if(!remaining.get(child))queue.push(child);}
  if(queue.length!==remaining.size)throw Error('메모 기록 오류로 기존 내용을 보존했습니다.');
  const groups=new Map();
  for(const r of Object.values(revisions))if(!superseded.has(r.Id)){if(!groups.has(r.NoteId))groups.set(r.NoteId,[]);groups.get(r.NoteId).push(r);}
  return [...groups].map(([Id,heads])=>{
    heads.sort((a,b)=>a.Id<b.Id?-1:a.Id>b.Id?1:0);const live=heads.filter(r=>!r.Deleted),chosen=live[0]||heads[0];
    return {Id,Subject:chosen.Subject,TextColor:chosen.TextColor,Deleted:!live.length,DriveHeads:heads.map(r=>r.Id),UpdatedUtc:heads.map(r=>r.UpdatedUtc).sort().at(-1),
      Text:heads.length===1?chosen.Text:heads.map((r,i)=>r.Deleted?`[동시 변경 ${i+1}: 다른 기기에서 삭제됨]`:`[동시 변경 ${i+1} · ${r.UpdatedUtc}]\n${r.Text}`).join('\n\n')};
  });
}
export function newState(){return {revisions:{},pending:[],drafts:{}};}
export async function sync(state,request,persist){
  // Immutable files keep concurrent edits recoverable; compact history only after a separately verified migration.
  for(const [noteId,draft] of Object.entries(state.drafts)){
    const result=await request(`${files}/generateIds?count=1&space=appDataFolder&type=files`);
    const r={Schema:1,Id:result.ids?.[0],NoteId:noteId,Parents:[...draft.DriveHeads],Subject:draft.Subject,Text:draft.Text,TextColor:draft.TextColor,Deleted:draft.Deleted,UpdatedUtc:new Date().toISOString()};validate(r,r.Id);
    if(state.revisions[r.Id])throw Error('메모 저장 번호가 중복됐습니다.');
    state.revisions[r.Id]=r;state.pending.push(r.Id);delete state.drafts[noteId];await persist(state);
  }
  const revisions={...state.revisions},pages=new Set();let page,total=0;
  do{
    const url=new URL(files);url.searchParams.set('spaces','appDataFolder');url.searchParams.set('pageSize','1000');url.searchParams.set('fields','nextPageToken,files(id,name)');url.searchParams.set('q',`trashed = false and name contains '${prefix}'`);if(page)url.searchParams.set('pageToken',page);
    const listing=await request(url.href);if(!Array.isArray(listing.files))throw Error('메모 목록 응답을 확인할 수 없습니다.');
    for(const file of listing.files){if(!safeId(file.id)||file.name!==prefix+file.id+'.json'||++total>20000)throw Error('메모 목록을 확인할 수 없어 기존 내용을 보존했습니다.');
      if(!revisions[file.id]){const r=await request(`${files}/${file.id}?alt=media`);validate(r,file.id);revisions[file.id]=r;}}
    page=listing.nextPageToken;if(page){if(typeof page!=='string'||pages.has(page))throw Error('메모 목록 응답이 반복됩니다.');pages.add(page);}
  }while(page);
  project(revisions);state.revisions=revisions;await persist(state);
  for(const id of [...state.pending]){
    const r=state.revisions[id];validate(r,id);const boundary='haru_'+crypto.randomUUID().replaceAll('-','');
    const metadata={id,name:prefix+id+'.json',mimeType:'application/json',parents:['appDataFolder']};
    const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(r)}\r\n--${boundary}--\r\n`;
    try{const reply=await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});if(reply.id!==id)throw Error('메모 저장 확인이 필요합니다.');}
    catch(e){if(e.status!==409)throw e;const existing=await request(`${files}/${id}?alt=media`);validate(existing,id);if(Object.keys(existing).length!==Object.keys(r).length||Object.keys(r).some(key=>JSON.stringify(existing[key])!==JSON.stringify(r[key])))throw Error('메모 저장 번호 충돌로 원본을 보존했습니다.');}
    state.pending=state.pending.filter(p=>p!==id);await persist(state);
  }
  return project(state.revisions);
}
