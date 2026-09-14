import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const values = new Map();
const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
function load(name,draw=()=>0,store=storage){
 const js=ts.transpileModule(readFileSync(new URL(`../src/experiment/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context={exports:{},URLSearchParams,window:{localStorage:store},crypto:{getRandomValues(a){a[0]=draw();return a;}}};
 vm.runInNewContext(js,context);return context.exports;
}
const initial=load('treatments');
// 既有分配保持兼容，不给已进入过实验的人重新抽签。
values.set('honglvdeng_treatment_v1:pid:alice','P3');
assert.equal(initial.resolveTreatmentId('?treatment=P3','alice'),'P3');
assert.equal(load('treatments').resolveTreatmentId('?treatment=N4','alice'),'P3');
assert.equal(load('treatments').resolveTreatmentId('','alice'),'P3');
assert.equal(load('treatments',()=>0).resolveTreatmentId('?treatment=N4','bob'),'C1');
assert.equal(load('treatments').resolveTreatmentId('?treatment=C1',''),'C1');
assert.equal(load('treatments').resolveTreatmentId('?treatment=N5',''),'C1');
// 首次抽签与编号、URL无关；相同编号在独立的首次分配中可以抽到不同材料。
const emptyStore=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};};
const ids=initial.TREATMENT_MATERIALS.map(m=>m.id);
for(let i=0;i<15;i++) {
 assert.equal(load('treatments',()=>i,emptyStore()).resolveTreatmentId('?treatment=N5','same-pid'),ids[i]);
 assert.equal(load('treatments',()=>i,emptyStore()).resolveTreatmentId('',''),ids[i]);
}
let draws=[0xffffffff,7];
assert.equal(load('treatments',()=>draws.shift(),emptyStore()).resolveTreatmentId('','new'),ids[7]);
assert.equal(draws.length,0);
const get=()=>load('manipulationChecks').getPersistentManipulationQuestions;
const first=get()('P3','alice');
const before=JSON.stringify(first);
assert.equal(JSON.stringify(load('manipulationChecks',()=>1).getPersistentManipulationQuestions('P3','alice')),before);
const count=values.size;
load('manipulationChecks',()=>1).getPersistentManipulationQuestions('P3','bob');
assert.equal(values.size,count+1);
// 呼叫端修改返回值不会破坏页内缓存。
const cached=get();
const q=cached('P3','alice');q[0].options.reverse();
assert.equal(JSON.stringify(cached('P3','alice')),before);
// 损坏或旧版三选项缓存必须修复为完整四选项。
const key='honglvdeng_manipulation_order_v1:pid:alice:P3';
values.set(key,JSON.stringify([first[0].options,first[1].options.slice(0,3)]));
assert.equal(get()('P3','alice')[1].options.length,4);
values.set(key,'broken json');
assert.equal(get()('P3','alice')[1].options.length,4);
console.log('PASS: reload, conflicting URL, distinct participants, anonymous return, option order, cache isolation and malformed cache');
