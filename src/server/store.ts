import {affectedDescendants, compile, CompileError, CompiledGraph, toPrototypes} from './graph';
import type {Flag, Segment, SegmentRule, User} from './types';

interface UpdateOutcome {
  ok: boolean;
  error?: CompileError | {error: 'revision_conflict'; current: number};
  graph: CompiledGraph;
  affected?: Set<string>;
  // 受影响分群在更新前（旧图）的闭包身份，用于精确失效旧缓存
  oldIdentities?: Set<string>;
}

export class Store {
  readonly segments = new Map<string, Segment>();
  readonly flags = new Map<string, Flag>();
  readonly users = new Map<string, User>();
  graph: CompiledGraph;
  // 图的内容版本：任何一次成功的分群写入都会递增
  graphRevision = 1;

  constructor() {
    const seedSegments: Segment[] = [
      {
        id: 'seg-plan',
        name: 'Plan check',
        revision: 1,
        rule: {terms: [{attr: 'plan', op: 'eq', value: 'pro'}], include: [], match: 'all'},
        updatedAt: new Date(0).toISOString(),
      },
      {
        id: 'seg-region',
        name: 'Region check',
        revision: 1,
        rule: {terms: [{attr: 'region', op: 'eq', value: 'cn'}], include: [], match: 'all'},
        updatedAt: new Date(0).toISOString(),
      },
      // 嵌套分群：同时依赖 seg-plan 与 seg-region
      {
        id: 'seg-canary',
        name: 'Canary cohort',
        revision: 2,
        rule: {terms: [{attr: 'beta', op: 'eq', value: 'true'}], include: ['seg-plan', 'seg-region'], match: 'all'},
        updatedAt: new Date(0).toISOString(),
      },
      // 负结果缓存用：明确排除 canary
      {
        id: 'seg-excluded',
        name: 'Excluded cohort',
        revision: 1,
        rule: {terms: [], include: ['seg-canary'], match: 'all'},
        updatedAt: new Date(0).toISOString(),
      },
      {
        id: 'seg-standalone',
        name: 'Standalone cohort',
        revision: 1,
        rule: {terms: [{attr: 'tier', op: 'eq', value: 'gold'}], include: [], match: 'all'},
        updatedAt: new Date(0).toISOString(),
      },
    ];
    for (const segment of seedSegments) this.segments.set(segment.id, segment);

    const seedFlags: Flag[] = [
      {id: 'alpha', name: 'Primary evaluation rules', revision: 3, content: 'evaluation rules: alpha\nstate: active', segmentId: 'seg-canary', updatedAt: new Date(0).toISOString()},
      {id: 'beta', name: 'Secondary evaluation rules', revision: 5, content: 'evaluation rules: beta\nstate: review', segmentId: 'seg-standalone', updatedAt: new Date(1000).toISOString()},
    ];
    for (const flag of seedFlags) this.flags.set(flag.id, flag);

    const seedUsers: User[] = [
      {id: 'u1', name: 'Ada', attrsVersion: 1, attrs: {plan: 'pro', region: 'cn', beta: 'true', tier: 'silver'}, updatedAt: new Date(0).toISOString()},
      {id: 'u2', name: 'Bo', attrsVersion: 1, attrs: {plan: 'free', region: 'cn', beta: 'true', tier: 'gold'}, updatedAt: new Date(0).toISOString()},
      {id: 'u3', name: 'Cy', attrsVersion: 1, attrs: {plan: 'pro', region: 'us', beta: 'false', tier: 'gold'}, updatedAt: new Date(0).toISOString()},
    ];
    for (const user of seedUsers) this.users.set(user.id, user);

    const compiled = compile(toPrototypes([...this.segments.values()]), this.graphRevision);
    if ('error' in compiled) throw new Error(`seed graph failed: ${JSON.stringify(compiled)}`);
    this.graph = compiled;
  }

  /**
   * 写入新分群规则：先在草稿（现有数据 + 新规则）上编译，
   * 循环/悬空引用直接拒绝，旧图与缓存继续有效。
   * 返回的 affected 是按旧图计算的受影响后代，调用方据此精确失效缓存。
   */
  updateSegment(id: string, rule: SegmentRule, expectedRevision: number): UpdateOutcome {
    const current = this.segments.get(id);
    if (!current) return {ok: false, error: {error: 'missing_dependency', segmentId: id}, graph: this.graph};
    if (expectedRevision !== current.revision) {
      return {
        ok: false,
        error: {error: 'revision_conflict', current: current.revision},
        graph: this.graph,
      };
    }

    // 失效范围与旧身份都在替换图之前捕获
    const oldGraph = this.graph;
    const affected = affectedDescendants(oldGraph, id);
    const oldIdentities = new Set<string>();
    for (const descendant of affected) {
      const identity = oldGraph.identity.get(descendant);
      if (identity) oldIdentities.add(identity);
    }

    const draft: Segment[] = [...this.segments.values()].map((segment) =>
      segment.id === id ? {...segment, rule, revision: current.revision + 1} : segment,
    );
    const candidate = compile(toPrototypes(draft), this.graphRevision + 1);
    if ('error' in candidate) return {ok: false, error: candidate, graph: this.graph};

    current.rule = rule;
    current.revision += 1;
    current.updatedAt = new Date().toISOString();
    this.graphRevision += 1;
    this.graph = candidate;
    return {ok: true, graph: candidate, affected, oldIdentities};
  }

  updateUserAttrs(id: string, attrs: Record<string, string>, expectedVersion: number): boolean {
    const user = this.users.get(id);
    if (!user || expectedVersion !== user.attrsVersion) return false;
    user.attrs = attrs;
    user.attrsVersion += 1;
    user.updatedAt = new Date().toISOString();
    return true;
  }
}
