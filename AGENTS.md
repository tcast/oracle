# AGENTS.md — oracle

## RAG search scope (default)

This project is **oracle**. When you use the `search_knowledge` tool from the `tcast-code` MCP server, **default to `repo="oracle"`** so results are scoped to this codebase.

Example:
> search_knowledge(query="how does the payment webhook work", repo="oracle")

## Overriding the scope

The user may explicitly ask you to search another repo, or all repos. Respect those requests:

- **Search a specific other repo** — e.g. "look in authio for how auth works" → call `search_knowledge(query="...", repo="authio")`.
- **Search everywhere** — e.g. "search all repos" or "check any codebase" → omit the `repo` parameter entirely.
- **Then come back to oracle** — after a cross-repo lookup, unless the user says otherwise, resume defaulting to `repo="oracle"` for subsequent searches.

## Available repos in the RAG index

`jb`, `oracle`, `img`, `insighthire`, `castle`, `authio`, `core`, `momentella`, `daylight`, `pivotalmetrics`, `mega`

## File edits stay in oracle

You can only read, edit, and run commands inside `oracle`. `search_knowledge` may surface code from other repos as **reference**, but never edit files outside `oracle`.

## Anti-hallucination rules

- **Never claim work is complete without evidence.** If you did not call Write/Edit/Bash successfully, do not say the file was created, the container was updated, or the feature is deployed.
- **If a tool call failed, say so plainly.** State the error, then either fix it or ask for guidance. Do not repeat the plan or say "let me fix this properly" without a concrete next tool call.
- **Do not describe UI as if it exists.** No ASCII mockups of finished screens, no "you should now see...", no "the interface will show..." unless you have just created the code that renders it.
- **When stuck, stop and ask.** Two failed attempts on the same target = stop generating and ask the user for clarification. Do not spiral into apologies.
- **Before non-trivial edits, use search_knowledge.** Find existing patterns in the codebase before inventing new ones. Reference file paths returned by the search in your reply.
- **Verify before claiming.** After writing a file, read it back or run the build. After starting a container, `docker ps`. After a git action, `git status`. Show the output.
