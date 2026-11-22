---
name: threadlight-map-project
description: Build a source-linked graph of the current project and export it to Obsidian when the user asks.
---

# Map a project for Threadlight

Start from a user-visible task such as uploading a file or restoring a session. Read its entrypoint, downstream handlers, and relevant tests. State what each step does in everyday language. Include error or recovery steps only when there is evidence for them. A graph arrow describes the flow; a source or test reference is what lets the reader check it.

Use summary for what a user needs to understand on the first read. Put implementation facts and their evidence in details and sources. On a branch or retry, use edge.label to describe the actual condition. If a flow invokes another mapped flow, add a links entry with the target group, target flow, and kind uses. Use continues when it is the next user-visible operation.

Write .threadlight/graph.json in the current session workspace. Retain stable IDs and unrelated flows when updating an existing file. Paths are repository-relative with forward slashes. Use one-based lines when you have checked them. Exclude credentials, session transcripts, environment values, and private absolute paths.

Use this shape. Each group and flow has at least one entry. Both endpoints of an edge belong to that flow. Source kinds are source, test, documentation, and workflow. Edge kinds are sequence, branch, and merge. An optional layout.rows lists each node ID once.

~~~json
{
  "schemaVersion": 1,
  "project": { "name": "Example project" },
  "groups": [
    {
      "id": "files",
      "title": "Files",
      "flows": [
        {
          "id": "upload",
          "title": "Upload a file",
          "summary": "Follow the request from the interface to storage.",
          "nodes": [
            {
              "id": "select-file",
              "title": "Select a file",
              "summary": "The user chooses a local file.",
              "details": ["Verify where the selected file is handed to the upload handler."],
              "sources": []
            }
          ],
          "edges": []
        }
      ]
    }
  ]
}
~~~

Replace the example with the observed implementation. Keep uncertainty next to the relevant node. Call threadlight_export with an empty object when the user requested export. Report the resulting workspace-relative directory and overview.canvas entrypoint.
