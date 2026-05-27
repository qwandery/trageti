# kf-9..kf-10.md: v0.3 remediation R6 schema rename -> v0.3 polish determinism and graph fixes

Source kind: keyframe-pair source bundle
Previous commit: 608f13e (v0.3 remediation R6 schema rename)
Current commit: ba34a58 (v0.3 polish determinism and graph fixes)
Date: 2026-05-21

## Commit message

v0.3 polish: snapshot supersession, FTS5 errors, step order, named defaults, graph determinism

## git diff --stat

```txt
 CHANGELOG.md                                  |  85 +++
 _docs/specs/trageti-spec-v0.3-verification.md | 153 +++--
 _docs/specs/trageti-spec-v0.3.md              | 188 +++++-
 src/db/migrations/runner.ts                   |  17 +-
 src/db/repositories/AssertionRepository.ts    |  11 +-
 src/defaults/graph/CTEGraphAdapter.ts         |  83 ++-
 src/defaults/validation/DefaultAssertionValidator.ts | 20 +-
 src/pipeline/retrieve.ts                      |  57 +-
```

## Material change summary

The polish commit fixes snapshot supersession semantics so current snapshots do not leak replaced assertions. It also improves FTS5 error messages, corrects startup step order, adds named defaults, and tightens graph traversal determinism.

These are conformance fixes: the public behavior becomes easier to reason about because retrieval, startup, and graph traversal now match the spec more closely.

## Selected important file diffs

### src/pipeline/retrieve.ts

```txt
Snapshot retrieval filters superseded assertions so a current snapshot reflects the active assertion set.
```

### src/defaults/graph/CTEGraphAdapter.ts

```txt
Graph traversal is made deterministic so equivalent paths return in a stable and explainable order.
```

### src/db/migrations/runner.ts

```txt
Startup step order is corrected so schema preparation, extension loading, and migration checks happen predictably.
```
