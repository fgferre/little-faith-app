# AGENTS.md
Little Faith · Bolões: a Portuguese PWA to organize private lottery pools — local-first (IndexedDB) with Supabase sync, and real money tracked to the cent. Built for its owner, who does not program and judges by screenshots and results.
Keep this file under 50 lines; every agent reads every line, every session. Add a line only after the same mistake happens twice; when a line can become a check (lint rule, test, hook), do that and delete the line.
Commands

* Setup: `npm ci && npx playwright install chromium`
* Done means: `npm run done` (types, lint, unit, SQL in PGlite, API in Deno, build, Playwright) passes. Run it once, at the end, before you say a task is finished.
* While working, run only the tests for what you touched: `npx vitest run <file>`, `npm run test:db`, `npm run test:api`, `npx playwright test <spec> -g '<name>' --workers=1`. Only commands with non-obvious arguments go here; the rest is in the manifests.

How to work

* Before starting: if the request seems mistaken, has a simpler path, or misses something (existing code, an edge case, security), say so in one or two sentences. Then do what was asked, unless it's on the ask list. State any assumption.
* Do what was asked, no more. If you spot a bug or an improvement nearby, leave it and add one line to `BACKLOG.md`.
* Before writing a helper, component, or util, look for an existing one and extend it. One way to do each thing.
* Do the simplest thing that works. No abstractions, options, or config for needs that don't exist yet.
* Change as little as possible: targeted edits, not whole-file rewrites. Match the patterns already in the file; formatting is the linter's job.
* When you replace something, delete the old version. No commented-out code, unused functions, or leftover files.
* Create new files (docs, tests, scripts, notes) only when the task needs them. Delete scratch files before you finish.
* Tests go where the task asks, or where this repo already keeps tests for that kind of change. One focused test per behavior, sized like the neighbors.
* If you can delegate (main session only): keep judgment (plan, decide, hard bugs, review) and hand execution (search, reading many files, tests, mechanical edits) to workers on a cheaper model, so your own context stays small. Each worker gets one task, the files, and what not to do; workers return a summary and never ask.
* When done, say plainly what changed and what you did not do. If something failed, show the output.
* One commit per task, message in Portuguese as `tipo(escopo): …` saying why and whose word decided it, not what; a resolved pending item carries its `(NNN)`. Pushing and deploying are on the ask list.

When to ask
Go ahead on your own with anything local and easy to undo. Stop and ask only when:

* the action is hard to undo or touches shared things: deleting data, migrations, force-push, pushing, publishing or deploying, secrets, a real Supabase project or OAuth setup, adding tests beyond what the task needs (the owner approves that list at the end of a round);
* the request needs a second way of doing something the project already does one way;
* two readings of the request would lead to clearly different work.

Otherwise pick a sensible option, say what you assumed, and keep going. If nobody is watching (unattended run), don't ask: write the assumption, or "BLOCKED: <reason>", and stop.
Traps (not obvious from the code, caused a mistake before; one line each, with the reason; max 5)

* `docs/ESPECIFICACAO.md` is the product spec (it used to be `PLAN.md`) — read the section you need, never rewrite or summarize it.
* Money is a string of cents with `bigint` for math, never `Number`; a missing result is not zero, and a calculated prize is not money received.
* Outside CI, Playwright reuses servers already running, and `serve-configured.mjs` serves a build compiled at start — restart them after edits, or you test stale code.
* Result versions are listed newest first — pick one by its real id, never by list position (a test picked the manual version instead of the official one this way).

Memory

* The repo is the memory: code, git history, and the files below. Don't create other notes, summaries, or docs on your own. Process rules live here and in `CLAUDE.md`, never in auto-memory.
* `docs/PENDENCIAS.md`: what's open. Before starting, read only O BASTÃO and the item of the turn; the rest by `grep`. Keep one baton: rewrite it when a round stops (commit `docs(bastão): …`); the old one lives in git. Items are numbered (number is identity); a resolved item leaves the list. What the owner reports goes in his words, with the date.
* `PLAN.md` (root, optional; `PLAN-<tema>.md` when two run at once): for a task that spans sessions or is handed to another model. First line: task and date; then steps in order, files involved, decisions already made, and what's out of scope. Mark steps done as you go. If you find one you didn't write, read it first. Delete when done (git keeps it).
* `BACKLOG.md` (root, max 30 lines): things noticed but not done, one line each. When it's full, triage before adding.
* The session scratchpad vanishes (cleanup, reboot): anything the next session needs goes to `.tmp/<tema>/` (ignored by git) from the start, and the baton says where.
* Don't edit this file during normal work; if a rule seems missing, say so in your final message. Anything that must always happen (formatting, blocked commands) lives in hooks, linters, or CI, not here.
