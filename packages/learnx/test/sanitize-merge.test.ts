import { it, expect } from 'vitest';
import { parse } from 'smol-toml';
import { mergeToml } from '../src/install.js';
import { safeSegment } from '../src/storage.js';

const entry = { command: 'C:/Program Files/nodejs/node.exe', args: ['D:/code/learnx-mcp/dist/cli.js', 'serve'], env: { LEARNX_MOCK: '0' } };

// 超线性正则换线性扫描后的行为回归：结果逐字节一致，超长输入不再二次回溯。
it('safeSegment 去掉首尾的点与空格，保留中间空白', () => {
  expect(safeSegment('.. 课程 课件 ..')).toBe('课程 课件');
  expect(safeSegment('  两侧空格  ')).toBe('两侧空格');
  expect(safeSegment('a  b')).toBe('a  b');
  expect(safeSegment(' . . ')).toBe('_');
  expect(safeSegment('...')).toBe('_');
});

it('safeSegment 其余规则不变：前导下划线折叠与 Windows 保留名', () => {
  expect(safeSegment('__x')).toBe('_x');
  expect(safeSegment('con.txt')).toBe('_con.txt');
  expect(safeSegment('a/b\\c')).toBe('a_b_c');
});

it('safeSegment 处理超长内嵌空白是线性的', () => {
  const input = 'x' + ' '.repeat(100_000) + 'z';
  const started = Date.now();
  const value = safeSegment(input);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(value.startsWith('x')).toBe(true);
  expect(value.length).toBeLessThanOrEqual(72);
});

it('mergeToml 去掉末尾空白后只保留一个空行分隔，内容仍可解析', () => {
  const before = 'model = "keep-me"\n' + ' '.repeat(64) + '\n\n\n';
  const after = mergeToml(before, entry, false);
  expect(after.startsWith('model = "keep-me"\n\n')).toBe(true);
  expect(/[ \t]+\n\n/.test(after)).toBe(false);
  expect((parse(after) as any).model).toBe('keep-me');
  expect(mergeToml(after, entry, false)).toBe(after);
});