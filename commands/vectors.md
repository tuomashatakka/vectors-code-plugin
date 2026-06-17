---
description: Search the local project RAG store (current project or global)
argument-hint: [query]   (prefix with "all:" to search every project)
---

You have access to the `vectors` MCP server, a local project-partitioned RAG
store. The user wants to search it.

Query: $ARGUMENTS

- If the query starts with `all:`, strip that prefix and call `search_global`
  with the rest — search across every project.
- Otherwise call `search` (it auto-resolves the project from the working
  directory). If you're unsure which project that is, call `current_project`
  first to confirm scope, and mention the project you searched.
- Summarize the top hits with their `project`, `title`, `source`/`url`, and the
  relevant snippet. Prefer quoting the stored chunk text over guessing.
- If nothing comes back, suggest `list_projects` so the user can see what's
  indexed, or `ingest` if the resolved project is empty.
