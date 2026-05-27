# kf-7..kf-8.md: v0.3.0 release gate -> v0.3 remediation R1 fail-closed contracts

Source kind: keyframe-pair source bundle
Previous commit: 8350531 (v0.3.0 release gate)
Current commit: cfeb3ac (v0.3 remediation R1 fail-closed contracts)
Date: 2026-05-19

## Commit message

v0.3 remediation R1: RetrievalResult envelope, FK fail-closed, README, advanced.closeAssertion

## git diff --stat

```txt
 README.md                                | 436 +++++++++++++--------
 src/db/migrations/runner.ts              |  29 +-
 src/db/repositories/AssertionRepository.ts | 14 +-
 src/db/repositories/CitationRepository.ts |   7 +-
 src/pipeline/retrieve.ts                 |  96 ++-
 src/store/TemporalStore.ts               | 152 ++++--
 test/integration/retrieval.test.ts       |  88 ++-
```

## Material change summary

Remediation R1 changes retrieval to return a RetrievalResult envelope instead of a bare array, giving callers result metadata, candidate counts, and applied-signal information alongside assertions.

The same remediation makes foreign-key handling fail closed, corrects README guidance, and adds advanced.closeAssertion for explicit assertion lifecycle management.

## Selected important file diffs

### src/pipeline/retrieve.ts

```txt
Retrieval now returns a RetrievalResult envelope with results, candidate counts, strategy metadata, and applied retrieval signals.
```

### src/db/migrations/runner.ts

```txt
Foreign-key enforcement is treated as fail-closed so integrity failures cannot silently continue with constraints disabled.
```

### src/store/TemporalStore.ts

```txt
advanced.closeAssertion gives callers a direct method for closing an assertion validity window.
```
