# Changelog

## 0.7.5 — 2026-10-30

Brito now creates and edits skills on its own in "allow everything" mode.

### Changed
- In "allow everything" mode, `skill_save` (and the MCP server) no longer sends every skill to the review queue. Safe skills are saved as *in trial* and promoted or archived by results, like the autonomous reflection path. Skills with destructive commands, and changes to skills you approved, still wait for `/skills approve`.

## 0.7.4 — 2026-10-29

Follow-up fix for the terminal resize glitch.

### Fixed
- Resizing the terminal quickly (e.g. dragging the window edge) could still leave duplicated status bars and input boxes on screen. The dock now handles one resize at a time and no longer guesses its position when the terminal does not answer.

## 0.7.3 — 2026-10-29

Fixes the terminal interface breaking when the window is resized.

### Fixed
- Resizing the terminal no longer leaves stray rules, a duplicated status bar or a misplaced input box. The dock now recomposes itself after the terminal reflows its content.

## 0.7.2 — 2026-10-24

Maintenance and security release. No behavior change for normal use.

### Fixed
- The skills `.gitignore` is created atomically (no check-then-write race when two sessions start together).
- Import aliases: a captured path containing `$&` or similar no longer gets rewritten by `String.replace`.
- `.svelte`/`.vue`/`.astro`: the `</script>` closing tag is matched even with attributes or spaces, as browsers accept.
- Removed unused imports and variables.

### Changed
- Dependencies: `@anthropic-ai/sdk` 0.137, `@modelcontextprotocol/sdk` and `@types/node` patches. `npm audit` is clean.
- `commander` stays on 14 (15 requires Node >= 22.12; Brito supports Node >= 20).
- Repository: community standards (CONTRIBUTING, Code of Conduct, SECURITY), Dependabot, CodeQL code scanning and branch protection on `main`. The desktop app builds on Electron 45.

## 0.7.1 — 2026-10-24

Same app as 0.7.0; this release ships the **Windows desktop installer** that 0.7.0 missed.

### Fixed
- Test suite passes on Windows again (LF test fixtures via `.gitattributes`; the escaped-space path test is POSIX-only), so the Windows desktop build is no longer blocked.

## 0.7.0 — 2026-10-23

### Added
- **Automatic fallback to Qwen.** When Claude (API or `claude` CLI) fails on account/capacity (subscription limit, rate limit, credit, auth, overload, network), Brito warns and redoes the request on the `qwen` profile with the conversation so far. Once per session; `/model <claude>` goes back. Never on Ctrl+C or content errors.
- Without `ANTHROPIC_API_KEY` and without the `claude` CLI, Brito (terminal and desktop) opens on Qwen when the fallback is ready; otherwise the startup error says why the fallback is unavailable.
- `/fallback` shows the main model, the fallback and its state (terminal; in the desktop app, send it as a message). The desktop status bar shows Qwen while the fallback is active.
- Going back from Qwen to the `claude` CLI (`/model <claude>`, terminal and desktop) keeps the context: what was done in API mode opens the next request to Claude, and a later fallback inherits it too.
- In API mode, `/model <claude>` without `ANTHROPIC_API_KEY` is refused with a hint instead of failing on the next turn.

## 0.7.0-qwen.0 — 2026-10-20 (fork)

### Added
- **OpenAI-compatible endpoints.** Profiles in `~/.brito/config.json` (`providers`) let Brito run on any model behind the Chat Completions API with tool calling — first target: Qwen 27B on an OCI Generative AI dedicated endpoint. Choose it with `brito --model <profile>`, `BRITO_MODEL` or `/model`.
- With a profile selected, every model call (main agent, subagents, context compaction, skill learning) goes to that endpoint; Brito no longer needs `ANTHROPIC_API_KEY` or the `claude` CLI in that case.
- `-m, --model` option on the main command; `/reasoning none|<level>` in API mode (turns the endpoint model's reasoning off/on).
- `scripts/capture-openai-fixtures.ts` records sanitized real responses for the provider tests.

### Changed
- Model calls go through a provider layer (`src/provider/`); Claude behaviour is unchanged.
- Learning, consolidation and the `plan`/`general` subagents follow the live model (`/model`) instead of the model read at startup.
- A response cut by the token limit now warns and keeps the history valid (no empty assistant message; a cut tool call gets an error `tool_result`). Endpoint profiles with reasoning on get a 16k output budget.

### Fixed
- `-m/--model` now applies to single-prompt runs in `claude` CLI mode too.

## 0.6.1 — 2026-10-19

Fixes concurrent use of the same project on **Windows and Linux** in 0.6.0. If you use several Brito sessions on one project on those systems, upgrade.

### Fixed
- With several processes on the same graph, a query could fail with an error about the `.shadow`/`.wal` file (`Cannot open file. path: …`, `Access is denied`, `Error removing directory or file`); the message differs between Windows and Linux, and 0.6.0 only recognised one form. Any `.shadow`/`.wal` error is now treated as transient and retried until the lock frees up (15 s).

### CI
- New `test` workflow runs typecheck and the test suite (including the multi-process lock tests) on macOS, Linux and Windows for every push and pull request. The desktop app was checked by hand on macOS only.

## 0.6.0 — 2026-10-19

**Breaking change: the graph database engine changed from Kùzu to LadybugDB.** Kùzu was discontinued; [LadybugDB](https://github.com/LadybugDB/ladybug) is its maintained fork. The on-disk format is not compatible, so this is a minor bump (0.x: the middle number marks breaking changes).

### What you need to know when upgrading
- The code graph is **rebuilt automatically** on first use (`.brito/graph.lbug`, new file). Expect a full re-index once; nothing to do.
- Your old graph (`.brito/graph.kuzu`) is **kept untouched**. Delete it whenever you want to reclaim disk space.
- **Notes (memory) are not lost.** On the first interactive open of a project that has an old graph, Brito asks once whether to copy the notes to the new graph (it downloads Kùzu, ~100 MB, only for that step, in a temp folder). Answer `n` and it will not ask again; you can copy them later with `brito migrar-notas` (idempotent, safe to repeat).
- Skills are plain files and are not affected.
- The `kuzu` dependency is gone; `@ladybugdb/core` replaces it (prebuilt binaries for macOS, Linux and Windows). **Validated on macOS only**; Linux and Windows are expected to work but were not tested by hand.

### Added
- `brito migrar-notas` copies the notes from the old Kùzu graph into the new one.

### Changed
- Graph store moved to LadybugDB (`src/graph/store.ts`). The database lock is held only while queries run, so several sessions can share a project.

### Fixed
- Multi-session robustness: concurrent creation of the database, lock starvation and two indexers running at once are handled (`.brito/index.lock`).
- A query could fail with `Could not set lock` or `checkpoint is in progress` when another process was using the same graph, because the binding opens the database lazily and the error escaped the retry. The query is now retried until the lock frees up. Covered by a 4-process stress test.

## 0.5.2 — 2026-10-17

### Fixed
- Dependencies: `commander` pinned to `^14` (requires Node >= 20) and `"latest"` replaced by version ranges.

## 0.5.1 — 2026-10-16

### Fixed
- Unique id for getter/setter pairs in the graph; the graph releases its lock when idle.

## 0.5.0 — 2026-10-15

Brito now comes in two forms: the `brito` command in the terminal (`brito-cli` on npm, as before) and a **desktop app**, a native executable for macOS, Windows and Linux.

### Added
- **Desktop app** (`desktop/`, Electron). Projects and sessions in a sidebar, chat with markdown, collapsible tool calls, permission prompts, pickers for model, effort and permission mode, and a status bar with context and cost. Sessions are saved in `~/.brito/desktop.json`; with the `claude` backend they resume the same conversation when reopened. It runs the same agent through `brito gui-serve`, a backend that speaks JSON over stdio.
- **Packaging.** `npm run desktop:app` builds and installs `Brito.app` (own icon) in `/Applications` on macOS; `npm run desktop:dmg` builds the `.dmg`. Linux gets a `.tar.gz` with an `install.sh` that adds Brito to the applications menu; Windows gets an Inno Setup installer. The GitHub Actions workflow `desktop` builds all of them and attaches them to a Release on `v*` tags (or on demand). Builds are unsigned unless the signing secrets are set.
- **API-key backend in the desktop app.** With `ANTHROPIC_API_KEY` the app uses the API directly, otherwise your Claude Code subscription. Apps opened from the Finder read the login shell for `PATH` and the key.
- **Images by drag and drop.** Dropping an image file onto the terminal (or typing/pasting its path, quoted, backslash-escaped or `file://`) attaches it to the turn, like Claude Code. PNG, JPEG, GIF and WebP up to 5 MB, at most 5 per message. The prompt shows a short `[imagem #1: name.png]` marker instead of the long path. With an API key the image goes to the model as an `image` block; with the `claude` CLI backend Brito grants Read access to the image's folder and tells the model to open it. Images no longer inflate the context estimate (they would have triggered compaction on every turn).

### Changed
- The agent emits turn events (text, thinking, tool calls) through a `TurnSink` instead of writing to the terminal; the terminal behaves as before. The approval server moved from `cli.ts` to `src/agent/approval.ts`.
- The npm package no longer ships `dist/cli.bundle.mjs` (the single-file backend used only by the desktop app).

### Fixed
- Inside Electron (`ELECTRON_RUN_AS_NODE`), `commander` treated the script path as an argument, so a subcommand fell into the default mode and could spawn a `claude` per process. `parseAsync` now passes `{ from: "node" }`, and a `BRITO_DEPTH` guard aborts the default mode when nested more than two levels.

## 0.4.0 — 2026-10-15

### Added
- **Autonomous skill learning** (`BRITO_SKILLS=auto`, now the default; `ask` keeps the old approve-everything flow, `off` disables learning). The reflection after a turn saves new skills *in trial* without asking. Each later turn that loads a trial skill counts as a win (no error-then-fix, no user correction) or a loss: 3 wins promote it to active, 2 losses (without more wins) or 21 idle days archive it to `.brito/skills/.trash`. An active automatic skill is archived if it starts failing (3+ losses above its wins).
- Safety rails: automatic skills are project-scoped only; at most 3 new ones per day; a change to a skill you approved, or any content with destructive commands, goes to `/skills pending` instead; the lint still applies; a weekly automatic consolidation (6+ skills) only merges or prunes automatic skills.
- Skill front matter gains `status` (`trial`/`active`), `origin` (`auto`/`manual`), `wins` and `losses`; old skills read as active and manual. `/skills` shows the score; the skills index tags trial skills "(em teste)".
- `brito --version` / `-v`.

### Changed
- Skills approved by a human (`/skills approve`, `skill_save` with approval) are always `active` and `manual`, and are never promoted, archived or rewritten automatically.

### Fixed (Windows)
- Approvals through the `claude` CLI backend no longer hang: the approval server listened on a unix socket in `%TEMP%`, which Windows does not accept. It now uses a named pipe (`\\.\pipe\brito-approve-<pid>`).
- The `claude` installed through npm (a `claude.cmd` shim) is now found and run, so the subscription backend no longer disappears silently. Brito resolves the shim's real target instead of using `shell: true`, which would break the quoting of the system prompt and the MCP config.
- The `bash` tool and `!command` use Git Bash when it is installed (or `BRITO_SHELL`), and the model is told when the shell is `cmd.exe`.
- Ctrl+C during a turn is reported as "interrupted" instead of an error (Windows kills the child without a signal).
- The "path outside the project" check compared strings with `startsWith`, which rejected valid paths when the drive letter or directory casing differed (`C:\` vs `c:\`) and accepted sibling directories sharing a prefix (`/proj-x` inside `/proj`) on every system. It now uses `path.relative`.
- Windows is now a documented target (see README); it has so far been exercised only by fixtures and one user report.

## 0.3.2 — 2026-10-11

### Fixed
- Two Brito processes on the same project no longer crash with a raw Kùzu stack trace (`Could not set lock on file`). The graph database accepts one process at a time, so opening it now waits up to 4 s for the other process to let go (covers short overlaps) and, if it is still busy, exits with a clear message saying another Brito (another terminal, or a Claude Code session using Brito) is using the project.

## 0.3.1 — 2026-10-11

### Changed
- New startup banner: the name BRITO over a web (rings, spokes and nodes — half spider web, half graph) generated at runtime. On windows of 95+ columns and 28+ rows the web fills the whole terminal with the panel on top; smaller windows keep the compact banner with a small web, and narrow ones only the panel. `BRITO_BANNER=compact|full` overrides it. Purple tones only (follows `BRITO_COLOR`), fading from light at the center to dark at the edge.

## 0.3.0 — 2026-10-11

### Changed
- **License changed from MIT to [PolyForm Noncommercial 1.0.0](LICENSE).** Free for personal, research, educational and other noncommercial use; commercial use is not permitted. Versions up to and including 0.2.0 were released under MIT.

## 0.2.0 — 2026-10-11

### Packaging
- Published on npm as **`brito-cli`** (`npm i -g brito-cli`); the command is still `brito`. The unscoped name `brito` is blocked by npm's similar-name rule.

### Added
- Code graph for backend languages: **Java** (`.java`), **Kotlin** (`.kt`), **Go** (`.go`), **Ruby** (`.rb`), **PHP** (`.php`), **C#** (`.cs`) and **Rust** (`.rs`), alongside TypeScript/JavaScript, Python and `.svelte/.vue/.astro`.
  - Symbols: classes, interfaces, structs, traits, enums, modules, functions and methods (`Class.method`).
  - Imports are resolved by package/namespace/module against the end of your files' paths (Java/Kotlin packages, PHP PSR-4, Rust `use crate::`, Ruby `require`/`require_relative`, Go via the `go.mod` module path). External packages create no edges.
  - Calls: `this`/`self`/receivers resolve to the enclosing class, bare calls inside a class try the class's own methods first, and a receiver is matched to a project type by name (`userRepository.save()` → `UserRepository.save`). There is no type inference.
- `target`, `vendor`, `obj`, `.gradle`, `*.pb.go`, `*.g.cs` and `*.Designer.cs` are skipped when indexing outside git.
- `src/graph/langs.ts` documents how to add another language.

### Changed
- An import can resolve to several files (e.g. a Go package), producing one `IMPORTS` edge per file.
- Type-name matching for receivers also applies to TypeScript/JavaScript/Python calls.

### Known limits
- No type inference; interface calls do not reach implementations.
- Ruby: bare identifiers without parentheses are not read as calls; autoload and metaprogramming are not captured.
- C#: `using` matches directories with at least 2 segments.
- Go: only the root `go.mod` is read.
- Validated on synthetic fixtures only, not yet on large real-world repositories.
