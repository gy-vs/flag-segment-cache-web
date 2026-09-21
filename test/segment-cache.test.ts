import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp,Singleflight} from '../src/server/index';

const US_BETA={country:'US',plan:'beta'};
const evaluate=(app:ReturnType<typeof createApp>,flag:string,userId:string,attributes:Record<string,unknown>)=>
  request(app).post(`/api/flags/${flag}/evaluate`).send({userId,attributes});
const stats=async(app:ReturnType<typeof createApp>)=>(await request(app).get('/api/cache/stats').expect(200)).body;
const updateSegment=(app:ReturnType<typeof createApp>,id:string,revision:number,rules:unknown)=>
  request(app).put(`/api/segments/${id}`).send({revision,rules});

describe('segment dependency cache',()=>{
  it('serves fresh results after a direct dependency changes',async()=>{
    const app=createApp();
    const before=await evaluate(app,'beta','u1',US_BETA).expect(200);
    expect(before.body.value).toBe(true);
    expect(before.body.cache.status).toBe('miss');
    const seg=await request(app).get('/api/segments/seg-us').expect(200);
    const updated=await updateSegment(app,'seg-us',seg.body.revision,[{type:'attr',attr:'country',op:'eq',value:'CA'}]).expect(200);
    expect(updated.body.revision).toBe(seg.body.revision+1);
    expect(updated.body.closureVersion).not.toBe(seg.body.closureVersion);
    const after=await evaluate(app,'beta','u1',US_BETA).expect(200);
    expect(after.body.value).toBe(false); // no stale result from the old revision
    expect(after.body.cache.status).toBe('miss');
    expect(after.body.cache.version).not.toBe(before.body.cache.version);
  });

  it('serves fresh results after an indirect (nested) dependency changes',async()=>{
    const app=createApp();
    const before=await evaluate(app,'alpha','u1',US_BETA).expect(200); // alpha -> seg-us-beta -> seg-us
    expect(before.body.value).toBe(true);
    expect(before.body.closure.map((s:{id:string})=>s.id)).toEqual(['seg-beta','seg-us','seg-us-beta']);
    const seg=await request(app).get('/api/segments/seg-us').expect(200);
    const updated=await updateSegment(app,'seg-us',seg.body.revision,[{type:'attr',attr:'country',op:'eq',value:'CA'}]).expect(200);
    expect(updated.body.invalidated).toEqual(['seg-us-beta']); // only affected descendants
    const after=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    expect(after.body.value).toBe(false);
    expect(after.body.cache.version).not.toBe(before.body.cache.version);
  });

  it('keeps unrelated cache entries warm when an unrelated segment changes',async()=>{
    const app=createApp();
    await evaluate(app,'alpha','u1',US_BETA).expect(200);
    const hit=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    expect(hit.body.cache.status).toBe('hit');
    const before=await stats(app);
    await request(app).post('/api/segments').send({id:'seg-other',rules:[{type:'attr',attr:'vip',op:'eq',value:true}]}).expect(201);
    const after=await stats(app);
    expect(after.size).toBe(before.size); // no global flush
    const still=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    expect(still.body.cache.status).toBe('hit');
    expect(still.body.cache.version).toBe(hit.body.cache.version);
    expect((await stats(app)).computes).toBe(before.computes);
  });

  it('rejects nested segment cycles at compile time',async()=>{
    const app=createApp();
    const segUs=await request(app).get('/api/segments/seg-us').expect(200);
    // seg-us -> seg-us-beta -> seg-us closes a cycle
    const cycle=await updateSegment(app,'seg-us',segUs.body.revision,[{type:'segment',segmentId:'seg-us-beta'}]).expect(422);
    expect(cycle.body.error).toBe('segment_cycle');
    expect(cycle.body.cycle).toContain('seg-us-beta');
    // self reference
    const self=await updateSegment(app,'seg-us',segUs.body.revision,[{type:'segment',segmentId:'seg-us'}]).expect(422);
    expect(self.body.error).toBe('segment_cycle');
    // unknown reference
    const unknown=await updateSegment(app,'seg-us',segUs.body.revision,[{type:'segment',segmentId:'seg-nope'}]).expect(422);
    expect(unknown.body.error).toBe('unknown_segment');
    // rejected writes must not bump the revision or disturb the cache
    expect((await request(app).get('/api/segments/seg-us')).body.revision).toBe(segUs.body.revision);
    await evaluate(app,'alpha','u1',US_BETA).expect(200);
    const again=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    expect(again.body.cache.status).toBe('hit');
  });

  it('keys results by user attributes, not just user id',async()=>{
    const app=createApp();
    const us=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    const fr=await evaluate(app,'alpha','u1',{country:'FR',plan:'beta'}).expect(200);
    expect(us.body.value).toBe(true);
    expect(fr.body.value).toBe(false);
    expect(fr.body.cache.version).toBe(us.body.cache.version); // same closure, different attribute key
    const usAgain=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    const frAgain=await evaluate(app,'alpha','u1',{country:'FR',plan:'beta'}).expect(200);
    expect(usAgain.body.cache.status).toBe('hit');
    expect(frAgain.body.cache.status).toBe('hit');
    expect((await stats(app)).computes).toBe(2);
  });

  it('caches negative results',async()=>{
    const app=createApp();
    const first=await evaluate(app,'alpha','u2',{country:'FR',plan:'free'}).expect(200);
    expect(first.body.value).toBe(false);
    expect(first.body.cache.status).toBe('miss');
    const second=await evaluate(app,'alpha','u2',{country:'FR',plan:'free'}).expect(200);
    expect(second.body.value).toBe(false);
    expect(second.body.cache.status).toBe('hit');
    expect((await stats(app)).computes).toBe(1);
  });

  it('coalesces concurrent first computations',async()=>{
    const app=createApp({evaluateDelayMs:50});
    const results=await Promise.all(Array.from({length:5},()=>evaluate(app,'alpha','u1',US_BETA).expect(200)));
    for(const result of results)expect(result.body.value).toBe(true);
    expect(results.filter(r=>r.body.cache.status==='coalesced')).toHaveLength(4);
    const after=await stats(app);
    expect(after.computes).toBe(1);
    expect(after.coalesced).toBe(4);
  });

  it('does not publish a stale closure result computed before a concurrent update',async()=>{
    const app=createApp({evaluateDelayMs:50});
    // .then() kicks off the request immediately, so the compute starts under the old closure
    const inflight=evaluate(app,'alpha','u1',US_BETA).expect(200).then(res=>res.body);
    await new Promise(resolve=>setTimeout(resolve,10));
    const seg=await request(app).get('/api/segments/seg-us').expect(200);
    await updateSegment(app,'seg-us',seg.body.revision,[{type:'attr',attr:'country',op:'eq',value:'CA'}]).expect(200);
    await inflight;
    expect((await stats(app)).staleDrops).toBe(1);
    const after=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    expect(after.body.cache.status).toBe('miss'); // stale entry was never cached
    expect(after.body.value).toBe(false); // reflects the new revision
  });

  it('evicts least recently used entries beyond capacity and recomputes them',async()=>{
    const app=createApp({cacheCapacity:2});
    await evaluate(app,'alpha','u1',US_BETA).expect(200);
    await evaluate(app,'alpha','u2',US_BETA).expect(200);
    await evaluate(app,'alpha','u3',US_BETA).expect(200); // evicts u1
    expect((await stats(app)).size).toBe(2);
    const evicted=await evaluate(app,'alpha','u1',US_BETA).expect(200);
    expect(evicted.body.cache.status).toBe('miss');
    expect(evicted.body.value).toBe(true); // recomputed, still correct
    expect((await stats(app)).computes).toBe(4);
    const kept=await evaluate(app,'alpha','u3',US_BETA).expect(200);
    expect(kept.body.cache.status).toBe('hit');
  });
});

describe('singleflight cancellation',()=>{
  it('a caller aborting does not cancel other waiters',async()=>{
    const flight=new Singleflight<string>();
    let calls=0;
    let release!:(value:string)=>void;
    const gate=new Promise<string>(resolve=>{release=resolve});
    const fn=async()=>{calls+=1;return gate};
    const first=new AbortController();
    const second=new AbortController();
    const p1=flight.do('k',fn,first.signal);
    const p2=flight.do('k',fn,second.signal);
    first.abort();
    await expect(p1).rejects.toThrow('aborted');
    release('done');
    await expect(p2).resolves.toBe('done');
    expect(calls).toBe(1);
    // the key is free again once settled
    await expect(flight.do('k',async()=>{calls+=1;return 'fresh'})).resolves.toBe('fresh');
    expect(calls).toBe(2);
  });
});
