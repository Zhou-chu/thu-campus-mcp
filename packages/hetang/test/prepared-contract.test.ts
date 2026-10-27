import {it,expect,vi,afterEach} from 'vitest';
import {RainClient} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {AnswerService} from '../src/classroom.js';
import type {Question} from '../src/types.js';
const q:Question={id:'q',lessonId:'lesson',presentationId:'deck',slideId:'slide',type:'single',prompt:'Question',options:[{key:'A',text:'No'},{key:'B',text:'Yes'}],published:true,answered:false,startAt:100000,publicationTimeSource:'server'} as any;
const contract=()=>import('../src/prepared-contract.js').catch(()=>({} as any));
afterEach(()=>vi.unstubAllGlobals());
it('fingerprints immutable content and account epochs, not publication or CDN signatures',async()=>{
 const m=await contract();expect(typeof m.questionContentFingerprint).toBe('function');
 const a={...q,imageUrl:'https://cdn.xuetangx.com/q.png?token=one'},b={...a,published:false,endAt:120000,imageUrl:'https://cdn.xuetangx.com/q.png?token=two'};
 expect(m.questionContentFingerprint(a)).toBe(m.questionContentFingerprint(b));expect(m.questionContentFingerprint({...a,prompt:'Changed'})).not.toBe(m.questionContentFingerprint(a));
 expect(m.questionSnapshotFingerprint(a,'A','epoch1')).not.toBe(m.questionSnapshotFingerprint(a,'B','epoch1'));expect(m.questionSnapshotFingerprint(a,'A','epoch1')).not.toBe(m.questionSnapshotFingerprint(a,'A','epoch2'));
});
it('samples the valid20–40second intersection once and refuses short, late or untrusted times',async()=>{
 const m=await contract();expect(typeof m.selectAnswerTime).toBe('function');const random=vi.fn((min:number)=>min);
 expect(m.selectAnswerTime(q,101000,500000,random)).toMatchObject({publishedAt:100000,targetAt:120000,latestSendAt:140000,delayMs:20000});expect(random).toHaveBeenCalledWith(20000,40000);
 expect(m.selectAnswerTime({...q,endAt:130000},101000,500000,(_a:number,b:number)=>b-1).targetAt).toBe(129999);
 for(const [question,now] of [[{...q,endAt:119000},101000],[q,140001],[{...q,publicationTimeSource:'observed'},101000],[{...q,startAt:undefined},101000]] as any[])expect(()=>m.selectAnswerTime(question,now,500000,random)).toThrow();
});
it('rejects late, edited and already answered content at the final gate',async()=>{
 const m=await contract();expect(typeof m.assertPreparedQuestion).toBe('function');const hash=m.questionContentFingerprint(q),window=m.selectAnswerTime(q,101000,500000,(n:number)=>n);
 expect(()=>m.assertPreparedQuestion(hash,q,window,120000)).not.toThrow();for(const [question,time]of [[q,119999],[q,140001],[{...q,prompt:'edit'},125000],[{...q,answered:true},125000],[{...q,published:false},125000],[{...q,endAt:120000},125000]] as any[])expect(()=>m.assertPreparedQuestion(hash,question,window,time)).toThrow();
});
it('blocks fetch when async preflight overruns the final synchronous transport gate',async()=>{
 const c=new RainClient(loadConfig());c.checkAuth=async()=>{};(c as any).auth={cookieHeader:'sessionid=synthetic',bearerToken:'synthetic'};const fetcher=vi.fn(async()=>Response.json({code:0}));vi.stubGlobal('fetch',fetcher);let late=false;
 await expect(c.request('/api/v3/lesson/problem/answer',{method:'POST',body:'{}'},undefined,undefined,undefined,{beforeSend:async()=>{late=true},assertNow:()=>{if(late)throw new Error('late-window')}})).rejects.toThrow('late-window');expect(fetcher).not.toHaveBeenCalled();
});
