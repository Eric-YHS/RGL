import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export function createAssignmentStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assignment_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS participant_assignments (
      id TEXT PRIMARY KEY, identity_hash TEXT NOT NULL UNIQUE,
      treatment TEXT NOT NULL, orders_json TEXT NOT NULL,
      first_ip_hash TEXT NOT NULL, last_ip_hash TEXT NOT NULL,
      last_device_hash TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_assignment_ip ON participant_assignments(last_ip_hash);
    CREATE TABLE IF NOT EXISTS assignment_checks (
      id INTEGER PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES participant_assignments(id),
      ip_hash TEXT NOT NULL, device_hash TEXT NOT NULL, flags_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT OR IGNORE INTO assignment_settings VALUES (?,?)').run('hash_key',randomBytes(32).toString('hex'));
  const secret=db.prepare('SELECT value FROM assignment_settings WHERE key=?').get('hash_key').value;
  const hash=(kind,value)=>createHmac('sha256',secret).update(`${kind}:${value}`).digest('hex');
  const byIdentity=db.prepare('SELECT * FROM participant_assignments WHERE identity_hash=?');
  const sharedIp=db.prepare('SELECT 1 FROM participant_assignments WHERE last_ip_hash=? AND id!=? LIMIT 1');
  const insert=db.prepare(`INSERT INTO participant_assignments
    (id,identity_hash,treatment,orders_json,first_ip_hash,last_ip_hash,last_device_hash) VALUES (?,?,?,?,?,?,?)`);
  const update=db.prepare(`UPDATE participant_assignments SET last_ip_hash=?,last_device_hash=?,visits=visits+1,last_seen=datetime('now') WHERE id=?`);
  const audit=db.prepare('INSERT INTO assignment_checks (assignment_id,ip_hash,device_hash,flags_json) VALUES (?,?,?,?)');
  const resolve=db.transaction((input,signals)=>{
    // pid 是实验编号，不是登录认证；无编号时依赖高熵浏览器令牌，不按IP合并人。
    const identity=hash(input.participantId?'pid':'browser',input.participantId||input.browserToken);
    const ip=signals.ip?.replace(/^::ffff:/,'')??'';
    const ipHash=isIP(ip)?hash('ip',ip):'';
    const deviceHash=hash('device',`${input.browserToken}|${signals.userAgent??''}`);
    let row=byIdentity.get(identity);
    const restored=Boolean(row);
    const flags=[];
    if(row){
      if(ipHash && row.last_ip_hash && row.last_ip_hash!==ipHash) flags.push('ip_changed');
      if(row.last_device_hash!==deviceHash) flags.push('browser_changed');
      if(row.treatment!==input.preferredTreatment) flags.push('local_assignment_conflict');
      update.run(ipHash,deviceHash,row.id);
    }else{
      const id=randomUUID();
      const treatment=input.preferredTreatment;
      const orders=input.preferredOrders??[shuffle(3),shuffle(4)];
      insert.run(id,identity,treatment,JSON.stringify(orders),ipHash,ipHash,deviceHash);
      row=byIdentity.get(identity);
    }
    if(ipHash && sharedIp.get(ipHash,row.id)) flags.push('shared_ip');
    audit.run(row.id,ipHash,deviceHash,JSON.stringify(flags));
    return {assignmentId:row.id,treatment:row.treatment,orders:JSON.parse(row.orders_json),restored};
  });
  return (input,signals)=>resolve.immediate(input,signals);
}

function shuffle(size){
  const values=Array.from({length:size},(_,i)=>i);
  for(let i=size-1;i>0;i--){const j=randomInt(i+1);[values[i],values[j]]=[values[j],values[i]];}
  return values;
}

export function parseAssignment(body){
  if(!body || typeof body!=='object' || Array.isArray(body)) return null;
  const {participantId='',browserToken,preferredTreatment,preferredOrders}=body;
  if(typeof participantId!=='string'||participantId.length>200) return null;
  if(typeof browserToken!=='string'||!/^\w[\w-]{31,127}$/.test(browserToken)) return null;
  if(typeof preferredTreatment!=='string'||!/^[CPN][1-5]$/.test(preferredTreatment)) return null;
  if(preferredOrders!==undefined && (!Array.isArray(preferredOrders)||preferredOrders.length!==2||!preferredOrders.every((a,n)=>
    Array.isArray(a)&&a.length===n+3&&new Set(a).size===a.length&&a.every(v=>Number.isInteger(v)&&v>=0&&v<a.length)))) return null;
  return {participantId:participantId.trim(),browserToken,preferredTreatment,preferredOrders};
}