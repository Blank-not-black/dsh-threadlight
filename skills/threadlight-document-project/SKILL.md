---
name: threadlight-document-project
description: Create or update the documentation graph in a dedicated Threadlight DSH session when its Git workspace snapshot and change list are provided.
---

# Document a Threadlight snapshot

Read .threadlight/input.json first. It gives mode, snapshotId, changes, and affectedFlows. The session starts in a detached copy of the source. Read code and tests inside this copy. Write only .threadlight/update.json using the write tool.

For full mode, identify the most useful user-visible functions and start with a few distinct flows per area. Start where a person takes an action, follow its handlers, and show what succeeds, fails, or needs a decision. Use the code as evidence. Prefer a small clear map to a file inventory.

For incremental mode, read .threadlight/previous.json. Review the changed paths and the indicated flows, including any carried-over evidence marked needs-review. Report each group/flow pair in affectedFlows exactly once in reviewedFlows, with a one-line reason based on what the change does. For a flow that stays as it is, state what you verified and why the documentation still applies. Updated flows carry their complete new nodes and edges under the same ID. Omit unaffected flows and groups. Use removeFlows when that flow no longer exists. Add a new flow when the change introduces a real user-visible path. Return groups as an empty array if none of the docs need editing.

Write JSON with snapshotId copied verbatim, reviewedPaths listing the exact paths from changes, and groups holding the touched entries. Supply project.name on the first run.

Add an optional top-level glossary for technical terms that appear in the reader text and merit an explanation for a non-developer. Use entries with term (the exact phrase in the text) and definition (one or two plain sentences in the project's documentation language, up to 360 characters). Explain what the term does here. For example, `{"term":"断点续传","definition":"上传中断后，从上次确认的位置继续发送文件。"}`. For incremental updates, include only new or revised definitions. Existing entries are kept and matching terms are replaced case-insensitively.

~~~json
{
  "snapshotId": "id from input.json",
  "reviewedPaths": [],
  "reviewedFlows": [],
  "project": { "name": "Project" },
  "groups": [
    {
      "id": "files",
      "title": "文件",
      "summary": "用户如何处理项目文件。",
      "flows": [
        {
          "id": "upload",
          "title": "上传文件",
          "summary": "从选中文件到确认保存结果。",
          "nodes": [
            {
              "id": "choose-file",
              "title": "选择文件",
              "summary": "用户选择要上传的文件。",
              "details": ["填入查到的实现事实。"],
              "sources": []
            }
          ],
          "edges": []
        }
      ],
      "removeFlows": []
    }
  ]
}
~~~

Each reviewedFlows entry has group, flow, and reason (at most 360 characters). For full mode use an empty array.

Each node uses id, title, summary, details, and sources. Write the summary as one or two readable sentences about what happens and what the user sees. A source has a relative path with forward slashes, kind of source, test, documentation, or workflow, and a checked one-based line when known. When a README, guide or design decision explains the step, add a documentation reference at the relevant heading or paragraph. Cite test definitions at their declaration lines. When intentionally keeping a citation at the same line number even though its contents changed, include lineText with the exact current source line including indentation and excluding its newline. Threadlight verifies that text against the snapshot. Omit the host-managed node fields state, verification and divergence and the evidence fields anchor, status, preview and symbol.

An edge has from, to, and kind of sequence, branch, or merge. Each branch edge needs a label describing the actual condition. For retries label the trigger and point back to the step that runs again. Add uses or continues links when one flow actually invokes or leads into another flow. layout.rows may group parallel steps, placing each ID once. Use lowercase letters, digits and hyphens for stable IDs. Label uncertain facts in the relevant detail. Exclude credential values, session transcripts, host-local paths and unrelated changes.

The reader builds Markdown and the visual view from this one document. Finish once the JSON is written.
