# Feature Evaluation Lab

Local workbench for evaluation rules.

Run `npm install`, then `npm run dev`.

## Evaluation cache

Flags reference segments; segments may nest other segments. Each segment has a
content identity (`closureVersion`) that folds its own revision together with the
identities of every segment in its transitive dependency closure, so the
evaluation cache key — `flag | flagRevision+closureVersion | userId | attrsHash` —
covers the whole dependency graph. Writes to a segment therefore invalidate only
its descendants; unrelated entries stay warm.

- `GET/PUT /api/segments/:id`, `POST /api/segments` — nested-segment cycles and
  unknown references are rejected with `422` at write time; a successful `PUT`
  returns the new `closureVersion` and the `invalidated` descendant ids.
- `POST /api/flags/:id/evaluate` `{userId, attributes}` — returns the value plus
  `cache.status` (`hit`/`miss`/`coalesced`) and `cache.version`, the closure
  version the entry was stored under. Concurrent first computations for a key
  are coalesced; a caller disconnecting never cancels the shared computation,
  and a result computed before a concurrent segment write is never published
  to the cache.
- `GET /api/cache/stats` — cache size/capacity and hit/miss/compute/coalesced/
  stale-drop counters.
