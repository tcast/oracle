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

## Social automation safety — NON-NEGOTIABLE (X, LinkedIn, Reddit, Instagram, TikTok, all social)

**Context:** Aggressive force-runs (rapid repeated logins + high-volume commenting across many accounts in minutes) got 50 LinkedIn accounts hard-restricted behind government-ID verification. This must NEVER happen again.

- **NEVER be aggressive on any social site.** No "force due", no rapid re-login loops, no hammering an account or many accounts to prove volume. Behave like ONE calm human at all times.
- **Always human-paced.** Human-like browse (land, scroll, pauses, natural delays, human typing) is mandatory on every session — not optional, not "when applicable".
- **Respect daily caps + quiet hours + spacing.** Do not bypass or raise limits to generate volume faster. Slow is correct.
- **Low concurrency per platform.** Do not open many sessions against the same platform in a short window. Space account actions out.
- **One login attempt, then back off.** Never repeatedly re-login an account. Repeated auth = the #1 ban trigger. A flaky/expired session waits and retries later, it does NOT get hammered.
- **Never "prove it's talking" by force-running.** Proof = read logs/DB of what naturally happened, or ONE gentle human-paced action — never a burst.
- **Flaky ≠ dead.** Soft-skip and move on; do not retry-spam.
- **If a platform shows any restriction/checkpoint/ID-verification/captcha wall → STOP that account immediately**, mark it accurately, and do not keep trying. Report it. Do not attempt to brute past it.
- **When in doubt, do LESS.** Under-acting is always safer than over-acting on social platforms.

These rules override any request to "go faster", "scale now", or "get volume". If the user asks for speed, stay human-paced and tell them why.

## Anti-hallucination rules

- **Never claim work is complete without evidence.** If you did not call Write/Edit/Bash successfully, do not say the file was created, the container was updated, or the feature is deployed.
- **If a tool call failed, say so plainly.** State the error, then either fix it or ask for guidance. Do not repeat the plan or say "let me fix this properly" without a concrete next tool call.
- **Do not describe UI as if it exists.** No ASCII mockups of finished screens, no "you should now see...", no "the interface will show..." unless you have just created the code that renders it.
- **When stuck, stop and ask.** Two failed attempts on the same target = stop generating and ask the user for clarification. Do not spiral into apologies.
- **Before non-trivial edits, use search_knowledge.** Find existing patterns in the codebase before inventing new ones. Reference file paths returned by the search in your reply.
- **Verify before claiming.** After writing a file, read it back or run the build. After starting a container, `docker ps`. After a git action, `git status`. Show the output.
