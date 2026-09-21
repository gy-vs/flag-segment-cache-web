import type {Segment, SegmentRule} from './types';
import {fnv1a} from './hash';

export interface CompileError {
  error: 'cycle' | 'missing_dependency';
  segmentId: string;
  dependency?: string;
  cycle?: string[];
}

export interface CompiledGraph {
  // 每个分群沿依赖边可达的全部分群（含自身），按 id 排序
  closure: Map<string, string[]>;
  // 闭包内容身份：闭包内每个分群的 id@revision 排序后的哈希
  identity: Map<string, string>;
  // 反向依赖：分群 -> 直接包含它的分群
  dependents: Map<string, Set<string>>;
  revision: number;
}

interface Prototype {
  id: string;
  rule: SegmentRule;
  revision: number;
}

/**
 * 编译分群依赖图：
 * - 缺失上游分群 → 拒绝（missing_dependency）
 * - 嵌套分群形成环 → 拒绝（cycle，返回环上的 id）
 * 编译失败时调用方必须保留旧图，不能部分生效。
 */
export function compile(segments: Prototype[], graphRevision: number): CompiledGraph | CompileError {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const closure = new Map<string, string[]>();
  const identity = new Map<string, string>();

  // 三色 DFS：0=未访问 1=在当前栈上 2=完成
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): true | CompileError => {
    const state = color.get(id) ?? 0;
    if (state === 2) return true;
    if (state === 1) {
      const start = stack.indexOf(id);
      return {error: 'cycle', segmentId: id, cycle: stack.slice(start).concat(id)};
    }
    const segment = byId.get(id);
    if (!segment) return {error: 'missing_dependency', segmentId: id};

    color.set(id, 1);
    stack.push(id);
    const reach = new Set<string>([id]);
    for (const dep of segment.rule.include) {
      if (!byId.has(dep)) return {error: 'missing_dependency', segmentId: id, dependency: dep};
      const outcome = visit(dep);
      if (outcome !== true) return outcome;
      for (const reachable of closure.get(dep)!) reach.add(reachable);
    }
    stack.pop();
    color.set(id, 2);

    const ordered = [...reach].sort();
    closure.set(id, ordered);
    identity.set(
      id,
      fnv1a(ordered.map((part) => `${part}@${byId.get(part)!.revision}`).join('|')),
    );
    return true;
  };

  // 按 id 排序访问，保证编译结果与输入顺序无关
  for (const id of [...byId.keys()].sort()) {
    const outcome = visit(id);
    if (outcome !== true) return outcome;
  }

  const dependents = new Map<string, Set<string>>();
  for (const segment of segments) {
    for (const dep of segment.rule.include) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep)!.add(segment.id);
    }
  }

  return {closure, identity, dependents, revision: graphRevision};
}

/** 受 updatedId 更新影响的全部分群（传递反向依赖），含 updatedId 自身。 */
export function affectedDescendants(graph: CompiledGraph, updatedId: string): Set<string> {
  const affected = new Set<string>([updatedId]);
  const queue = [updatedId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const dependent of graph.dependents.get(id) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return affected;
}

export function toPrototypes(segments: Segment[]): Prototype[] {
  return segments.map(({id, rule, revision}) => ({id, rule, revision}));
}
