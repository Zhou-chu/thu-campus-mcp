import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sidebarStorageLabel,recentSessions} from '../webui/sidebar.js';

test('最近会话只取真实有效ID，去重且保持服务端排序',()=>{
 const input=[null,{}, {id:0}, {id:' '}, {id:'a',title:'真实记录'}, {id:'a',title:'重复'}, {id:'b',title:''}, {id:'c',title:42}, {id:'d',title:'第四条'}];
 assert.deepEqual(recentSessions(input),[{id:'a',title:'真实记录'},{id:'b',title:'未命名对话'},{id:'c',title:'未命名对话'}]);
 assert.equal(input.length,9);
});
test('空历史与无效类型不生成示例会话',()=>{
 for(const input of [undefined,null,{},'a',[]])assert.deepEqual(recentSessions(input),[]);
 assert.deepEqual(recentSessions([{id:'a',title:'   '}]),[{id:'a',title:'未命名对话'}]);
});
test('仅完整核验presentation的ready范围显示已连接',()=>{
 const scope={accountId:'fixture-account',repoId:'fixture-private',rootPath:'/Agent工作区'};
 assert.equal(sidebarStorageLabel({state:'ready',scope}),'云盘已连接');
 for(const broken of [undefined,{}, {...scope,repoId:''}, {...scope,rootPath:3}, {...scope,accountId:' '}])assert.equal(sidebarStorageLabel({state:'ready',scope:broken,label:'已连接'}),'云盘未核验');
});
test('查询、未登录、失败和未初始化保留真实标签，不冒充已连接',()=>{
 for(const state of ['loading','login-required','unknown','needs-init','unverified'])assert.equal(sidebarStorageLabel({state,label:'云盘工作区暂不可用'}),'云盘暂不可用');
 for(const value of [undefined,null,{}, {label:42}, {label:''}, {label:' '}])assert.equal(sidebarStorageLabel(value),'云盘未核验');
});
