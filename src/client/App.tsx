import {useEffect,useState} from 'react';
import {FlaskConical,Play,Save,Zap} from 'lucide-react';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type FlagRow=Summary&{content:string;segmentIds:string[]};
type SegmentRow=Summary&{match:'all'|'any';rules:unknown[];closureVersion?:string;invalidated?:string[]};
type Selection={kind:'flag'|'segment';id:string};
type EvalResult={value:boolean;matchedSegments:string[];closure:{id:string;revision:string}[];cache:{status:'hit'|'miss'|'coalesced';version:string}};
export default function App(){
  const [flags,setFlags]=useState<Summary[]>([]);
  const [segments,setSegments]=useState<Summary[]>([]);
  const [selected,setSelected]=useState<Selection>({kind:'flag',id:'alpha'});
  const [flag,setFlag]=useState<FlagRow|null>(null);
  const [segment,setSegment]=useState<SegmentRow|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [evaluation,setEvaluation]=useState<EvalResult|null>(null);
  const [userId,setUserId]=useState('user-1');
  const [attrs,setAttrs]=useState('{"country":"US","plan":"beta"}');
  const [status,setStatus]=useState('Ready');
  useEffect(()=>{fetch('/api/flags').then(r=>r.json()).then(setFlags);fetch('/api/segments').then(r=>r.json()).then(setSegments)},[status.startsWith('Saved')]);
  useEffect(()=>{
    setStatus('Loading');setEvaluation(null);setAnalysis(null);
    if(selected.kind==='flag'){
      setSegment(null);
      fetch('/api/flags/'+selected.id).then(r=>r.json()).then((value:FlagRow)=>{setFlag(value);setDraft(value.content);setStatus('Loaded')});
    }else{
      setFlag(null);
      fetch('/api/segments/'+selected.id).then(r=>r.json()).then((value:SegmentRow)=>{setSegment(value);setDraft(JSON.stringify({name:value.name,match:value.match,rules:value.rules},null,2));setStatus('Loaded')});
    }
  },[selected.kind,selected.id]);
  async function save(){
    setStatus('Saving');
    if(flag){
      const response=await fetch('/api/flags/'+flag.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:flag.revision})});
      const value=await response.json();
      if(!response.ok){setStatus('Revision conflict');return}
      setFlag(value);setStatus('Saved');
    }else if(segment){
      let body:unknown;
      try{body=JSON.parse(draft)}catch{setStatus('Invalid JSON');return}
      const response=await fetch('/api/segments/'+segment.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...(body as object),revision:segment.revision})});
      const value=await response.json();
      if(!response.ok){setStatus(response.status===422?`Rejected: ${value.error}${value.cycle?' ('+value.cycle.join(' → ')+')':''}`:'Revision conflict');return}
      setSegment(value);setStatus(`Saved — invalidated: ${(value.invalidated as string[]).join(', ')||'none'}`);
    }
  }
  async function analyze(){if(!flag)return;setStatus('Analyzing');const response=await fetch('/api/flags/'+flag.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  async function evaluate(){
    if(!flag)return;
    setStatus('Evaluating');
    let attributes:unknown;
    try{attributes=JSON.parse(attrs)}catch{setStatus('Invalid attributes JSON');return}
    const response=await fetch('/api/flags/'+flag.id+'/evaluate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId,attributes})});
    setEvaluation(await response.json());setStatus('Ready');
  }
  const cacheTone=evaluation?{hit:'#176b55',miss:'#8a5a00',coalesced:'#4a4fb5'}[evaluation.cache.status]:'#666';
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Feature Evaluation Lab</strong><small>Local workspace</small></header><section className="workspace">
    <aside className="pane"><h2>Flags</h2><div className="list">{flags.map(item=><button className={selected.kind==='flag'&&item.id===selected.id?'active':''} onClick={()=>setSelected({kind:'flag',id:item.id})} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div><h2>Segments</h2><div className="list">{segments.map(item=><button className={selected.kind==='segment'&&item.id===selected.id?'active':''} onClick={()=>setSelected({kind:'segment',id:item.id})} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside>
    <section className="pane">
      <div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button>{flag&&<button onClick={analyze}><Play size={15}/>Analyze</button>}<span>{status}</span></div>
      <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/>
      {flag&&<div className="evaluate"><h2>Evaluate</h2><div className="toolbar"><input aria-label="User" value={userId} onChange={event=>setUserId(event.target.value)}/><button className="primary" onClick={evaluate}><Zap size={15}/>Evaluate</button></div><textarea aria-label="Attributes" className="attrs" value={attrs} onChange={event=>setAttrs(event.target.value)}/></div>}
    </section>
    <aside className="pane"><h2>Inspection</h2><span className="pill">{selected.id}</span>
      {evaluation&&<div className="cache-card"><h2>Cache</h2><p><span className="pill" style={{background:cacheTone,color:'#fff'}}>{evaluation.cache.status.toUpperCase()}</span></p><p>version <code>{evaluation.cache.version}</code></p><p>value <strong>{String(evaluation.value)}</strong></p></div>}
      <pre>{JSON.stringify(evaluation??analysis??flag??segment,null,2)}</pre>
    </aside>
  </section></main>;
}
