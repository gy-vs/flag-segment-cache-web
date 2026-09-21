import type {Segment, SegmentRule, User} from './types';

function evalTerm(user: User, term: {attr: string; op: 'eq' | 'ne'; value: string}): boolean {
  const actual = user.attrs[term.attr];
  return term.op === 'eq' ? actual === term.value : actual !== term.value;
}

function ownTermsMatch(rule: SegmentRule, user: User): boolean {
  if (rule.terms.length === 0) return true;
  if (rule.match === 'all') return rule.terms.every((term) => evalTerm(user, term));
  return rule.terms.some((term) => evalTerm(user, term));
}

/**
 * 计算单个用户在某个分群上的命中结果（含上游嵌套分群）。
 * 调用方保证 graph 已编译且无环；命中结果会被闭包内容身份缓存。
 */
export function evaluateSegment(
  rootId: string,
  user: User,
  byId: Map<string, Segment>,
  memo: Map<string, boolean> = new Map(),
): boolean {
  const hit = memo.get(rootId);
  if (hit !== undefined) return hit;

  const segment = byId.get(rootId);
  if (!segment) throw new Error(`unknown segment: ${rootId}`);

  const own = ownTermsMatch(segment.rule, user);
  let result: boolean;
  if (segment.rule.include.length === 0) {
    result = own;
  } else if (segment.rule.match === 'all') {
    result = own && segment.rule.include.every((dep) => evaluateSegment(dep, user, byId, memo));
  } else {
    result = own || segment.rule.include.some((dep) => evaluateSegment(dep, user, byId, memo));
  }
  memo.set(rootId, result);
  return result;
}
