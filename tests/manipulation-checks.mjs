import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/experiment/manipulationChecks.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(draw) {
  const context = {exports:{},crypto:{getRandomValues(a){a[0]=draw();return a;}}};
  vm.runInNewContext(js, context);
  return context.exports.getManipulationQuestions;
}
const get = load(()=>0);
const negative = ['核酸过期4小时','先审批再转运','凌晨4时25分出车','患者突发哮喘','凌晨2点40分发生事故'];
for (let i=1;i<=5;i++) {
  const control=get(`C${i}`);
  for (const group of ['C','P','N']) {
    const q=get(`${group}${i}`);
    assert.equal(q.length,2);
    assert.equal(q[0].options.length,3);
    assert.equal(q[1].options.length,4);
    for(let n=0;n<2;n++) {
      assert.equal(new Set(q[n].options).size,q[n].options.length);
      assert.equal(JSON.stringify([...q[n].options].sort()),JSON.stringify([...control[n].options].sort()));
      assert.ok(q[n].options.includes(q[n].answer));
    }
    if(group==='N') assert.equal(q[1].answer,negative[i-1]);
    if(group!=='C') assert.notEqual(q[1].answer,control[1].answer);
  }
}
assert.equal(get('P1')[0].answer,'疫情期间孕产妇的就医过程');
assert.equal(get('P1')[1].answer,'救治绿色通道');
assert.throws(()=>get('P6'));
// 穷举每一步等概率选择：4*3*2条路径产生24个不同排列。
const permutations=new Set();
for(let a=0;a<4;a++) for(let b=0;b<3;b++) for(let c=0;c<2;c++) {
  const draws=[0,0,a,b,c];
  const q=load(()=>draws.shift())('N1');
  permutations.add(JSON.stringify(q[1].options));
}
assert.equal(permutations.size,24);
// bound=3 时 2^32-1 必须丢弃，再读取下一个样本。
const draws=[0xffffffff,0,0,0,0,0];
let used=0;
load(()=>{used++;return draws.shift();})('C1');
assert.equal(used,6);
assert.equal(readFileSync(new URL('../jspsych-embed-test/flat-src/src/experiment/manipulationChecks.ts',import.meta.url),'utf8'),source);
console.log('PASS: 15 treatments; fixed 3/4 options; answer mapping; 24 unique permutations; rejection sampling; package parity');