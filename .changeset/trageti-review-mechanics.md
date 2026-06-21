---
"trageti": minor
---

Fix reviewed API-surface and mechanics issues across write validation, retrieval routing, reindex locking, SQL hardening, scoring, and namespace cleanup.

- Add schema v002 for persisted namespace operation locks and a source-episode link index.
- Make bundle writes use the same validators and guarded supersession close behavior as single assertion writes.
- Run retrieval before-middleware before provider-derived query embeddings and surface vector-index-not-ready states explicitly.
- Harden FTS tokenizer and custom pragma interpolation.
- Add opt-in anchor-distance recency modes for built-in scorers and deprecate BM25 single-candidate `LinearScorer.score()` usage.
