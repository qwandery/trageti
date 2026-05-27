# kf-6..kf-7.md: v0.3 phase 4 retrieval routing -> v0.3.0 release gate

Source kind: keyframe-pair source bundle
Previous commit: b73f7c6 (v0.3 phase 4 retrieval routing)
Current commit: 8350531 (v0.3.0 release gate)
Date: 2026-05-19

## Commit message

v0.3 phase 6: package metadata, coverage thresholds, verification matrix - v0.3.0

## git diff --stat

```txt
 CHANGELOG.md                                  |  95 ++++++++++++
 README.md                                     |  20 ++-
 _docs/migration-v0.2-to-v0.3.md               | 198 ++++++++++++++++++++++++++
 _docs/specs/trageti-spec-v0.3-verification.md | 110 ++++++++++++++
 package.json                                  |  10 +-
 vitest.config.ts                              |   9 +-
```

## Material change summary

The v0.3.0 release gate turns implementation work into releasable package state. The commit updates package metadata, README, changelog, migration guidance, and the verification matrix.

Coverage thresholds become part of release readiness, making test coverage an enforced quality gate rather than an informal target.

## Selected important file diffs

### _docs/migration-v0.2-to-v0.3.md

```txt
The migration guide documents how callers move from v0.2 to v0.3, including async APIs and retrieval result changes.
```

### _docs/specs/trageti-spec-v0.3-verification.md

```txt
The verification matrix records which v0.3 requirements are implemented and tested before release.
```

### vitest.config.ts

```txt
Coverage thresholds are enforced as part of the v0.3 release gate.
```
