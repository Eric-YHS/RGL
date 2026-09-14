import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createAssignmentStore, parseAssignment } from '../assignments.js';
const browserA='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const browserB='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const request=(overrides={})=>({participantId:'',browserToken:browserA,preferredTreatment:'P2',preferredOrders:[[2,0,1],[3,2,0,1]],...overrides});
const signal=(ip='1.2.3.4',userAgent='test-browser')=>({ip,userAgent});
function setup(t){const db=new Database(':memory:');t.after(()=>db.close());return {db,resolve:createAssignmentStore(db)};}
test('编号跨浏览器/IP恢复，材料与排列不被新参数覆盖',t=>{
 const {db,resolve}=setup(t);
 const first=resolve(request({participantId:'alice'}),signal());
 const second=resolve(request({participantId:'alice',browserToken:browserB,preferredTreatment:'N5',preferredOrders:[[0,1,2],[0,1,2,3]]}),signal('5.6.7.8'));
 assert.equal(second.assignmentId,first.assignmentId);assert.equal(second.treatment,'P2');assert.deepEqual(second.orders,first.orders);
 assert.equal(second.restored,true);
 const flags=JSON.parse(db.prepare('SELECT flags_json FROM assignment_checks ORDER BY id DESC LIMIT 1').get().flags_json);
 assert.deepEqual(flags,['ip_changed','browser_changed','local_assignment_conflict']);
});
test('同IP不同被试不合并；共用浏览器的不同pid不合并',t=>{
 const {db,resolve}=setup(t);
 const a=resolve(request({participantId:'a'}),signal());
 const b=resolve(request({participantId:'b'}),signal());
 assert.notEqual(a.assignmentId,b.assignmentId);
 assert.ok(JSON.parse(db.prepare('SELECT flags_json FROM assignment_checks ORDER BY id DESC LIMIT 1').get().flags_json).includes('shared_ip'));
});
test('匿名token恢复且不同token即使IP/UA相同也不合并',t=>{
 const {resolve}=setup(t);
 const a=resolve(request(),signal());
 assert.equal(resolve(request(),signal('2.2.2.2')).assignmentId,a.assignmentId);
 assert.notEqual(resolve(request({browserToken:browserB}),signal()).assignmentId,a.assignmentId);
});
test('重新创建store保留数据库分配和哈希密钥',t=>{
 const {db,resolve}=setup(t);
 const first=resolve(request(),signal());
 const again=createAssignmentStore(db)(request(),signal());
 assert.equal(again.assignmentId,first.assignmentId);
 assert.equal(db.prepare('SELECT count(*) AS n FROM participant_assignments').get().n,1);
 assert.equal(db.prepare('SELECT visits FROM participant_assignments').get().visits,2);
});
test('IP为带密钥散列、不保存明文；IPv4映射地址归一化',t=>{
 const {db,resolve}=setup(t);
 resolve(request(),signal());resolve(request(),signal('::ffff:1.2.3.4'));
 const row=db.prepare('SELECT * FROM participant_assignments').get();
 assert.match(row.last_ip_hash,/^[a-f0-9]{64}$/);assert.equal(row.first_ip_hash,row.last_ip_hash);
 assert.ok(!JSON.stringify(row).includes('1.2.3.4'));
});
test('校验非法编号/token/排列',()=>{
 for(const body of [null,[],request({browserToken:'a'}),request({preferredTreatment:'P6'}),request({participantId:4}),request({preferredOrders:[[0,0,1],[0,1,2,3]]}),request({preferredOrders:[[0,1,2],[0,1,2,9]]})]) assert.equal(parseAssignment(body),null);
 assert.ok(parseAssignment(request()));
});
test('未提供排序时服务器生成合法3/4排列',t=>{
 const {resolve}=setup(t);const result=resolve(request({preferredOrders:undefined}),signal());
 assert.deepEqual([...result.orders[0]].sort(),[0,1,2]);assert.deepEqual([...result.orders[1]].sort(),[0,1,2,3]);
});