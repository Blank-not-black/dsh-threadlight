---
name: threadlight-obsidian-export
description: Change or verify dsh-threadlight Markdown, wikilink, JSON Canvas, or versioned snapshot exports.
---

# Threadlight Obsidian export

- Read ../../../docs/graph-format.md and ../../../lib/obsidian.mjs before changing output. The note graph follows project → group → flow, with cross-flow links grounded in explicit relations. Canvas explains action order and conditions.
- Keep stable IDs for note properties and block anchors. Note filenames serve readers and may follow changed titles. Verify all file cards, text-card links, endpoints and block anchors against written output. Use vault-root-relative links with forward slashes on Windows as well.
- Keep export publication consistent across the CLI and DSH store. Publish the manifest after the files. Test interrupted retries, conflicting files, and preservation of an edited completed snapshot.
- If output semantics change, update the export format version so that an existing snapshot cannot masquerade as the new format. Verify an export from an existing graph and report separately whether Obsidian was exercised.
