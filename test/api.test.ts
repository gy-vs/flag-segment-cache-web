import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {compile} from '../src/server/graph';
import type {SegmentRule} from '../src/server/types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(cacheCapacity = 500) {
  const created = createApp({cacheCapacity});
  const {app, store} = created;

  async function evalQuery(query: string) {
    const response = await request(app).get('/api/evaluate?' + query).expect(200);
    return response.body;
  }

  function ruleOf(id: string): SegmentRule {
    return JSON.parse(JSON.stringify(store.segments.get(id)!.rule)) as SegmentRule;
  }

  async function updateSegment(id: string, patch: Partial<SegmentRule>, revisionOverride?: number) {
    const current = store.segments.get(id)!;
    const rule: SegmentRule = {
      terms: patch.terms ?? ruleOf(id).terms,
      include: patch.include ?? ruleOf(id).include,
      match: patch.match ?? ruleOf(id).match,
    };
    return request(app)
      .put('/api/segments/' + id)
      .send({revision: revisionOverride ?? current.revision, rule});
  }

  return {...created, evalQuery, updateSegment, ruleOf};
}

describe('缓存键覆盖依赖闭包 revision', () => {
  it('直接上游 revision 变化后返回新结果与新缓存版本，旧条目不残留', async () => {
    const h = harness();
    // u2: plan=free → canary 因 seg-plan 不命中
    const before = await h.evalQuery('segmentId=seg-canary&userId=u2');
    expect(before.match).toBe(false);
    expect(before.source).toBe('compute');

    const cached = await h.evalQuery('segmentId=seg-canary&userId=u2');
    expect(cached.source).toBe('cache');
    expect(cached.cacheVersion).toBe(before.cacheVersion);

    // 更新直接依赖 seg-plan：pro 之外也命中
    const response = await h.updateSegment('seg-plan', {
      terms: [{attr: 'plan', op: 'ne', value: 'none'}],
    });
    expect(response.status).toBe(200);
    expect(response.body.affected).toEqual(
      expect.arrayContaining(['seg-plan', 'seg-canary', 'seg-excluded']),
    );

    const after = await h.evalQuery('segmentId=seg-canary&userId=u2');
    expect(after.match).toBe(true);
    expect(after.cacheVersion).not.toBe(before.cacheVersion);
    expect(after.source).toBe('compute');

    // 旧闭包身份的缓存条目已被精确失效
    const cache = await request(h.app).get('/api/cache').expect(200);
    expect(cache.body.entries.map((e: {identity: string}) => e.identity)).not.toContain(
      before.cacheVersion,
    );
  });

  it('间接（嵌套）上游更新后，引用它的 flag 拿到新结果', async () => {
    const h = harness();
    // seg-excluded include seg-canary；u3 region=us，canary 不命中 → excluded 自身无条件，仍不命中
    const before = await h.evalQuery('flagId=alpha&userId=u3');
    expect(before.match).toBe(false);

    // 更新 seg-region（alpha→seg-canary→seg-region 的间接依赖）
    const response = await h.updateSegment('seg-region', {
      terms: [{attr: 'region', op: 'ne', value: 'aq'}],
    });
    expect(response.status).toBe(200);
    // seg-region 的受影响后代包含两级之外的 seg-excluded，且不含 seg-standalone
    expect(response.body.affected.sort()).toEqual(
      ['seg-canary', 'seg-excluded', 'seg-region'].sort(),
    );

    const after = await h.evalQuery('flagId=alpha&userId=u3');
    // u3: region 现在 ne aq 命中，plan=pro 命中，但 beta=false → canary 仍不命中
    expect(after.match).toBe(false);
    expect(after.cacheVersion).not.toBe(before.cacheVersion);

    // 再放开 beta 条件验证整条间接链确实重新计算
    await h.updateSegment('seg-canary', {terms: [{attr: 'beta', op: 'ne', value: 'never'}]});
    const finalResult = await h.evalQuery('flagId=alpha&userId=u3');
    expect(finalResult.match).toBe(true);
  });

  it('无关分群更新不清空其他缓存，只失效受影响后代', async () => {
    const h = harness();
    await h.evalQuery('segmentId=seg-canary&userId=u1');
    await h.evalQuery('segmentId=seg-standalone&userId=u2');
    const canaryVersion = h.store.graph.identity.get('seg-canary')!;
    const standaloneVersion = h.store.graph.identity.get('seg-standalone')!;

    // 更新与 canary 闭包完全无关的 seg-standalone
    const response = await h.updateSegment('seg-standalone', {
      terms: [{attr: 'tier', op: 'eq', value: 'platinum'}],
    });
    expect(response.status).toBe(200);
    expect(response.body.invalidated).toBeGreaterThanOrEqual(1);

    // canary 缓存原样保留：仍命中且版本不变
    const canaryAgain = await h.evalQuery('segmentId=seg-canary&userId=u1');
    expect(canaryAgain.source).toBe('cache');
    expect(canaryAgain.cacheVersion).toBe(canaryVersion);

    // standalone 版本换代、旧结果失效
    expect(h.store.graph.identity.get('seg-standalone')).not.toBe(standaloneVersion);
    const standaloneAgain = await h.evalQuery('segmentId=seg-standalone&userId=u2');
    expect(standaloneAgain.source).toBe('compute');
  });
});

describe('编译期拒绝循环与悬空引用', () => {
  it('嵌套分群形成环时拒绝写入，旧图与缓存继续可用', async () => {
    const h = harness();
    const before = await h.evalQuery('segmentId=seg-canary&userId=u1');

    // 让 seg-plan 反向包含 seg-canary，形成 plan→canary→plan 环
    const response = await h.updateSegment('seg-plan', {
      include: ['seg-canary'],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('compile_rejected');
    expect(response.body.detail.error).toBe('cycle');
    expect(response.body.detail.cycle).toContain('seg-plan');
    expect(response.body.detail.cycle).toContain('seg-canary');

    // 规则、revision、缓存全部保持更新前状态
    expect(h.store.segments.get('seg-plan')!.rule.include).toEqual([]);
    const after = await h.evalQuery('segmentId=seg-canary&userId=u1');
    expect(after.source).toBe('cache');
    expect(after.cacheVersion).toBe(before.cacheVersion);
  });

  it('引用不存在的上游分群被拒绝', () => {
    const result = compile(
      [
        {id: 'a', revision: 1, rule: {terms: [], include: ['ghost'], match: 'all'}},
      ],
      1,
    );
    expect(result).toEqual({
      error: 'missing_dependency',
      segmentId: 'a',
      dependency: 'ghost',
    });
  });

  it('revision 乐观锁冲突返回 409', async () => {
    const h = harness();
    const response = await h.updateSegment('seg-plan', {terms: []}, 999);
    expect(response.status).toBe(409);
  });
});

describe('用户属性变化与负结果缓存', () => {
  it('属性修改后 attrsVersion 进入缓存键，结果重算；其他用户不受影响', async () => {
    const h = harness();
    const u1Before = await h.evalQuery('segmentId=seg-plan&userId=u1');
    expect(u1Before.match).toBe(true);
    const u2Cached = await h.evalQuery('segmentId=seg-plan&userId=u2');
    expect(u2Cached.match).toBe(false);

    const user = h.store.users.get('u1')!;
    const response = await request(h.app)
      .put('/api/users/u1')
      .send({attrsVersion: user.attrsVersion, attrs: {...user.attrs, plan: 'free'}});
    expect(response.status).toBe(200);
    // 只失效 u1 自己的条目（plan 闭包 + 其他闭包），u2 不动
    expect(response.body.invalidated).toBeGreaterThanOrEqual(1);

    const u1After = await h.evalQuery('segmentId=seg-plan&userId=u1');
    expect(u1After.match).toBe(false);
    expect(u1After.meta.attrsVersion).toBe(u1Before.meta.attrsVersion + 1);

    const u2After = await h.evalQuery('segmentId=seg-plan&userId=u2');
    expect(u2After.source).toBe('cache');
  });

  it('负结果同样被缓存并在依赖更新后失效', async () => {
    const h = harness();
    // u2 在 seg-canary 上为 false
    const first = await h.evalQuery('segmentId=seg-canary&userId=u2');
    expect(first.match).toBe(false);
    expect(first.source).toBe('compute');
    const second = await h.evalQuery('segmentId=seg-canary&userId=u2');
    expect(second.source).toBe('cache');
    expect(second.match).toBe(false);

    await h.updateSegment('seg-plan', {terms: [{attr: 'plan', op: 'ne', value: 'x'}]});
    await h.updateSegment('seg-region', {terms: [{attr: 'region', op: 'ne', value: 'x'}]});
    await h.updateSegment('seg-canary', {terms: [{attr: 'beta', op: 'ne', value: 'x'}]});

    const recomputed = await h.evalQuery('segmentId=seg-canary&userId=u2');
    expect(recomputed.source).toBe('compute');
    expect(recomputed.match).toBe(true);
  });
});

describe('并发首次计算合并', () => {
  it('同键并发请求只计算一次，调用方取消不影响其他等待者', async () => {
    const h = harness();
    let gate: () => void = () => {};
    h.setComputeGate(new Promise<void>((resolve) => (gate = resolve)));

    const params = (signal: AbortSignal | undefined) =>
      ({segmentId: 'seg-canary', userId: 'u1', signal} as const);

    // p0 触发首次计算（停在门控上），不取消
    const p0 = h.evaluateDirect(params(undefined));
    // pc 合并到同一次计算，随后被自己的调用方取消
    const cancelController = new AbortController();
    const pc = h.evaluateDirect(params(cancelController.signal));
    // p1 合并等待
    const p1 = h.evaluateDirect(params(undefined));
    await delay(30);

    cancelController.abort();
    await expect(pc).rejects.toMatchObject({name: 'AbortError'});

    // 放行共享计算：发起者与其他等待者都拿到结果，取消者不影响它们
    gate();
    const r0 = await p0;
    const r1 = await p1;
    expect(r0.status).toBe(200);
    expect(r1.status).toBe(200);
    expect(r0.body.match).toBe(true);
    expect(r1.body.match).toBe(true);
    expect([r0.body.source, r1.body.source].sort()).toEqual(['compute', 'merged']);

    // 共享计算结果照常发布：后续请求命中缓存
    const later = await h.evalQuery('segmentId=seg-canary&userId=u1');
    expect(later.source).toBe('cache');
    expect(h.cache.stats().misses).toBe(1);
  });
});

describe('旧闭包结果不能发布到新 revision', () => {
  it('计算跨越分群更新时等待者拿到 stale 结果，缓存不写入，随后重算新 revision', async () => {
    const h = harness();
    let gate: () => void = () => {};
    h.setComputeGate(new Promise<void>((resolve) => (gate = resolve)));

    const inFlight = h
      .evaluateDirect({segmentId: 'seg-canary', userId: 'u2', signal: undefined})
      .then((outcome) => outcome.body as {match: boolean; source: string; cacheVersion: string} | null)
      .catch(() => null);
    await delay(30);

    // 计算进行中更新直接依赖
    const update = await h.updateSegment('seg-plan', {
      terms: [{attr: 'plan', op: 'ne', value: 'zz'}],
    });
    expect(update.status).toBe(200);

    gate();
    const staleBody = await inFlight;
    expect(staleBody).not.toBeNull();
    // 旧闭包下 u2 plan=free 不命中
    expect(staleBody!.match).toBe(false);
    expect(staleBody!.source).toBe('stale');

    // 旧结果没有发布到缓存：下一次请求重新按新闭包计算
    const next = await h.evalQuery('segmentId=seg-canary&userId=u2');
    expect(next.source).toBe('compute');
    expect(next.match).toBe(true);
    expect(next.cacheVersion).not.toBe(staleBody!.cacheVersion);
  });
});

describe('缓存淘汰', () => {
  it('容量超限时按 LRU 淘汰，命中会续期', async () => {
    const h = harness(2);
    // 3 个不同用户 × 同一分群 → 3 个键，容量 2
    await h.evalQuery('segmentId=seg-standalone&userId=u1');
    await h.evalQuery('segmentId=seg-standalone&userId=u2');
    // 访问最旧的 u1，为其续期
    await h.evalQuery('segmentId=seg-standalone&userId=u1');
    await h.evalQuery('segmentId=seg-standalone&userId=u3');

    const stats = h.cache.stats();
    expect(stats.size).toBe(2);
    expect(stats.evictions).toBe(1);

    const cache = await request(h.app).get('/api/cache').expect(200);
    const keys = cache.body.entries.map((e: {key: string}) => e.key);
    expect(keys.some((k: string) => k.startsWith('u1:'))).toBe(true);
    expect(keys.some((k: string) => k.startsWith('u3:'))).toBe(true);
    expect(keys.some((k: string) => k.startsWith('u2:'))).toBe(false);
  });
});
