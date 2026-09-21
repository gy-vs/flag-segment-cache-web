// 分群命中结果缓存
// 键覆盖整个依赖闭包的内容身份（id@revision 集合哈希）+ 用户 attrsVersion，
// 因此上游嵌套分群 revision 变化、用户属性变化都会自然得到新键；
// 失效只需要按倒排索引删除受影响闭包对应的条目，不清空整张缓存。

export interface CacheMeta {
  graphRevision: number;
  // 本次结果所针对的闭包内容身份
  identity: string;
  attrsVersion: number;
  cachedAt: number;
}

export interface ComputeResult {
  value: boolean;
  meta: Omit<CacheMeta, 'cachedAt'>;
  // 发布守卫：计算跨越了一次图更新时返回 false，
  // 旧闭包结果只交付给已在等待的请求，绝不写入新 revision 的缓存
  current: boolean;
}

export type CacheSource = 'compute' | 'cache' | 'merged' | 'stale';

export interface CacheLookup {
  value: boolean;
  source: CacheSource;
  meta: CacheMeta;
}

interface Entry {
  value: boolean;
  meta: CacheMeta;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  merged: number;
  evictions: number;
}

export class SegmentResultCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<ComputeResult>>();
  private hits = 0;
  private misses = 0;
  private mergedCount = 0;
  private evictions = 0;

  constructor(private readonly capacity = 500) {}

  /**
   * 单飞读取：同键并发首次计算只执行一次 producer，其余请求合并等待。
   * 每个调用方传入自己的 signal；某个调用方取消只会让它自己的等待 reject，
   * 不会取消共享计算，也不会影响其他等待者。
   */
  getOrCompute(
    key: string,
    signal: AbortSignal | undefined,
    producer: () => Promise<ComputeResult>,
  ): Promise<CacheLookup> {
    const settled = this.entries.get(key);
    if (settled) {
      // LRU 续期
      this.entries.delete(key);
      this.entries.set(key, settled);
      this.hits += 1;
      return Promise.resolve({value: settled.value, source: 'cache', meta: settled.meta});
    }

    const existing = this.inflight.get(key);
    if (existing) {
      this.hits += 1;
      this.mergedCount += 1;
      return this.attachCancellation(existing.then(toLookup('merged')), signal);
    }

    this.misses += 1;
    const shared = Promise.resolve()
      .then(producer)
      .then(
        (result) => {
          this.inflight.delete(key);
          // 新鲜度守卫：计算期间闭包身份已经换代则不得发布
          if (result.current) {
            this.entries.set(key, {
              value: result.value,
              meta: {...result.meta, cachedAt: Date.now()},
            });
            this.evictIfNeeded();
          }
          return result;
        },
        (error) => {
          this.inflight.delete(key);
          throw error;
        },
      );
    this.inflight.set(key, shared);

    return this.attachCancellation(shared.then(toLookup('compute')), signal);
  }

  /** 精确失效：只删除给定键。 */
  invalidate(keys: Iterable<string>): number {
    let removed = 0;
    for (const key of keys) {
      if (this.entries.delete(key)) removed += 1;
    }
    return removed;
  }

  /** 受影响闭包身份对应的全部缓存键（可能跨多个用户）。 */
  keysForIdentities(identities: Set<string>): string[] {
    const matched: string[] = [];
    for (const key of this.entries.keys()) {
      const parts = key.split(':');
      const identity = parts.slice(1, -1).join(':');
      if (identities.has(identity)) matched.push(key);
    }
    return matched;
  }

  /** 某用户的全部缓存键：用户属性变化时只失效该用户，其他人不受影响。 */
  keysForUser(userId: string): string[] {
    const prefix = `${userId}:`;
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix));
  }

  peekMeta(key: string): CacheMeta | undefined {
    return this.entries.get(key)?.meta;
  }

  list(): Array<{key: string; meta: CacheMeta}> {
    return [...this.entries.entries()].map(([key, entry]) => ({key, meta: entry.meta}));
  }

  stats(): CacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      merged: this.mergedCount,
      evictions: this.evictions,
    };
  }

  private attachCancellation(deliver: Promise<CacheLookup>, signal: AbortSignal | undefined) {
    if (!signal) return deliver;
    if (signal.aborted) return Promise.reject(createAbortError());
    return new Promise<CacheLookup>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(createAbortError());
      };
      signal.addEventListener('abort', onAbort);
      deliver.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private evictIfNeeded() {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }
}

function toLookup(freshSource: 'compute' | 'merged') {
  return (result: ComputeResult): CacheLookup => ({
    value: result.value,
    // 过期计算对发起者标记 stale，对等待者同样标记；结果不会进缓存
    source: result.current ? freshSource : 'stale',
    meta: {...result.meta, cachedAt: result.current ? Date.now() : 0},
  });
}

export function createAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

// 键结构：userId:closureIdentity:attrsVersion
export function buildCacheKey(userId: string, identity: string, attrsVersion: number): string {
  return `${userId}:${identity}:${attrsVersion}`;
}
