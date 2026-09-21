// 领域模型：分群规则、特性开关（flag）与用户档案
export type Operator = 'eq' | 'ne';

export interface Term {
  attr: string;
  op: Operator;
  value: string;
}

// match 决定自身条件与 include 的上游分群如何组合：
// all = 全部命中（AND），any = 任一命中（OR）
export interface SegmentRule {
  terms: Term[];
  include: string[];
  match: 'all' | 'any';
}

export interface Segment {
  id: string;
  name: string;
  revision: number;
  rule: SegmentRule;
  updatedAt: string;
}

export interface Flag {
  id: string;
  name: string;
  revision: number;
  // 早期工作台遗留的规则文本，与命中判定无关
  content: string;
  segmentId: string;
  updatedAt: string;
}

export interface User {
  id: string;
  name: string;
  // 用户属性内容版本：属性每次被接受的修改都会 +1，进入缓存键
  attrsVersion: number;
  attrs: Record<string, string>;
  updatedAt: string;
}
