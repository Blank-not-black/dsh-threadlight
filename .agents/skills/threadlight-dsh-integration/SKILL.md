---
name: threadlight-dsh-integration
description: Implement or debug the dsh-threadlight host adapter, Cordis bundle, tool registration, and DSH profile compatibility tests.
---

# Threadlight DSH integration

- Start at ../../../index.mjs and ../../../lib/dsh-store.mjs. Keep the DSH adapter separate from the reusable graph and Obsidian renderer.
- Resolve the calling session's effective directory with workingDirectory.ensure. Use the DSH filesystem service for content and creation. For a confining backend, carry the session's standing sandbox policy into writeText.
- Use createIfAbsent for generated files. Keep the tool arguments narrow enough for a user to tell what it reads and writes. If a host capability is optional, test plugin startup with and without it.
- When changing schemas or registration, check the installed host's declarations. Run npm run check with THREADLIGHT_DSH_CLI_ROOT pointing to the installed package to verify registration and execution against a temporary profile.
- Check npm pack dry-run output after changing the plugin entry, bundle patch, or packaged user skill.
