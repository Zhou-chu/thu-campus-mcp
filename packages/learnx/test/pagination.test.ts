import { it, expect } from 'vitest';
import { fetchListPages } from '../src/pagination.js';
it('walks DataTables pages instead of keeping only the first response', async () => {
  const offsets: number[] = [];
  const request = async (_url: string, init: RequestInit) => {
    const data = JSON.parse((init.body as FormData).get('aoData') as string);
    const offset = Number(data.find((e: any) => e.name === 'iDisplayStart')?.value || 0); offsets.push(offset);
    return Response.json({ result: 'success', object: { iTotalRecords: 3, aaData: offset === 0 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }] } });
  };
  const form = new FormData(); form.set('aoData', JSON.stringify([{ name: 'wlkcid', value: 'course' }]));
  const result = await (await fetchListPages(request, 'https://learn.tsinghua.edu.cn/b/list', { method: 'POST', body: form })).json();
  expect(result.object.aaData.map((e: any) => e.id)).toEqual(['a', 'b', 'c']); expect(offsets).toEqual([0, 2]);
});
it('fails explicitly when the site ignores pagination rather than claiming all items were fetched', async () => {
  const request = async () => Response.json({ result: 'success', object: { total: 3, resultsList: [{ id: 'a' }, { id: 'b' }] } });
  await expect(fetchListPages(request, 'https://learn.tsinghua.edu.cn/b/list?size=2', {})).rejects.toThrow(/分页/);
});
it('detects unadvertised truncation at the size boundary', async () => {
  const request = async (url: string) => {
    const offset = Number(new URL(url).searchParams.get('iDisplayStart'));
    return Response.json({ result: 'success', object: offset === 0 ? [{ id: 'a' }, { id: 'b' }] : [] });
  };
  const result = await (await fetchListPages(request, 'https://learn.tsinghua.edu.cn/b/list?size=2', {})).json();
  expect(result.object).toHaveLength(2);
});
