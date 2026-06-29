---
"trageti": patch
---

Resolve the v0.4.1-alpha.1 revised review findings for the 0.4.2 alpha line.

- Fix hybrid retrieval so BM25 and vector search contribute independent temporal candidates before fusion.
- Add opt-in rerankers, self-citation helper, token-count hooks, and expanded context coverage/fetch controls.
- Harden graph traversal, setup cleanup, schema-extension column definitions, namespace initialization, indexing-state checks, and staging-table cleanup.
