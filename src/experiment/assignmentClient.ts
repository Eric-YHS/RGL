import { getManipulationQuestions, type ManipulationQuestion } from './manipulationChecks';

const TOKEN_KEY='honglvdeng_browser_identity_v1';
let memoryToken='';
export function browserIdentity(): string {
  if(memoryToken) return memoryToken;
  const valid=(s: string | null | undefined): s is string=>Boolean(s && /^\w[\w-]{31,127}$/.test(s));
  let cookie='';
  try { cookie=document.cookie.split('; ').find(v=>v.startsWith(`${TOKEN_KEY}=`))?.slice(TOKEN_KEY.length+1)??''; } catch { /* Storage may be restricted. */ }
  let local='';
  try { local=localStorage.getItem(TOKEN_KEY)??''; } catch { /* Try cookie instead. */ }
  memoryToken=valid(cookie)?cookie:valid(local)?local:crypto.randomUUID();
  try { localStorage.setItem(TOKEN_KEY,memoryToken); } catch { /* Cookie is a second copy. */ }
  try { document.cookie=`${TOKEN_KEY}=${memoryToken}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`; } catch { /* Session only if both stores are blocked. */ }
  return memoryToken;
}

export async function resolveServerAssignment(apiUrl: string, participantId: string, treatment: string, questions: ManipulationQuestion[]) {
  const preferredOrders=questions.map(q=>{const canonical=[...q.options].sort();return q.options.map(o=>canonical.indexOf(o));});
  const controller=new AbortController();
  const timeout=window.setTimeout(()=>controller.abort(),12000);
  try {
    const response=await fetch(apiUrl,{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify({participantId,browserToken:browserIdentity(),preferredTreatment:treatment,preferredOrders})
    });
    if(!response.ok) throw new Error(`Assignment HTTP ${response.status}`);
    const data=await response.json();
    if(!data.ok || typeof data.assignmentId!=='string'||!/^[CPN][1-5]$/.test(data.treatment)) throw new Error('Invalid assignment response');
    const resolved=getManipulationQuestions(data.treatment);
    if(!Array.isArray(data.orders)||data.orders.length!==2) throw new Error('Invalid option orders');
    resolved.forEach((q,i)=>{
      const order=data.orders[i];
      if(!Array.isArray(order)||order.length!==q.options.length||new Set(order).size!==order.length||!order.every(v=>Number.isInteger(v)&&v>=0&&v<order.length)) throw new Error('Invalid option order');
      const canonical=[...q.options].sort();
      q.options=order.map(v=>canonical[v]);
    });
    // 更新本地副本，使旧入口仍能沿用服务器认定的首次分配。
    try {
      const identity=participantId?`pid:${encodeURIComponent(participantId)}`:'anonymous';
      localStorage.setItem(participantId?`honglvdeng_treatment_v1:pid:${encodeURIComponent(participantId)}`:'honglvdeng_treatment_v1',data.treatment);
      localStorage.setItem(`honglvdeng_manipulation_order_v1:${identity}:${data.treatment}`,JSON.stringify(resolved.map(q=>q.options)));
    } catch { /* Server record remains authoritative. */ }
    return {assignmentId:data.assignmentId as string,treatment:data.treatment as string,questions:resolved};
  } finally {window.clearTimeout(timeout);}
}