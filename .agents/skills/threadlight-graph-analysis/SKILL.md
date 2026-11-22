---
name: threadlight-graph-analysis
description: Design, review, or update dsh-threadlight graph records and source-linked implementation flows. Use for graph contracts and assessing which changed nodes relate to a task.
---

# Threadlight graph analysis

- Read ../../../docs/graph-format.md when touching the interchange format and ../../../examples/basic.graph.json for the minimal shape.
- Begin at the user-visible action, then follow the concrete entrypoint, state or data transitions, error branch, and test where available. A file import alone is insufficient evidence of a business operation.
- Write summaries that a user can follow without opening the source. Name the observed conditions on alternate branches and retries. Add uses or continues links only when the actual operation reaches the target flow.
- Keep semantic node IDs stable across line moves and layout updates. Distinguish a task's direct implementation, supporting changes, and changes to verify. Compare actual diffs and cite a specific entrypoint or test for each judgment.
- Treat existing local edits as the comparison baseline when available. Without attributable edit evidence, label changes as workspace changes. Keep inferred relationships and uncertainty visible.
- Use repository-relative source locations. Exclude secrets, raw session data and generated copies when the source-of-truth file provides the evidence.
