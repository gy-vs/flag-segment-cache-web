import express from 'express';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

type Attrs=Record<string,unknown>;
type SegmentRule=
  |{type:'attr';attr:string;op:'eq'|'neq'|'contains'|'gt'|'lt';value:unknown}
  |{type:'segment';segmentId:string};
type Segment={id:string;name:string;revision:number;match:'all'|'any';rules:SegmentRule[];updatedAt:string};
type Flag={id:string;name:string;revision:number;content:string;segmentIds:string[];updatedAt:string};
type EvalResult={flagId:string;flagRevision:number;userId:string;value:boolean;matchedSegments:string[];closure:{id:string;revision:string}[]};

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
/** Recursively sort object keys so semantically equal attribute sets share one cache key. */
const stable=(value:unknown):unknown=>
  Array.isArray(value)?value.map(stable):
  value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):
  value;

const segments: Segment[]=[
  {id:'seg-us',name:'US users',revision:2,match:'all',rules:[{type:'attr',attr:'country',op:'eq',value:'US'}],updatedAt:new Date(0).toISOString()},
  {id:'seg-beta',name:'Beta plan',revision:1,match:'all',rules:[{type:'attr',attr:'plan',op:'eq',value:'beta'}],updatedAt:new Date(0).toISOString()},
  {id:'seg-us-beta',name:'US beta testers',revision:4,match:'all',rules:[{type:'segment',segmentId:'seg-us'},{type:'segment',segmentId:'seg-beta'}],updatedAt:new Date(0).toISOString()},
];
const flags: Flag[]=[
  {id:'alpha',name:'Primary evaluation rules',revision:3,content:'evaluation rules: alpha\nstate: active',segmentIds:['seg-us-beta'],updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary evaluation rules',revision:5,content:'evaluation rules: beta\nstate: review',segmentIds:['seg-us'],updatedAt:new Date(1000).toISOString()},
];

export class SegmentGraph{
  private byId=new Map<string,Segment>();
  private closureMemo=new Map<string,string>();
  /** Bumped on every write; used to detect writes racing an in-flight evaluation. */
  generation=0;
  constructor(rows:Segment[]){for(const row of rows)this.byId.set(row.id,row)}
  get(id:string){return this.byId.get(id)}
  list(){return [...this.byId.values()]}
  private refs(rules:SegmentRule[]){return rules.filter((r):r is Extract<SegmentRule,{type:'segment'}>=>r.type==='segment').map(r=>r.segmentId)}
  /** Validate a proposed rule set: referenced segments must exist and must not close a cycle. */
  validate(id:string,rules:SegmentRule[]):{cycle?:string[];unknown?:string}{
    const refsOf=(sid:string)=>sid===id?this.refs(rules):this.refs(this.byId.get(sid)?.rules??[]);
    for(const ref of this.refs(rules))if(ref!==id&&!this.byId.has(ref))return{unknown:ref};
    const stack:string[]=[id];const visited=new Set<string>();
    const visit=(sid:string):string[]|null=>{
      for(const ref of refsOf(sid)){
        if(ref===id)return[...stack,ref];
        if(visited.has(ref))continue;
        visited.add(ref);stack.push(ref);
        const hit=visit(ref);
        if(hit)return hit;
        stack.pop();
      }
      return null;
    };
    const cycle=visit(id);
    return cycle?{cycle}:{};
  }
  upsert(segment:Segment){this.byId.set(segment.id,segment);this.closureMemo.clear();this.generation+=1}
  /** Content identity of a segment: own revision folded with the identities of all nested segments. */
  closureVersion(id:string):string{
    const memo=this.closureMemo.get(id);
    if(memo)return memo;
    const seg=this.byId.get(id);
    if(!seg)throw new Error(`unknown segment ${id}`);
    const deps=this.refs(seg.rules).map(ref=>this.closureVersion(ref)).sort();
    const version=hash({id:seg.id,revision:seg.revision,deps});
    this.closureMemo.set(id,version);
    return version;
  }
  /** Segments whose transitive closure includes `id` (the descendants invalidated by a write to `id`). */
  descendantsOf(id:string):string[]{
    const result:string[]=[];
    for(const seg of this.byId.values()){
      if(seg.id===id)continue;
      const seen=new Set<string>();
      const reaches=(sid:string):boolean=>{
        for(const ref of this.refs(this.byId.get(sid)?.rules??[])){
          if(ref===id)return true;
          if(!seen.has(ref)){seen.add(ref);if(reaches(ref))return true}
        }
        return false;
      };
      if(reaches(seg.id))result.push(seg.id);
    }
    return result.sort();
  }
  /** Transitive closure of `ids` as stable {id, revision} pairs, for responses and cache identity. */
  closureOf(ids:string[]):{id:string;revision:string}[]{
    const out:{id:string;revision:string}[]=[];const seen=new Set<string>();
    const walk=(sid:string)=>{
      if(seen.has(sid))return;
      seen.add(sid);
      const seg=this.byId.get(sid);
      if(!seg)return;
      out.push({id:seg.id,revision:`${seg.revision}@${this.closureVersion(seg.id)}`});
      for(const ref of this.refs(seg.rules))walk(ref);
    };
    for(const id of ids)walk(id);
    return out.sort((a,b)=>a.id.localeCompare(b.id));
  }
  matches(id:string,attrs:Attrs):boolean{
    const seg=this.byId.get(id);
    if(!seg)return false;
    // The graph is acyclic (cycles are rejected on write), so plain recursion is safe.
    const results=seg.rules.map(rule=>{
      if(rule.type==='segment')return this.matches(rule.segmentId,attrs);
      const actual=attrs[rule.attr];
      switch(rule.op){
        case 'eq':return actual===rule.value;
        case 'neq':return actual!==rule.value;
        case 'contains':return typeof actual==='string'?actual.includes(String(rule.value)):Array.isArray(actual)&&actual.includes(rule.value);
        case 'gt':return typeof actual==='number'&&actual>Number(rule.value);
        case 'lt':return typeof actual==='number'&&actual<Number(rule.value);
      }
    });
    return seg.match==='any'?results.some(Boolean):results.every(Boolean);
  }
}

class LruCache<V>{
  private map=new Map<string,V>();
  constructor(private capacity:number){}
  get(key:string):V|undefined{
    const value=this.map.get(key);
    if(value===undefined)return undefined;
    this.map.delete(key);this.map.set(key,value);
    return value;
  }
  set(key:string,value:V){
    this.map.delete(key);this.map.set(key,value);
    while(this.map.size>this.capacity)this.map.delete(this.map.keys().next().value!);
  }
  get size(){return this.map.size}
}

/** Coalesces concurrent computations per key. A caller's abort never cancels the shared computation. */
export class Singleflight<V>{
  private inflight=new Map<string,Promise<V>>();
  has(key:string){return this.inflight.has(key)}
  async do(key:string,fn:()=>Promise<V>,signal?:AbortSignal):Promise<V>{
    const existing=this.inflight.get(key);
    if(existing)return this.wait(existing,signal);
    const promise=(async()=>{try{return await fn()}finally{this.inflight.delete(key)}})();
    promise.catch(()=>{}); // a caller may abort before the shared promise settles
    this.inflight.set(key,promise);
    return this.wait(promise,signal);
  }
  private wait(promise:Promise<V>,signal?:AbortSignal):Promise<V>{
    if(!signal)return promise;
    if(signal.aborted)return Promise.reject(new Error('aborted'));
    return new Promise<V>((resolve,reject)=>{
      const onAbort=()=>reject(new Error('aborted'));
      signal.addEventListener('abort',onAbort,{once:true});
      promise.then(
        value=>{signal.removeEventListener('abort',onAbort);resolve(value)},
        error=>{signal.removeEventListener('abort',onAbort);reject(error)},
      );
    });
  }
}

export type AppOptions={cacheCapacity?:number;evaluateDelayMs?:number};

export function createApp(options:AppOptions={}){
  // Clone seed rows so each app instance is isolated.
  const graph=new SegmentGraph(segments.map(row=>({...row,rules:row.rules.map(rule=>({...rule}))})));
  const flagRows=flags.map(row=>({...row,segmentIds:[...row.segmentIds]}));
  const cache=new LruCache<EvalResult>(options.cacheCapacity??256);
  const flight=new Singleflight<EvalResult>();
  const delay=options.evaluateDelayMs??0;
  const stats={hits:0,misses:0,computes:0,coalesced:0,staleDrops:0};

  /** Cache identity covers the flag revision and the content identity of the whole segment closure. */
  function flagVersion(flag:Flag){
    return hash({flag:flag.revision,segments:flag.segmentIds.map(id=>graph.closureVersion(id)).sort()});
  }
  async function evaluate(flag:Flag,userId:string,attrs:Attrs,signal?:AbortSignal){
    const version=flagVersion(flag);
    const key=[flag.id,version,userId,hash(stable(attrs))].join('|');
    const cached=cache.get(key);
    if(cached){stats.hits+=1;return{...cached,cache:{status:'hit' as const,version}};}
    stats.misses+=1;
    const coalesced=flight.has(key);
    if(coalesced)stats.coalesced+=1;
    const result=await flight.do(key,async()=>{
      stats.computes+=1;
      const generation=graph.generation;
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      const matchedSegments=flag.segmentIds.filter(id=>graph.matches(id,attrs));
      const value=matchedSegments.length===flag.segmentIds.length;
      const computed:EvalResult={flagId:flag.id,flagRevision:flag.revision,userId,value,matchedSegments,closure:graph.closureOf(flag.segmentIds)};
      // Never publish a result computed under a stale closure to the cache.
      if(graph.generation!==generation){stats.staleDrops+=1;return computed;}
      cache.set(key,computed);
      return computed;
    },signal);
    return{...result,cache:{status:coalesced?('coalesced' as const):('miss' as const),version}};
  }

  const app=express();
  app.use(express.json({limit:'1mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({family:'feature-eval',count:flagRows.length}));

  app.get('/api/flags',(_req,res)=>res.json(flagRows.map(({content,...row})=>row)));
  app.get('/api/flags/:id',(req,res)=>{const row=flagRows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/flags/:id',(req,res)=>{const row=flagRows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});if(Array.isArray(req.body.segmentIds)){const missing=req.body.segmentIds.map(String).find(id=>!graph.get(id));if(missing)return res.status(422).json({error:'unknown_segment',segment:missing});row.segmentIds=req.body.segmentIds.map(String)}row.content=String(req.body.content??row.content);row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/flags/:id/analyze',async(req,res)=>{const row=flagRows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});
  app.post('/api/flags/:id/evaluate',async(req,res)=>{
    const row=flagRows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const userId=String(req.body.userId??'');
    const attrs=(req.body.attributes&&typeof req.body.attributes==='object'?req.body.attributes:{})as Attrs;
    const controller=new AbortController();
    req.on('close',()=>{if(!res.writableEnded)controller.abort()});
    try{
      res.json(await evaluate(row,userId,attrs,controller.signal));
    }catch{
      if(!res.headersSent)res.status(499).json({error:'client_closed'});
    }
  });

  app.get('/api/segments',(_req,res)=>res.json(graph.list().map(({rules,...row})=>row)));
  app.get('/api/segments/:id',(req,res)=>{const row=graph.get(req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.json({...row,closureVersion:graph.closureVersion(row.id),descendants:graph.descendantsOf(row.id)})});
  app.post('/api/segments',(req,res)=>{
    const id=String(req.body.id??'');
    if(!id)return res.status(400).json({error:'id_required'});
    if(graph.get(id))return res.status(409).json({error:'already_exists'});
    const rules=(Array.isArray(req.body.rules)?req.body.rules:[])as SegmentRule[];
    const problem=graph.validate(id,rules);
    if(problem.unknown)return res.status(422).json({error:'unknown_segment',segment:problem.unknown});
    if(problem.cycle)return res.status(422).json({error:'segment_cycle',cycle:problem.cycle});
    const row:Segment={id,name:String(req.body.name??id),revision:1,match:req.body.match==='any'?'any':'all',rules,updatedAt:new Date().toISOString()};
    graph.upsert(row);
    res.status(201).json(row);
  });
  app.put('/api/segments/:id',(req,res)=>{
    const row=graph.get(req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});
    const rules=(Array.isArray(req.body.rules)?req.body.rules:row.rules)as SegmentRule[];
    const problem=graph.validate(row.id,rules);
    if(problem.unknown)return res.status(422).json({error:'unknown_segment',segment:problem.unknown});
    if(problem.cycle)return res.status(422).json({error:'segment_cycle',cycle:problem.cycle});
    row.rules=rules;
    if(req.body.name!==undefined)row.name=String(req.body.name);
    if(req.body.match!==undefined)row.match=req.body.match==='any'?'any':'all';
    row.revision+=1;
    row.updatedAt=new Date().toISOString();
    graph.upsert(row);
    // Only descendants of this segment are invalidated; unrelated cache entries stay warm.
    res.json({...row,closureVersion:graph.closureVersion(row.id),invalidated:graph.descendantsOf(row.id)});
  });

  app.get('/api/cache/stats',(_req,res)=>res.json({capacity:options.cacheCapacity??256,size:cache.size,...stats}));
  return app;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
