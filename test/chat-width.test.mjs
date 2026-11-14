import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_WIDTH_KEY, createChatWidth, dragChatWidth, keyChatWidth } from '../webui/chat-width.js';

function memory(raw = null) {
  const calls = [];
  return {
    calls,
    getItem(key) { assert.equal(key, CHAT_WIDTH_KEY); return raw; },
    setItem(key, value) { calls.push(['set', key, value]); raw = value; },
    removeItem(key) { calls.push(['remove', key]); raw = null; },
  };
}

test('default snapshot and fixed storage key', () => {
  assert.equal(CHAT_WIDTH_KEY, 'campus.app.chatWidth');
  const model = createChatWidth(memory());
  assert.deepEqual(model.snapshot(2000.9), {
    preferred: null, automatic: true, value: 1440, min: 640, max: 2000, error: null,
  });
  assert.equal(model.snapshot(1000).value, 1000);
});

test('reads decimal numeric strings, rounds and preserves preference', () => {
  for (const [raw, expected] of [[' 1200.6 ', 1201], ['+640', 640], ['1.5e3', 1500], ['.9', 1], ['16384', 16384]]) {
    const model = createChatWidth(memory(raw));
    assert.equal(model.snapshot(20000).preferred, expected);
    assert.equal(model.snapshot(20000).automatic, false);
  }
});

test('invalid stored values safely fall back to automatic', () => {
  for (const raw of [null, undefined, 1200, {}, '', '  ', 'null', 'false', '0', '-1', 'NaN', 'Infinity', '1e309', '16385', '16384.1', '0.1', '0x1000', '1200px', '1200;alert(1)', '<script>', '1_000']) {
    const state = createChatWidth(memory(raw)).snapshot(2000);
    assert.equal(state.preferred, null, String(raw));
    assert.equal(state.value, 1440);
    assert.equal(state.error, null);
  }
});

test('available is floored and invalid available becomes zero', () => {
  const model = createChatWidth(memory('1800'));
  for (const available of [undefined, null, NaN, Infinity, -Infinity, -1, '900', {}, Symbol('width')]) {
    const { value, min, max } = model.snapshot(available);
    assert.deepEqual({ value, min, max }, { value: 0, min: 0, max: 0 });
  }
  for (const [available, min, max] of [[0, 0, 0], [0.9, 0, 0], [390.9, 390, 390], [640, 640, 640], [641.9, 640, 641], [2000, 640, 2000]]) {
    const state = model.snapshot(available);
    assert.equal(state.min, min);
    assert.equal(state.max, max);
    assert.equal(state.value, Math.min(1800, max));
  }
});

test('small screens clamp without overwriting the stored preference', () => {
  const storage = memory('1800');
  const model = createChatWidth(storage);
  assert.equal(model.snapshot(390).value, 390);
  assert.equal(model.snapshot(0).preferred, 1800);
  assert.equal(model.snapshot(2400).value, 1800);
  assert.deepEqual(storage.calls, []);
  model.set(100);
  assert.equal(model.snapshot(2000).value, 640);
  assert.equal(model.snapshot(2000).preferred, 100);
});

test('set rounds numeric values and reset removes storage', () => {
  const storage = memory();
  const model = createChatWidth(storage);
  assert.equal(model.set(1234.5), true);
  assert.equal(model.snapshot(2000).preferred, 1235);
  assert.deepEqual(storage.calls, [['set', CHAT_WIDTH_KEY, '1235']]);
  assert.equal(model.set(null), true);
  assert.deepEqual(storage.calls[1], ['remove', CHAT_WIDTH_KEY]);
  assert.equal(model.snapshot(2000).automatic, true);
  assert.equal(model.snapshot(2000).value, 1440);
});

test('invalid set is inert and does not coerce objects or strings', () => {
  const storage = memory('1000');
  const model = createChatWidth(storage);
  for (const value of [undefined, false, true, '', '1200', '1200;alert(1)', 0, -1, 0.1, NaN, Infinity, -Infinity, 16385, 16384.1, 1n, Symbol('width'), { valueOf() { throw Error('must not coerce'); } }]) {
    assert.equal(model.set(value), false);
    assert.equal(model.snapshot(2000).preferred, 1000);
  }
  assert.deepEqual(storage.calls, []);
  assert.equal(model.set(0.5), true);
  assert.equal(model.snapshot(2000).preferred, 1);
  assert.equal(model.set(16384), true);
});

test('temporary changes and reset only persist on request', () => {
  const storage = memory('1100');
  const model = createChatWidth(storage);
  assert.equal(model.set(1900.4, false), true);
  assert.equal(model.snapshot(390).preferred, 1900);
  assert.deepEqual(storage.calls, []);
  assert.equal(model.persist(), true);
  assert.deepEqual(storage.calls, [['set', CHAT_WIDTH_KEY, '1900']]);
  model.set(null, false);
  assert.equal(storage.calls.length, 1);
  assert.equal(model.persist(), true);
  assert.deepEqual(storage.calls[1], ['remove', CHAT_WIDTH_KEY]);
});

test('read and write failures are safe and successful persistence clears errors', () => {
  let fail = true;
  const storage = {
    getItem() { throw Error('secret must not leak'); },
    setItem() { if (fail) throw Error('quota'); },
    removeItem() { if (fail) throw Error('blocked'); },
  };
  const model = createChatWidth(storage);
  assert.equal(model.snapshot(2000).error, '读取会话宽度失败');
  assert.equal(model.set('bad'), false);
  assert.equal(model.snapshot(2000).error, '读取会话宽度失败');
  assert.equal(model.set(1700, false), true);
  assert.equal(model.snapshot(2000).error, '读取会话宽度失败');
  assert.equal(model.persist(), false);
  assert.equal(model.snapshot(2000).error, '保存会话宽度失败');
  assert.equal(model.set(null), true);
  assert.equal(model.snapshot(2000).error, '保存会话宽度失败');
  fail = false;
  assert.equal(model.persist(), true);
  assert.equal(model.snapshot(2000).error, null);
  assert.equal(model.set(1500), true);
  assert.equal(model.snapshot(2000).error, null);
});

test('unavailable storage, missing methods and throwing accessors never escape', () => {
  for (const storage of [undefined, null, {}, { get getItem() { throw Error('denied'); } }]) {
    const model = createChatWidth(storage);
    assert.match(model.snapshot(2000).error, /读取/);
    assert.equal(model.persist(), false);
    assert.equal(model.set(1200), true);
    assert.equal(model.snapshot(2000).preferred, 1200);
    assert.match(model.snapshot(2000).error, /保存/);
  }
});

test('both pointer grips resize centered width by twice their displacement', () => {
  for (const [edge, delta, expected] of [['right', 50, 1100], ['right', -50, 900], ['left', 50, 900], ['left', -50, 1100]]) {
    assert.equal(dragChatWidth(1000, delta, edge, 2000), expected);
  }
  assert.equal(dragChatWidth(1000, -1000, 'right', 2000), 640);
  assert.equal(dragChatWidth(1000, 1000, 'right', 2000), 2000);
  assert.equal(dragChatWidth(1000, 1000, 'left', 2000), 640);
  assert.equal(dragChatWidth(1000, -1000, 'left', 2000), 2000);
  assert.equal(dragChatWidth(1000, 100, 'right', 390.9), 390);
  assert.equal(dragChatWidth(1000, 1e308, 'right', 2000), 2000);
  assert.equal(dragChatWidth(1000, 1e308, 'left', 2000), 640);
});

test('invalid pointer inputs are safe without coercion', () => {
  for (const value of [undefined, null, NaN, Infinity, '1000', {}, Symbol('x')]) {
    assert.equal(dragChatWidth(value, 0, 'right', 2000), 1440);
    assert.equal(dragChatWidth(1000, value, 'right', 2000), 1000);
  }
  assert.equal(dragChatWidth(1000, 100, 'invalid', 2000), 1000);
  assert.equal(dragChatWidth(1000, 100, undefined, -1), 0);
  assert.equal(dragChatWidth(-100, 0, 'left', 2000), 640);
});

test('keyboard arrows follow grip direction at normal and shift steps', () => {
  for (const [edge, key, expected] of [['right', 'ArrowRight', 1032], ['right', 'ArrowLeft', 968], ['left', 'ArrowRight', 968], ['left', 'ArrowLeft', 1032]]) {
    assert.equal(keyChatWidth(1000, key, edge, 2000), expected);
    assert.equal(keyChatWidth(1000, key, edge, 2000, true), 1000 + (expected - 1000) * 4);
  }
  assert.equal(keyChatWidth(1000, 'ArrowRight', 'right', 2000, 'true'), 1032);
  assert.equal(keyChatWidth(640, 'ArrowLeft', 'right', 2000), 640);
  assert.equal(keyChatWidth(2000, 'ArrowRight', 'right', 2000), 2000);
  assert.equal(keyChatWidth(1000, 'ArrowRight', 'right', 390), 390);
});

test('keyboard limits, reset, unknown keys and invalid inputs', () => {
  for (const edge of ['left', 'right']) {
    assert.equal(keyChatWidth(1000, 'Home', edge, 2000), 640);
    assert.equal(keyChatWidth(1000, 'End', edge, 2000.9), 2000);
    assert.equal(keyChatWidth(1000, 'Home', edge, 390), 390);
    assert.equal(keyChatWidth(1000, 'End', edge, undefined), 0);
    for (const key of ['Enter', ' ']) assert.equal(keyChatWidth(1000, key, edge, 2000), null);
    for (const key of ['Escape', 'Space', 'ArrowUp', undefined, null, {}, Symbol('key')]) {
      assert.equal(keyChatWidth(1000, key, edge, 2000), undefined);
    }
  }
  for (const edge of ['bad', undefined, null, {}]) {
    assert.equal(keyChatWidth(1000, 'ArrowRight', edge, 2000), undefined);
  }
  for (const current of [NaN, Infinity, '1000', undefined, Symbol('current')]) {
    assert.equal(keyChatWidth(current, 'ArrowRight', 'right', 2000), 1472);
  }
});
