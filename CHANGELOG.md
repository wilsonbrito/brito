# Changelog

## 0.16.0 — 2026-11-13

Searching a note vault now follows the graph, and there is a tool to explain how two notes relate.

### Added
- **`vault_path(de, para)`.** Cheapest path between two notes or Bible passages (A* with landmarks), with the relation of each hop (`autor`, `fonte`, `temas`, `menciona`, `cita`) and the opening text of each note. Edge cost depends on the relation and on how connected a node is, so paths avoid hubs like the index page. Example: Anselmo → his chapter note → `[Sl 25.10]` → *Amor de Deus*, a link no note states directly.
- **`vault_search` follows the graph.** After the keyword hits it lists related notes that do not contain the words but link to the hits (personalized PageRank), with the reason (`via ...`). When the question names two notes ("o que Anselmo diz sobre Amor de Deus"), it returns the notes linked to both.
- Reproducible simulation in `scripts/poc-sim.ts` (595 structure-derived questions on a real 460-note vault): PPR beat BM25 on hidden-link recovery (recall@10 57% -> 75%, CI [14, 21] points); A* avoided hub shortcuts in 98% of pairs vs 85% for plain BFS. Ground truth comes from the graph itself for two of the three question types, so treat it as evidence for the mechanism, not for answer quality.

### Fixed
- Bible references written as `1Cor`, `2Cor`, `Hab` (and other common Portuguese abbreviations) were dropped by the 0.15.0 book whitelist.

## 0.15.0 — 2026-11-13

Note vaults get searchable sections, Bible references and a one-call text search.

### Added
- **Sections in the graph.** Each `.md` also becomes a `Doc` with one `Secao` per heading (text and line range), `LIGA` edges for `[[wikilinks]]` (typed by frontmatter key or `menciona`) and `CITA` edges to Bible references (`Rm 3.25-26` becomes one node per verse; only known book abbreviations count). PDF/EPUB/DOCX become metadata-only `Doc` nodes. Incremental: an unchanged vault re-indexes in ~250 ms.
- **`vault_search` tool.** Accent/case-insensitive search over note sections (file + `start-end` lines + graph neighbours of the top hit) plus book/lecture excerpts with page from `.brito/textos.db` when present. Always loaded for MCP clients.
- `brito index` prints docs, sections, links, citations and unresolved links.

## 0.14.0 — 2026-11-12

Note vaults (`.md` without code) now get a real graph and three ready-made tools. On a 318-note vault they cut ~28% of tokens and ~48% of cost at equal accuracy.

### Added
- **Markdown (`.md`) in the graph.** Note vaults without code now get a graph of relations: headings become `heading` symbols, frontmatter (`status: open`) and `#tags` become `tag` symbols (`status:open`), `#123` mentions become `ref` symbols, and `[text](./b.md)` links, `[[wikilinks]]`, frontmatter values that name another note (`pessoas: [ana]`) and numeric ids (`pendencias: [14]` → the note with `id: 14` in `pendencias/`) become file→file edges. Empty frontmatter values (`null`) and dates are ignored. Existing projects re-index once (indexer v6; 318 notes ≈ 36 s, then incremental).
- **Three tools for note vaults, no Cypher needed.** `graph_notes_find` (filter by folder, frontmatter field, date/number ranges, links, `#N` mentions; `pick` lists a field's values), `graph_notes_backlinks` (who links to a note, plus `#id` mentions) and `graph_notes_path` (follows relations between notes in one call, e.g. calls of October → open tasks they cover → owners; called with `{}` it lists the vault's relations and fields).

### Measured
Real vault (318 notes), 49 questions x 2 runs, Claude Sonnet, answers scored against a script-computed ground truth (F1). Without the graph the agent uses grep and scripts. 16 of the 49 questions were written after the tools.

| | no graph | notes tools (find, backlinks) | all notes tools (+ path) |
|---|---|---|---|
| mean F1 | 0.98 | 0.99 | 0.99 |
| net tokens per question | 94k | 74k (-21%) | 68k (-28%) |
| cost | $5.12 | $3.43 (-33%) | $2.67 (-48%) |

Biggest gains: multi-hop questions (176k -> 92k tokens), questions written after the tools (134k -> 99k, F1 0.96 -> 0.99) and date/filter questions (about -50%). Content search (finding a word in the body) and implicit mentions tie or lose: use grep there. Known weak spot: chained "who cites X" questions that depend on body text (one question scored F1 0.71 against 0.96 without the graph). Single vault, single model, 2 runs: strong evidence of direction, not a guarantee. The agent only uses the graph with ready-made tools (65-90% of runs); with raw Cypher it used it in 8%.

Unknown keys in `graph_notes_find` / `graph_notes_path` now return an error instead of being ignored: a silently dropped filter returned wrong answers that looked right.

## 0.13.3 — 2026-11-11

On Windows the `claude` backend no longer dies with "O backend encerrou (código 1)" when the project has a large `CLAUDE.md` or `AGENTS.md`.

### Fixed
- **`spawn ENAMETOOLONG` with a big `CLAUDE.md`/`AGENTS.md` (#27).** The system prompt, which embeds the whole project instructions file, travelled on the command line together with `--mcp-config` and `--agents`. A ~29 KB file went over the Windows limit (~32,767 characters) and the backend exited with code 1. Above 24,000 characters those three values now go through temporary files (deleted when the turn ends); below that nothing changes.
- **The desktop app hid why the backend closed.** The "O backend encerrou" notice now shows the end of the backend's error output, so the cause is visible instead of only the exit code.

## 0.13.2 — 2026-11-10

The desktop app on Apple Silicon no longer fails to start the graph with `ERR_DLOPEN_FAILED`.

### Fixed
- **Stuck on the Intel build.** The updater picked the installer by `process.arch`, which reads `x64` when the app runs under Rosetta. A Mac that once installed the Intel `.dmg` downloaded it again on every update. It now uses `app.runningUnderARM64Translation` and moves those Macs to the arm64 build on the next update.
- **Graph addon depended on Homebrew's OpenSSL.** `lbugjs.node` loads `libssl.3.dylib` and `libcrypto.3.dylib`, and only looked for them in Homebrew and MacPorts. On a Mac without `openssl@3` in the matching architecture the backend did not start. The macOS package now ships both libraries next to the addon (rpath `@loader_path`), signs them, and the build fails if any dependency still points outside the app.

## 0.13.1 — 2026-11-10

Skills learned at the end of a task are no longer lost because of a description that is too long.

### Fixed
- **"skill não salva: description deve ter 10–200 chars".** The model that reviews each turn and proposes skills was never told the 10–200 character limit for the description (with the `claude` CLI backend it does not see the `skill_save` schema), so a long description made the whole skill be dropped. The limit is now in its instructions, and a description over 200 characters is trimmed at a word boundary (ending in "…") instead of being refused. You still review the skill before it becomes active. Skill consolidation gets the same treatment, so its proposals are no longer silently discarded.
- The validation error now says how long the description was.

## 0.13.0 — 2026-11-10

The desktop app's "who writes the code" selector is clear now, the local Qwen3-4B can be picked, and the Qwen endpoint with a key is set up from inside ⚙ Configure.

### Added
- **Local Qwen3-4B as the code writer.** The selector next to the model now reads **Escreve o código: Claude (usa tokens)** or **Qwen3-4B (nativo-brito, sem tokens)**. The native option works once `brito slm pull` has run; otherwise the message says why and Claude keeps writing. `/orquestrar modelo slm` does the same in the terminal.
- **Endpoint setup in ⚙ Configure ("QWEN COM CHAVE").** Fill in name, address, model and key; Brito tests the connection (one token) and only then saves the profile. The "Qwen (com chave)" option only appears in the selector once it is configured. You can swap the key or remove the endpoint from the same card.

### Security
- The key is typed once, goes straight to the app's main process and is encrypted with the OS vault (DPAPI/Keychain/libsecret). It never enters the UI state (which is written to disk), never goes to `config.json` and is never sent back. Without a vault (e.g. Linux without a keyring) it lives only until the app closes, and the app says so.
- The address must be `https://`; `http://` is only accepted for localhost and private networks. Credentials inside the URL are refused. The test does not follow redirects.
- `bash` and the `claude` CLI run without the key; only the server that runs the implementer receives it.
- A hand-written `qwen` profile in `~/.brito/config.json` is never overwritten or removed by the app.
- `config.json` is now written atomically (temp file + rename).

### Changed
- Desktop: the conversation, panels and documents now use the full width of the window.

### Fixed
- The "who writes the code" selector now shows what the backend really turned on, instead of staying on an option that was refused.

## 0.12.0 — 2026-11-10

The desktop app now shows its version and updates itself from inside, with no need to download and reinstall by hand.

### Added
- **Version and "Check for updates" in the desktop app.** Settings (⚙ Configure) has a new VERSION section with the installed version and a **Buscar atualização** button. The app also checks on startup, at most once a day, and shows "⬆ Nova versão X" in the sidebar when there is one.
- **Update from inside the app.** On Windows, **Atualizar agora** downloads the installer, runs it silently, closes the app and reopens it already updated. On macOS it downloads the `.dmg` and opens it (drag Brito to Applications). On Linux it downloads the `.tar.gz` to Downloads and reveals it (extract and run `./install.sh`).
- The download is only accepted from this repository's releases and is checked against the release size and SHA-256.

### Notes
- Versions before 0.12.0 have no updater: install 0.12.0 manually once; from then on, update from inside the app.
- Windows installers are not code-signed yet, so SmartScreen may warn.

## 0.11.0 — 2026-11-10

Brito now learns which requests the local model could have handled, and compacts long conversations without spending Claude tokens.

### Added
- **Route decider in shadow mode (`/route`).** After each turn, the local SLM classifies the request as `claude` (reasoning, editing code), `slm` (condense, extract or label a text you gave) or `tool` (a direct lookup or command). Brito logs what it *would* have chosen next to what the turn really needed, inferred from the tools it used (it wrote, planned or delegated → `claude`; only reads and read-only commands → `tool`). **Nothing changes in behaviour yet:** this is to collect real data. `/route` shows how much it would delegate, the "expensive errors" (it would delegate, but the turn edited code), Claude calls that were not needed, and the estimated accuracy; `/route all` covers every repository. Logs stay in `~/.brito/routing/`, outside your repo. `BRITO_ROUTE=off` disables it; it needs `brito slm pull`. The local Qwen3-4B with a closed answer set beat Arch-Router, embedding routing, RouteLLM and Laya on 135 labeled requests (none of the Claude-only requests was sent elsewhere). Feedback with your `/route` numbers is very welcome.
- **Context compaction on the local SLM.** When a conversation is compacted, the middle is summarized by the local model (chunked map-reduce) instead of Claude; on any failure it falls back to Claude. `/context` shows compactions and estimated tokens saved. `BRITO_SLM_COMPACT=off` disables it. (This shipped in 0.10.0 without release notes.)
- **Local model usage in the indicators.** The terminal and the desktop app now show how much the local SLM did (calls, tokens, time) next to the Claude tokens.
- **Skill learning in the desktop app.** The app now reflects after each turn like the terminal does: skill feedback in the chat, `/learn`, and a badge with the number of pending proposals on the Skills button.

### Notes
- The router only observes. Acting on it (sending requests to the local model, with a verifier and Claude as the safe default) is the next step, and depends on what shadow mode shows.

## 0.10.1 — 2026-11-09

The desktop file preview now opens PDF, Word and PowerPoint.

### Added
- **PDF in the preview:** pages are rendered (lazily, so big files stay fast), with page count and zoom.
- **Word (.docx) in the preview:** shown as the document itself — pages, margins, fonts, tables, headers and footers — with zoom. Links do not navigate.
- **PowerPoint (.pptx) in the preview:** one card per slide with title, text, images and speaker notes.
- Old `.doc`, `.ppt` and spreadsheets show a clear message instead of "binary file". Limit: 40 MB.

### Fixed
- The code graph indexer no longer aborts when a file cannot be read (locked, permission, cloud-synced folders); it skips it.

### Notes
- The PDF, Word and PowerPoint libraries ship inside the desktop app. The npm package (`brito-cli`) only gets the indexer fix.

## 0.10.0 — 2026-11-09

Read your project inside the Brito desktop app (Markdown, code, images and diagrams), bring your Claude Code setup with one command, and finally measure how good the automatic skills are, model by model.

### Added
- **File preview in the desktop app (read-only).** The Files panel has a new "Project" tab: the folder tree (it respects `.gitignore`) on the left and a reader on the right.
  - Markdown with front matter, nested lists, task lists, tables, Obsidian callouts (`> [!tip]`) and `[[wikilinks]]`, plus relative links and images between your files.
  - Code with syntax highlighting and line numbers; images.
  - ` ```mermaid ` blocks render as diagrams (PlantUML shows the code with a notice).
  - File paths in the chat, like `src/cli.ts:120`, are now links that open the preview at that line.
  - Reading is confined to the project folders you added: `..`, absolute paths outside the project and symlinks that escape it are refused.
- **Import from Claude Code:** `brito importar claude-code`.
  - It only shows what it would do; add `--aplicar` to write.
  - Skills come in as "trial" (3 clean uses promote them) and go through the safety lint; the ones with destructive commands wait in `/skills pending`.
  - Subagents (`.claude/agents` → `.brito/agents`) and `deny` permission rules come along. `allow` rules need `--incluir-allow`; the project memory needs `--memoria` (it becomes graph notes).
  - Credentials are never read. `--desfazer` reverts the skills and agents it created. `CLAUDE.md` was already read natively, and `.mcp.json` is reported but not imported (Brito does not connect to external MCP servers yet).
- **Measuring the automatic skills.** Each automatic skill now records which model wrote it (`by:` — `slm` for the local model, or the model id). `/skills stats` shows, per model, how many were created, promoted, still in trial or archived, and the promotion rate. Skills created before this version show as "(sem registro)".

### Changed
- The desktop app's content security policy now allows inline styles, because Mermaid's SVG needs them. Scripts stay restricted to the app's own files, and the Markdown renderer never emits raw HTML or inline styles.

### Notes
- The Mermaid library (~3.5 MB) now ships inside the desktop app.

## 0.9.0 — 2026-11-08

The desktop app gets a real interface (streaming, diffs, panels, the same resources as the terminal), and a new orchestrator mode: one model plans, another implements.

### Added
- Orchestrator mode (`/orquestrar on|off|modelo <profile>`): Claude plans (writing `spec/<feature>/spec.md` and `tasks.md` through the new `spec_save` tool and waiting for approval before delegating) and reviews, an endpoint profile (Qwen by default) implements each task through the new `implement` tool. The tool appends `git status`, `git diff --stat` and the output of the task's `verify` command. Works in API mode, in `claude` CLI mode (via the MCP server, with approvals in the terminal) and in the desktop app ("Implementa" picker). `BRITO_IMPL_MODEL` or `implModel` in the config pick the profile; `/orquestrar on --global` keeps the mode on across restarts (`orchestrator: true`).
- Streaming text with incremental rendering (no more flicker or lost selection), tool cards with diffs for `edit_file`/`write_file`, full tool output (up to 20000 chars), a subagent card and a pinned task list.
- Permission prompts show a colored diff and offer "allow for this session" and "always in this project" (remembered per folder in `~/.brito/desktop-allow.json`; plan/skill approvals always ask).
- Composer: `/` menu with commands and skills (manual skills run like in the terminal), `@` file autocomplete, drag files in, history with ↑/↓, Esc to interrupt, `/clear`, `/help`.
- Engine badge (cloud / endpoint / local) with a fallback warning, and endpoint profiles in the model picker.
- Panels for Skills (approve/reject/promote/remove), Agents, Code graph (search, callers/callees, reindex), Memory (notes) and Changed files.
- Ctrl/Cmd+K command palette, full-text search across sessions, light/dark/system theme, export conversation to markdown.
- Typed and versioned app ↔ backend protocol; the app warns when it and the CLI are out of sync.
- `npm run release <X.Y.Z>` prepares a release (clean tree, CHANGELOG, typecheck, tests, bump, tag). Pushing the tag builds the installers, creates the GitHub Release and publishes to npm (Trusted Publishing, no token).

### Fixed
- On Windows without Node.js the desktop app now says what is missing instead of failing with `ERR_DLOPEN_FAILED`.
- When the backend dies, the conversation says so and the next message reconnects and resumes.

## 0.8.0 — 2026-11-07

Cheaper and smarter turns with an Anthropic API key. Permission rules, and no more edits made from memory. Resume where you left off, and a visible task list.

### Added
- The local SLM is now the last fallback when Claude runs out (quota, rate limit, credit, auth, overload): chain Claude → `qwen` profile → SLM, so it also works for those without a `qwen` profile. It runs the full agent loop with tools (the model only asks for a call; permissions, hooks and "read before edit" apply as always), and `/model slm` uses it directly. The switch is temporary: after a window (the reset time the error reports, e.g. "resets 3pm", else 10 min, or 60 min for quota/auth; `BRITO_FALLBACK_MINUTES` overrides) the next turn tries Claude again and, if it still fails, falls back with a new window. `/fallback` shows when Claude will be retried. `BRITO_SLM_FALLBACK=off` removes the SLM from the chain; `BRITO_SLM_CTX` sets its context (default 16384). In `claude` CLI mode and in the desktop app the chain applies, but the way back to Claude is still `/model <claude>`.
- `digest` tool: "scout and refiner" for long texts. The local SLM walks a big file (the blocks most related to your objective), proposes excerpts and groups them into an outline; code then checks every quote against the source (OCR spacing and hyphenation are tolerated) and drops what is not there, so the main model receives a small markdown draft with verified quotes and page numbers. Needs `brito slm pull`. On a 757 KB book it analyzed 8 of 220 blocks in ~40 s and produced a 4 KB draft (12 of 17 proposed quotes verified). Cover, flap blurbs, table of contents and copyright pages of long page-marked books are skipped automatically.

- Embedded local SLM (llama.cpp through the optional `node-llama-cpp` dependency, default Qwen3-4B-Instruct-2507 Q4_K_M, Apache-2.0). `brito slm` shows status, `brito slm pull` downloads the model to `~/.brito/models` (explicit and resumable), `brito slm rm` deletes it. Once downloaded, the skill-learning reflection runs locally with grammar-constrained JSON output and falls back to the usual model on any failure. `BRITO_SLM=off` disables it; `BRITO_SLM_MODEL` points to another GGUF (`hf:` URI or file path).

- Built-in manual skills, run with `/grill-me`, `/grill-with-docs`, `/wayfinder` and `/grill-diff` (Tab completes them; `--um` asks one question per message). `grill-me` interviews you in rounds until the idea is firm, using the graph to avoid asking what the code already answers; `grill-with-docs` also saves each decision with `remember`; `wayfinder` maps big work into parts and delegates; `grill-diff` questions the current diff using `graph_impact`. A skill with the same name in `.brito/skills` overrides the built-in.
- Skill frontmatter `invoke: manual` (only runs via `/name`, kept out of the prompt index) and `model:` (recommended model, shown by `skill_load` and `/skills`). Both are accepted by `skill_save`.
- `/skills suggest <task>` ranks skills (built-ins included) by relevance; `skill_load` with an unknown name returns similar skills.
- Skills remember what went wrong on their last failed turn (`lastLoss`), shown in `/skills`, `skill_load` and the learning step.
- Quality hints when saving a skill: body over 3000 chars (split it) or no verification/exit criterion.

- Permission rules in `.brito/settings.json`, `.brito/settings.local.json` or `~/.brito/settings.json`: `allow` skips the prompt for matching commands or paths (e.g. `bash(npm test:*)`, `edit_file(src/**)`), `deny` blocks them in every mode, including "everything allowed". A compound command is allowed only if every piece matches, and commands with `$(...)`, backticks or file redirection are never allowed by a rule. The rules also apply to the `claude` CLI's Bash, Edit and Write.
- `/permissions` lists the rules; `/permissions allow <rule>` and `/permissions deny <rule>` add one to the project settings.
- Sessions are saved per project in `.brito/sessions/` (git-ignored). `brito -c` resumes the most recent one and `brito --resume <id>` a specific one (the first characters of the id are enough); `brito sessions` and `/sessions` list them. In API mode Brito keeps the whole history; in `claude` CLI mode it keeps the session id and resumes through the CLI. A session reopens in the engine that recorded it. Attached images are not written to disk.
- The desktop app now really resumes API-mode conversations when it reopens (it used to show them while the model started over).
- `todo_write` tool: on multi-step tasks the agent keeps a task list, shown under the tool line in the terminal, in the desktop app and with `/todos`. It is saved with the session. Subagents cannot change it.

### Changed
- The skill index in the system prompt lists the 25 top-ranked skills (was 40) and says how many were left out.
- The conversation is now prompt-cached, not only the system prompt. Each step of a multi-tool turn reads the earlier history from cache instead of paying for it again.
- The system prompt stays byte-identical during a session. It is rebuilt only when plan mode toggles, the graph stops being empty or the set of skills changes, so a graph sync or a skill being used no longer invalidates the cache.
- `/reasoning` now applies to the Anthropic API (it used to affect only the `claude` CLI and OpenAI-compatible endpoints): the level is sent as `output_config.effort`. `none` turns thinking off where the model allows it (`between_tools` on Sonnet 5.5) and becomes effort `low` on models whose thinking cannot be disabled (Opus 5.5, Fable).
- Responses from Claude can be up to 32k tokens (was 8192), so a large `write_file` is no longer cut off. Requests always stream.
- `edit_file` and `write_file` refuse to change an existing file that was not read in the session, or that changed since it was read (by a command, by you or by another process). The model is told to read it again; the check runs before the approval prompt, so you are not asked to approve an edit that would fail.
- `/clear` starts a new session; the previous one stays saved.

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
