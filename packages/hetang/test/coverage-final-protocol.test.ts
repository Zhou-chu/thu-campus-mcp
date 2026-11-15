import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataOf, identifier, parseJson } from '../src/protocol.js';
import { applyEvent, normalizeAnswer } from '../src/classroom.js';
import type { LessonData, Question } from '../src/types.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const question = (type: Question['type'] = 'single'): Question => ({
  id: 'q', lessonId: 'lesson', presentationId: 'deck', slideId: 'slide', type,
  prompt: 'offline question', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }], published: false, answered: false,
});
const state = (): LessonData => ({ account: 'offline', lessonId: 'lesson', published: [], questions: [question()], resources: [] });

describe('lossless protocol edges', () => {
  it('preserves escaped strings and unsafe signed integers without altering decimal or exponent syntax', () => {
    const text = '{"escaped":"a\\\"b\\\\c","large":9007199254740993,"negative":-9007199254740993,"decimal":1.25,"exponent":2e3,"zero":0}';
    expect(parseJson(text)).toEqual({ escaped: 'a"b\\c', large: '9007199254740993', negative: '-9007199254740993', decimal: 1.25, exponent: 2000, zero: 0 });
    expect(() => parseJson('"unterminated')).toThrow(SyntaxError);
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects unsafe numeric identifier %s', value => {
    expect(() => identifier(value)).toThrow(expect.objectContaining({ code: 'UNSAFE_ID' }));
  });
  it.each([undefined, null, '', false, {}, []])('rejects invalid identifier %j', value => {
    expect(() => identifier(value)).toThrow(expect.objectContaining({ code: 'INVALID_ID' }));
  });
  it('falls through null data to result, then raw values without losing falsy values', () => {
    expect(dataOf({ data: null, result: { id: 'fallback' } })).toEqual({ id: 'fallback' });
    expect(dataOf({ data: null, result: null, keep: true })).toEqual({ data: null, result: null, keep: true });
    expect(dataOf(undefined)).toBeUndefined(); expect(dataOf(null)).toBeNull();
    expect(dataOf({ data: 0, result: 'ignored' })).toBe(0);
  });
});

describe('answer format rejection boundaries without a client or network', () => {
  it('refuses unsupported question types', () => {
    expect(() => normalizeAnswer(question('unknown'), ['A'])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_QUESTION' }));
  });
  it.each(['  ', { content: '' }, { content: 4 }, undefined, 'x'.repeat(20001)])('rejects invalid subjective content %j', value => {
    expect(() => normalizeAnswer(question('subjective'), value)).toThrow(expect.objectContaining({ code: 'ANSWER_FORMAT' }));
  });
  it.each([' trimmed ', { content: ' trimmed ' }])('normalizes subjective text %j', value => {
    expect(normalizeAnswer(question('subjective'), value)).toEqual({ content: 'trimmed', pics: [{ pic: '' }], videos: [] });
  });
  it.each([undefined, {}, [], Array(51).fill('A'), [1], ['x'.repeat(10001)]])('rejects invalid array content %j', value => {
    expect(() => normalizeAnswer(question(), value)).toThrow(expect.objectContaining({ code: 'ANSWER_FORMAT' }));
  });
  it('accepts a scalar option and trims blank entries without option validation', () => {
    expect(normalizeAnswer(question(), ' a ')).toEqual(['A']);
    expect(normalizeAnswer(question('blank'), [' one ', ' '])).toEqual(['one', '']);
    expect(normalizeAnswer(question('multiple'), ['b', ' a ', 'B'])).toEqual(['A', 'B']);
  });
});

describe('classroom event alias and missing-identity boundaries', () => {
  it('ignores absent op and unlock records without a stable question id', () => {
    const s = state(); expect(applyEvent(s, undefined, 1000)).toEqual([]);
    expect(applyEvent(s, { op: 'unlockproblem' }, 1000)).toEqual([]); expect(s.published).toEqual([]);
  });
  it('ignores non-array timelines and does not invent a presentation', () => {
    const s = state(); expect(applyEvent(s, { op: 'hello', timeline: {} }, 1000)).toEqual([]);
    expect(s.presentationId).toBeUndefined();
  });
  it('processes presentation timeline aliases while ignoring unsupported and incomplete entries', () => {
    const s = state();
    const events = applyEvent(s, { op: 'fetchtimeline', timeline: [
      { type: 'slide', pres: 'deck' }, { type: 'presentation' }, { type: 'other' },
      { type: 'presentation', presentationId: 'alternate' }, { type: 'presentation', id: 'last' },
    ] }, 1000);
    expect(s.presentationId).toBe('last'); expect(events.map(e => e.kind)).toEqual(['presentation']);
    expect(s.publishedSlides).toBeUndefined();
  });
  it('does not republish duplicate slides or invent idless presentation switches', () => {
    const s = state(); s.presentationId = 'old'; s.publishedSlides = { deck: ['slide'] };
    applyEvent(s, { op: 'hello', timeline: [{ type: 'slide', pres: 'deck', sid: 'slide' }] }, 1000);
    expect(s.publishedSlides).toEqual({ deck: ['slide'] });
    expect(applyEvent(s, { op: 'switchpresentation' }, 1000)).toMatchObject([{ kind: 'presentation' }]);
    expect(s.presentationId).toBe('deck');
    applyEvent(s, { op: 'sendpresentation', presentation: { id: 'nested-deck' } }, 1000);
    expect(s.presentationId).toBe('nested-deck');
  });
  it('answers using the last identity and question aliases and the result fallback', () => {
    const s = state();
    expect(applyEvent(s, { op: 'problemanswered', user_id: 'me', prob: 'q', result: ['B'] }, 1000, 'me')).toMatchObject([{ kind: 'question-answered', questionId: 'q' }]);
    expect(s.questions[0]).toMatchObject({ answered: true, answer: ['B'] });
    expect(applyEvent(s, { op: 'problemanswered', prob: 'missing' }, 1000)).toEqual([]);
  });
  it('emits closure without fabricating state for an absent question id', () => {
    const s = state(); const events = applyEvent(s, { op: 'lockproblem' }, 1000);
    expect(events).toMatchObject([{ kind: 'question-closed', questionId: undefined }]); expect(s.timings).toBeUndefined();
    expect(s.questions[0].endAt).toBeUndefined();
    applyEvent(s, { op: 'problemfinished', prob: 'missing' }, 2000);
    expect(s.timings?.missing).toEqual({ endAt: 2000 });
  });
});
