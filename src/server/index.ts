import express from 'express';
import {fileURLToPath} from 'node:url';
import type {Server as HttpServer} from 'node:http';
import {buildCacheKey, SegmentResultCache} from './cache';
import {evaluateSegment} from './engine';
import {Store} from './store';
import type {Segment, SegmentRule, Term, User} from './types';

const MAX_COMPUTE_DELAY_MS = 2000;

export interface CreateAppOptions {
  cacheCapacity?: number;
  computeDelayMs?: number;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  const store = new Store();
  const cache = new SegmentResultCache(options.cacheCapacity ?? 500);
  // 测试钩子：设置后首次计算会在此门控上等待，用于制造“计算跨越更新”窗口
  let computeGate: Promise<void> | null = null;

  // ---- 早期工作台遗留接口（flag 文本编辑），保持兼容 ----
  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'feature-eval', count: store.flags.size}),
  );
  app.get('/api/flags', (_req, res) =>
    res.json(
      [...store.flags.values()].map(({content: _content, ...row}) => ({
        ...row,
        closureIdentity: store.graph.identity.get(row.segmentId),
      })),
    ),
  );
  app.get('/api/flags/:id', (req, res) => {
    const flag = store.flags.get(req.params.id);
    if (!flag) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(flag.revision)).json(flag);
  });
  app.put('/api/flags/:id', (req, res) => {
    const flag = store.flags.get(req.params.id);
    if (!flag) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== flag.revision)
      return res.status(409).json({error: 'revision_conflict', current: flag});
    flag.content = String(req.body.content ?? '');
    flag.revision += 1;
    flag.updatedAt = new Date().toISOString();
    res.json(flag);
  });
  app.post('/api/flags/:id/analyze', async (req, res) => {
    const flag = store.flags.get(req.params.id);
    if (!flag) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, flag.id === 'alpha' ? 100 : 20));
    res.json({
      id: flag.id,
      revision: flag.revision,
      lines: String(req.body.content ?? flag.content).split(/\r?\n/).length,
      diagnostics: [],
    });
  });

  // ---- 分群依赖图 ----
  app.get('/api/segments', (_req, res) => {
    res.json([...store.segments.values()].map((segment) => serializeSegment(segment.id)));
  });

  function normalizeRule(body: unknown): SegmentRule | {error: string} {
    const candidate = (body ?? {}) as Partial<SegmentRule>;
    const terms: Term[] = [];
    for (const term of Array.isArray(candidate.terms) ? candidate.terms : []) {
      if (!term || typeof term.attr !== 'string' || typeof term.value !== 'string')
        return {error: 'invalid_terms'};
      terms.push({attr: term.attr, op: term.op === 'ne' ? 'ne' : 'eq', value: term.value});
    }
    const include = Array.isArray(candidate.include)
      ? [...new Set(candidate.include.filter((value): value is string => typeof value === 'string'))]
      : [];
    return {terms, include, match: candidate.match === 'any' ? 'any' : 'all'};
  }

  // 更新分群：编译期拒绝循环/悬空引用；只失效受影响后代的旧缓存条目
  app.put('/api/segments/:id', (req, res) => {
    const segment = store.segments.get(req.params.id);
    if (!segment) return res.status(404).json({error: 'not_found'});

    const rule = normalizeRule(req.body?.rule ?? req.body);
    if ('error' in rule) return res.status(400).json({error: rule.error});
    const expectedRevision = Number(req.body?.revision);
    if (!Number.isInteger(expectedRevision))
      return res.status(400).json({error: 'revision_required'});

    const outcome = store.updateSegment(segment.id, rule, expectedRevision);
    if (!outcome.ok) {
      if (outcome.error?.error === 'revision_conflict') {
        return res.status(409).json({error: 'revision_conflict', currentRevision: segment.revision});
      }
      return res.status(400).json({error: 'compile_rejected', detail: outcome.error});
    }

    // 只删除受影响闭包身份对应的条目；无关分群/用户的缓存原样保留
    const invalidatedKeys = cache.keysForIdentities(outcome.oldIdentities!);
    const invalidated = cache.invalidate(invalidatedKeys);

    res.json({
      segment: serializeSegment(segment.id),
      graphRevision: store.graphRevision,
      affected: [...outcome.affected!].sort(),
      invalidated,
    });
  });

  // ---- 用户 ----
  app.get('/api/users', (_req, res) => res.json([...store.users.values()]));
  app.put('/api/users/:id', (req, res) => {
    const user = store.users.get(req.params.id);
    if (!user) return res.status(404).json({error: 'not_found'});
    const expected = Number(req.body.attrsVersion);
    if (!Number.isInteger(expected)) return res.status(400).json({error: 'version_required'});
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.body.attrs ?? {})) {
      if (typeof value === 'string') attrs[key] = value;
    }
    if (!store.updateUserAttrs(user.id, attrs, expected)) {
      return res.status(409).json({error: 'version_conflict', currentVersion: user.attrsVersion});
    }
    // 属性变化只影响该用户；attrsVersion 已进入缓存键，旧条目精确删除
    const invalidated = cache.invalidate(cache.keysForUser(user.id));
    res.json({user, invalidated});
  });

  // ---- 命中评估（核心） ----
  async function evaluate(params: {
    segmentId?: string;
    flagId?: string;
    userId: string;
    signal: AbortSignal | undefined;
  }): Promise<{status: number; body: Record<string, unknown>}> {
    let segmentId = params.segmentId;
    if (params.flagId) {
      const flag = store.flags.get(params.flagId);
      if (!flag) return {status: 404, body: {error: 'not_found'}};
      segmentId = flag.segmentId;
    }
    const segment = segmentId ? store.segments.get(segmentId) : undefined;
    if (!segment) return {status: 404, body: {error: 'not_found'}};
    const user = store.users.get(params.userId);
    if (!user) return {status: 404, body: {error: 'user_not_found'}};

    // 任何 await 之前捕获本次计算针对的闭包快照
    const graphRevisionAtStart = store.graphRevision;
    const identity = store.graph.identity.get(segment.id)!;
    const closureIds = store.graph.closure.get(segment.id)!;
    const attrsVersion = user.attrsVersion;
    const key = buildCacheKey(user.id, identity, attrsVersion);
    // 快照闭包内分群，旧闭包计算不会读到新规则
    const snapshotById = new Map<string, Segment>();
    for (const id of closureIds) {
      const original = store.segments.get(id)!;
      snapshotById.set(id, {...original, rule: structuredClone(original.rule)});
    }
    const userSnapshot: User = {...user, attrs: {...user.attrs}};

    const lookup = await cache.getOrCompute(key, params.signal, async () => {
      if (options.computeDelayMs && options.computeDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, options.computeDelayMs));
      if (computeGate) {
        await computeGate;
        computeGate = null;
      }
      const value = evaluateSegment(segment.id, userSnapshot, snapshotById);
      // 发布守卫：计算期间图或用户属性换代，则旧闭包结果不得发布到新 revision
      const current =
        store.graphRevision === graphRevisionAtStart &&
        store.users.get(user.id)?.attrsVersion === attrsVersion;
      return {
        value,
        current,
        meta: {graphRevision: graphRevisionAtStart, identity, attrsVersion},
      };
    });

    return {
      status: 200,
      body: {
        userId: user.id,
        segmentId: segment.id,
        match: lookup.value,
        // compute=首次计算 cache=命中缓存 merged=并发合并 stale=跨越更新未发布
        source: lookup.source,
        // 前端展示命中的缓存版本（闭包内容身份）
        cacheVersion: lookup.meta.identity,
        meta: lookup.meta,
        closure: closureIds,
      },
    };
  }

  app.get('/api/evaluate', async (req, res) => {
    const userId = String(req.query.userId ?? '');
    const controller = new AbortController();
    // 调用方断连：只取消该请求的等待，不取消共享计算
    req.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const outcome = await evaluate({
        flagId: req.query.flagId ? String(req.query.flagId) : undefined,
        segmentId: req.query.segmentId ? String(req.query.segmentId) : undefined,
        userId,
        signal: controller.signal,
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      // 客户端已断连时不要再写响应
      if (res.writableEnded || req.socket.destroyed) return;
      if ((error as Error).name === 'AbortError') {
        res.status(499).json({error: 'aborted'});
      } else {
        res.status(500).json({error: 'evaluation_failed'});
      }
    }
  });

  app.get('/api/cache', (_req, res) => {
    res.json({
      stats: cache.stats(),
      entries: cache.list().map(({key, meta}) => ({key, ...meta})),
    });
  });

  function serializeSegment(id: string) {
    const segment = store.segments.get(id)!;
    return {
      ...segment,
      closure: store.graph.closure.get(id),
      identity: store.graph.identity.get(id),
    };
  }

  return {
    app,
    store,
    cache,
    evaluateDirect: evaluate,
    // 测试辅助：让下一次首次计算停在门控上
    setComputeGate(gate: Promise<void> | null) {
      computeGate = gate;
    },
    listen: (port = 4174): HttpServer =>
      app.listen(port, '127.0.0.1', () => console.log(`server http://127.0.0.1:${port}`)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174);
}
