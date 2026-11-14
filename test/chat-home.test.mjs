import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_ACTIONS, ADD_ACTIONS, ICON_PATHS, getHomeAction, homeIsEmpty } from '../webui/chat-home.js';

const filesPrompt = '列出清华云盘个人私有资料库中/Agent工作区的文件，不使用共享或公开资料库。';

test('home actions preserve the real campus configuration and order', () => {
  assert.deepEqual(HOME_ACTIONS, [
    { id: 'assignments', label: '未交作业', icon: 'assignments', prompt: '查询本学期尚未提交的作业，按截止时间排序。' },
    { id: 'courses', label: '更新课程', icon: 'calendar', prompt: '增量更新本学期课程公告、作业和文件，先核对保存目标和变更范围；涉及写入时展示确认卡，等待我授权。' },
    { id: 'files', label: '云盘文件', icon: 'cloud', prompt: filesPrompt },
    { id: 'rain', label: '雨课堂', icon: 'rain', prompt: '查看雨课堂当前课程与待办任务，只查询，不进入课堂或提交答题。' },
    { id: 'auth', label: '登录状态', icon: 'user', view: 'services' },
  ]);
});

test('add actions preserve tools, private files and workspace settings order', () => {
  assert.deepEqual(ADD_ACTIONS, [
    { id: 'tools', label: '选择工具', icon: 'tools', view: 'tools' },
    { id: 'files', label: '云盘文件', icon: 'cloud', prompt: filesPrompt },
    { id: 'workspace', label: '工作区设置', icon: 'cloud', view: 'settings' },
  ]);
});

test('prompt actions are inert draft data, never executable callbacks or requests', () => {
  for (const action of [...HOME_ACTIONS, ...ADD_ACTIONS].filter(action => 'prompt' in action)) {
    assert.deepEqual(Object.keys(action), ['id', 'label', 'icon', 'prompt']);
    assert.ok(Object.values(action).every(value => typeof value === 'string'));
    const draft = { text: '' };
    draft.text = getHomeAction(action.id).prompt;
    assert.equal(draft.text, action.prompt);
  }
});

test('login, tools and settings actions contain views instead of prompts', () => {
  for (const [id, view] of [['auth', 'services'], ['tools', 'tools'], ['workspace', 'settings']]) {
    const action = getHomeAction(id);
    assert.equal(action.view, view);
    assert.deepEqual(Object.keys(action), ['id', 'label', 'icon', 'view']);
  }
});

test('lookup returns original frozen objects and gives home actions priority', () => {
  for (const action of HOME_ACTIONS) assert.equal(getHomeAction(action.id), action);
  assert.notEqual(HOME_ACTIONS[2], ADD_ACTIONS[1]);
  assert.equal(getHomeAction('files'), HOME_ACTIONS[2]);
  assert.equal(getHomeAction('tools'), ADD_ACTIONS[0]);
  assert.equal(getHomeAction('workspace'), ADD_ACTIONS[2]);
});

test('unknown and non-string IDs cannot resolve inherited object properties', () => {
  for (const id of ['missing', '', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'ASSIGNMENTS', null, undefined, 0, false, {}, [], Symbol('auth'), new String('auth')]) {
    assert.equal(getHomeAction(id), null);
  }
  assert.equal(getHomeAction(), null);
});

test('action arrays, every action, and icon dictionary are immutable', () => {
  for (const actions of [HOME_ACTIONS, ADD_ACTIONS]) {
    assert.ok(Object.isFrozen(actions));
    assert.throws(() => actions.push({ id: 'extra' }), TypeError);
    assert.throws(() => { actions[0] = {}; }, TypeError);
    for (const action of actions) {
      assert.ok(Object.isFrozen(action));
      assert.throws(() => { action.label = 'changed'; }, TypeError);
      assert.throws(() => { action.execute = () => {}; }, TypeError);
    }
  }
  assert.ok(Object.isFrozen(ICON_PATHS));
  assert.throws(() => { ICON_PATHS.plus = ''; }, TypeError);
  assert.throws(() => { ICON_PATHS.extra = 'M0 0'; }, TypeError);
});

test('all required icons are SVG path data with upward send and compact stop', () => {
  assert.deepEqual(Object.keys(ICON_PATHS), ['plus', 'cloud', 'send', 'stop', 'refresh', 'assignments', 'calendar', 'rain', 'user', 'tools']);
  for (const path of Object.values(ICON_PATHS)) {
    assert.equal(typeof path, 'string');
    assert.match(path, /^M[\d .,-]+/);
    assert.match(path, /^[MmLlHhVvCcSsQqTtAaZz\d\s.,-]+$/);
  }
  for (const action of [...HOME_ACTIONS, ...ADD_ACTIONS]) assert.ok(Object.hasOwn(ICON_PATHS, action.icon));
  assert.equal(ICON_PATHS.send, 'M12 19V5M6 11l6-6 6 6');
  assert.equal(ICON_PATHS.stop, 'M8 8h8v8H8Z');
});

test('home is empty only for an empty array while not busy', () => {
  assert.equal(homeIsEmpty([]), true);
  assert.equal(homeIsEmpty([], false), true);
  assert.equal(homeIsEmpty([], undefined), true);
  for (const busy of [true, 1, 'busy', {}, []]) assert.equal(homeIsEmpty([], busy), false);
  for (const busy of [null, 0, '']) assert.equal(homeIsEmpty([], busy), true);
  for (const messages of [[{ role: 'user', content: '' }], [null], Array(1), undefined, null, {}, { length: 0 }, '', 'message', 0, false, new Set(), new Uint8Array()]) {
    assert.equal(homeIsEmpty(messages), false);
    assert.equal(homeIsEmpty(messages, true), false);
  }
  assert.equal(homeIsEmpty(), false);
  const messages = Object.freeze([]);
  assert.equal(homeIsEmpty(messages), true);
});
