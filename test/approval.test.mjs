import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalPresentation,decideApproval} from '../webui/approval.js';

test('待审批默认展开，明确显示状态而非执行结果',()=>{
 assert.deepEqual(approvalPresentation({}),{state:'pending',decided:false,busy:false,label:'待审批',open:true,error:''});
 assert.equal(approvalPresentation({expanded:false}).open,false);
});
test('已处理记录默认收起，仍可人工展开',()=>{
 for(const [allowed,state,label] of [[true,'allowed','已允许执行'],[false,'denied','已拒绝'],[undefined,'resolved','已处理']]){
  const view=approvalPresentation({decided:true,allowed});assert.equal(view.state,state);assert.equal(view.label,label);assert.equal(view.open,false);
 }
 assert.equal(approvalPresentation({decided:true,expanded:true,submitting:true}).open,true);
 assert.equal(approvalPresentation({decided:true,submitting:true}).busy,false);
});
test('提交期间锁定按钮而非提前标记已决定；并发点击仅提交一次',async()=>{
 let finish;let calls=0;const block={};const work=decideApproval(block,true,async value=>{assert.equal(value,true);calls++;await new Promise(resolve=>finish=resolve);return {decided:true};});
 assert.equal(block.decided,undefined);assert.equal(approvalPresentation(block).state,'submitting');assert.equal(approvalPresentation(block).busy,true);
 assert.equal(await decideApproval(block,false,()=>calls++),false);assert.equal(calls,1);
 finish();assert.equal(await work,true);assert.equal(approvalPresentation(block).state,'allowed');
 assert.equal(await decideApproval(block,false,()=>calls++),false);assert.equal(calls,1);
});
test('批准和拒绝都只在确认成功后收起外层及参数，保留决定',async()=>{
 for(const allow of [true,false]){const block={expanded:true,payloadOpen:true,decisionError:'旧错误'};assert.equal(await decideApproval(block,allow,async value=>{assert.equal(value,allow);return {decided:true};}),true);assert.equal(block.decided,true);assert.equal(block.allowed,allow);assert.equal(block.expanded,false);assert.equal(block.payloadOpen,false);assert.equal(block.submitting,false);assert.equal(block.decisionError,'');}
});
test('拒绝非法决定，不调用提交函数',async()=>{
 for(const allow of [null,undefined,'true',1])assert.equal(await decideApproval({},allow,()=>{throw Error('should not submit');}),false);
});
test('失败保留未决定状态，展开错误并允许安全重试',async()=>{
 const block={expanded:false,payloadOpen:true};assert.equal(await decideApproval(block,true,async()=>{throw Error('网络暂不可用');}),false);
 assert.equal(block.decided,undefined);assert.equal(block.submitting,false);assert.equal(block.expanded,true);assert.equal(block.payloadOpen,true);assert.equal(approvalPresentation(block).error,'提交失败：网络暂不可用');
 assert.equal(await decideApproval(block,false,async()=>({decided:true})),true);assert.equal(block.allowed,false);assert.equal(approvalPresentation(block).error,'');
});
test('HTTP成功但无明确决定回执不能显示批准成功',async()=>{
 for(const receipt of [undefined,{}, {decided:false}]){const block={};assert.equal(await decideApproval(block,true,async()=>receipt),false);assert.equal(block.decided,undefined);assert.equal(block.expanded,true);assert.match(approvalPresentation(block).error,/审批已失效/);}
});
test('非Error异常也能显示并恢复按钮',async()=>{
 for(const error of ['连接失败',null,{message:'接口失败'}]){const block={};assert.equal(await decideApproval(block,true,async()=>{throw error;}),false);assert.match(approvalPresentation(block).error,/提交失败：/);assert.equal(approvalPresentation(block).busy,false);}
});
