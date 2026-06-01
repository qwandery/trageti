# kf-8..kf-9.md: v0.3 remediation R1 fail-closed contracts -> v0.3 remediation R6 schema rename

Source kind: keyframe-pair source bundle
Previous commit: cfeb3ac (v0.3 remediation R1 fail-closed contracts)
Current commit: 608f13e (v0.3 remediation R6 schema rename)
Date: 2026-05-20

## Commit message

v0.3 remediation R6: spec amendment, trageti\_ table rename (migration v005), final gate green

## git diff --stat

```txt
 _docs/dev/README.md                           | 702 +++++++++------------
 _docs/specs/trageti-spec-v0.3-verification.md | 216 ++++---
 _docs/specs/trageti-spec-v0.3.md              | 209 ++++--
 src/db/migrations/v004_timestamps.ts          |  41 ++
 src/db/migrations/v005_rename.ts              | 192 ++++++
 src/db/repositories/AssertionRepository.ts    |  37 +-
 src/db/repositories/CitationRepository.ts     |  32 +-
 src/store/TemporalStore.ts                    |  96 ++-
```

## Material change summary

Remediation R6 adds migration v004 for timestamps and migration v005 for renaming live database tables from the old trl* prefix to the trageti* prefix. This makes the physical schema align with the library name and current spec.

The remediation also updates the spec and verification documents so the implemented schema, docs, and tests agree.

## Selected important file diffs

### src/db/migrations/v005_rename.ts

```txt
Migration v005 renames every live trl_ table to the trageti_ prefix and preserves existing data during the transition.
```

### src/db/migrations/v004_timestamps.ts

```txt
Migration v004 adds timestamp columns needed by the v0.3 schema contract.
```

### \_docs/specs/trageti-spec-v0.3-verification.md

```txt
The verification document is refreshed so spec claims match the implemented migrations and repository behavior.
```
