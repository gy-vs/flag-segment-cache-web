import {useEffect, useState} from 'react';
import {FlaskConical, Play, Save, Users, Workflow} from 'lucide-react';

type Term = {attr: string; op: 'eq' | 'ne'; value: string};
type SegmentRule = {terms: Term[]; include: string[]; match: 'all' | 'any'};
type Segment = {
  id: string;
  name: string;
  revision: number;
  rule: SegmentRule;
  closure: string[];
  identity: string;
};
type User = {
  id: string;
  name: string;
  attrsVersion: number;
  attrs: Record<string, string>;
};
type Evaluation = {
  userId: string;
  segmentId: string;
  match: boolean;
  source: 'compute' | 'cache' | 'merged' | 'stale';
  cacheVersion: string;
  meta: {graphRevision: number; identity: string; attrsVersion: number; cachedAt: number};
  closure: string[];
};
type CacheSnapshot = {
  stats: {size: number; hits: number; misses: number; merged: number; evictions: number};
  entries: Array<{key: string; graphRevision: number; identity: string; attrsVersion: number}>;
};

const sourceLabel: Record<Evaluation['source'], {text: string; tone: string}> = {
  compute: {text: '首次计算', tone: 'compute'},
  cache: {text: '缓存命中', tone: 'cache'},
  merged: {text: '并发合并', tone: 'merged'},
  stale: {text: '旧闭包结果·未缓存', tone: 'stale'},
};

export default function App() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [cacheSnapshot, setCacheSnapshot] = useState<CacheSnapshot | null>(null);
  const [selected, setSelected] = useState('seg-canary');
  const [userId, setUserId] = useState('u1');
  const [ruleText, setRuleText] = useState('');
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [status, setStatus] = useState('就绪');

  async function refresh() {
    const [segmentRows, userRows, cacheRow] = await Promise.all([
      fetch('/api/segments').then((r) => r.json()),
      fetch('/api/users').then((r) => r.json()),
      fetch('/api/cache').then((r) => r.json()),
    ]);
    setSegments(segmentRows);
    setUsers(userRows);
    setCacheSnapshot(cacheRow);
    return segmentRows as Segment[];
  }

  useEffect(() => {
    refresh().then((rows) => {
      setRuleText(JSON.stringify(rows.find((row) => row.id === selected)?.rule ?? {}, null, 2));
    });
  }, []);

  useEffect(() => {
    const current = segments.find((segment) => segment.id === selected);
    if (current) setRuleText(JSON.stringify(current.rule, null, 2));
    setEvaluation(null);
  }, [selected, segments]);

  async function evaluate() {
    setStatus('评估中');
    const response = await fetch(
      `/api/evaluate?segmentId=${encodeURIComponent(selected)}&userId=${encodeURIComponent(userId)}`,
    );
    setEvaluation(await response.json());
    setStatus('完成');
    refresh();
  }

  async function save() {
    let rule: SegmentRule;
    try {
      rule = JSON.parse(ruleText) as SegmentRule;
    } catch {
      setStatus('规则 JSON 解析失败');
      return;
    }
    const current = segments.find((segment) => segment.id === selected);
    if (!current) return;
    setStatus('保存中');
    const response = await fetch(`/api/segments/${current.id}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: current.revision, rule}),
    });
    const body = await response.json();
    if (!response.ok) {
      setStatus(
        response.status === 400
          ? `编译拒绝：${body.detail?.error}${body.detail?.cycle ? ' ' + body.detail.cycle.join(' → ') : ''}`
          : `保存失败 (${response.status})`,
      );
      return;
    }
    setStatus(`已保存 rev ${body.segment.revision}，失效 ${body.invalidated} 条受影响缓存`);
    refresh();
  }

  const current = segments.find((segment) => segment.id === selected);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>特性规则工作台 · 分群依赖缓存</strong>
        <small>缓存版本 = 依赖闭包内容身份</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>
            <Workflow size={15} /> 共享分群
          </h2>
          <div className="list">
            {segments.map((segment) => (
              <button
                className={segment.id === selected ? 'active' : ''}
                onClick={() => setSelected(segment.id)}
                key={segment.id}
              >
                {segment.name} <code>{segment.id}</code>
                <br />
                <small>
                  rev {segment.revision} · 闭包 {segment.closure.length} ·{' '}
                  <code title="依赖闭包内容身份">{segment.identity}</code>
                </small>
              </button>
            ))}
          </div>
          <h2 className="mt">
            <Users size={15} /> 用户
          </h2>
          <div className="list">
            {users.map((user) => (
              <button
                className={user.id === userId ? 'active subtle' : 'subtle'}
                onClick={() => setUserId(user.id)}
                key={user.id}
              >
                {user.name} <code>{user.id}</code>
                <br />
                <small>attrs v{user.attrsVersion}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save}>
              <Save size={15} />
              保存规则
            </button>
            <button onClick={evaluate}>
              <Play size={15} />
              评估命中
            </button>
            <span>{status}</span>
          </div>
          {current && (
            <div className="meta-line">
              当前闭包：{current.closure.join(' → ')} · 内容身份 <code>{current.identity}</code>
            </div>
          )}
          <textarea
            aria-label="Segment rule"
            value={ruleText}
            onChange={(event) => setRuleText(event.target.value)}
          />
        </section>

        <aside className="pane">
          <h2>检查面板</h2>
          {evaluation && (
            <div className="result-card">
              <span className={`pill ${sourceLabel[evaluation.source].tone}`}>
                {sourceLabel[evaluation.source].text}
              </span>
              <div className={evaluation.match ? 'match-yes' : 'match-no'}>
                {evaluation.match ? '命中' : '未命中'}
              </div>
              <dl>
                <dt>命中的缓存版本</dt>
                <dd>
                  <code>{evaluation.cacheVersion}</code>
                </dd>
                <dt>图 revision</dt>
                <dd>{evaluation.meta.graphRevision}</dd>
                <dt>用户属性版本</dt>
                <dd>{evaluation.meta.attrsVersion}</dd>
                <dt>依赖闭包</dt>
                <dd>{evaluation.closure.join(', ')}</dd>
              </dl>
            </div>
          )}
          <h2 className="mt">缓存条目</h2>
          {cacheSnapshot && (
            <>
              <div className="cache-stats">
                条目 {cacheSnapshot.stats.size} · 命中 {cacheSnapshot.stats.hits} · 未命中{' '}
                {cacheSnapshot.stats.misses} · 合并 {cacheSnapshot.stats.merged} · 淘汰{' '}
                {cacheSnapshot.stats.evictions}
              </div>
              <div className="cache-list">
                {cacheSnapshot.entries.length === 0 && <small>（空）</small>}
                {cacheSnapshot.entries.map((entry) => (
                  <div
                    className={`cache-row ${entry.identity === evaluation?.cacheVersion ? 'lit' : ''}`}
                    key={entry.key}
                    title={entry.key}
                  >
                    <code>{entry.key}</code>
                    <small>
                      g{entry.graphRevision} · attrs v{entry.attrsVersion}
                    </small>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
