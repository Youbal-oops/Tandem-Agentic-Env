# Tandem

A planned local environment for two coding agents to collaborate on one codebase through bounded, delegated jobs.

## Status

As of **2026-10-01**, Tandem has a first working **local cockpit** (see "Running Tandem" below): a chat interface for Claude Code and Codex CLI, shown as two planets orbiting a star that stands for the codebase. Delegation between the agents, a git worktree per job and session export to the site are still **planned, not built**. The repository folder is `Tandem-Agentic-Env`.

## Running Tandem

```powershell
npm install
npm run dev      # API on 127.0.0.1:4317, UI on http://localhost:5173
```

`npm start` builds the UI and serves it from the API alone at http://127.0.0.1:4317. Opening `index.html` directly will not work; the server runs the agents.

**Layout.** Left: the two agents as rows (number, name, activity graph, state) with a terminal-style chat under each. Middle: the system. Right: instruments and project info (context, usage limits, session stats, tool mix, sub-agents, plan, MCP servers, files edited, git branch, changed files, commits, and a live log). Bottom: a flap-style work board. Click a planet, press **Alt+1 / Alt+2**, or click an agent row, and the camera follows that planet along its orbit (the planet spins and the camera drifts around it) while its chat takes over the left column. **Esc** returns to the overview with both chats visible.

**The planets are instruments.** The star is the repo (name, branch, changed files).

| On the planet | Means |
| --- | --- |
| Inner HUD ring | Context window used. Turns amber past 60% and red past 85% |
| Outer thin ring | 5-hour usage limit used (7-day shown in the right column) |
| Lattice shield | Permission mode: cyan read-only or plan, amber ask, green edit, violet auto |
| Small moons | One per running tool, coloured by kind: read, search, shell, edit, web, MCP |
| Large bright moons | Sub-agents |
| Debris belt | Every tool call this session, coloured by kind |
| Beads on a ring | The agent's plan: done, active, to do |
| Far satellites | MCP servers (green connected, amber pending, red needs sign-in) |
| Expanding pulses | The agent is thinking |
| Beacon | Waiting for your approval |
| Red flare, white shockwave | An error, or the context was compacted |
| Atmosphere thickness | Prompt-cache hit rate |

When an agent edits a file, a packet of light flies from its planet into the star. **→ Codex / → Claude** under a reply drafts a review request in the other agent's box and sends a comet between the planets. Ships, meteors, comets and asteroids pass through the sky now and then (**Alt+K** triggers one). If the GPU struggles, the renderer lowers its resolution and then turns off bloom by itself.

**Where the numbers come from.** Claude reports its own token counts, context window, cache hits, usage windows and MCP servers in its event stream. Codex's context size and usage limits come from the `token_count` records in its local session files under `~/.codex/sessions`; only those lines are read, never the conversation.

**The chat.** Replies stream as markdown, tool calls are lines you can open, and the prompt line sends with Enter. Each agent has a permission mode:

| Agent | Modes |
| --- | --- |
| Claude | **Ask** (approve each change with buttons), **Plan** (read-only), **Edit** (files freely, asks for other actions), **Auto** (Claude's own risk classifier) |
| Codex | **Read-only**, **Edit** (workspace-write sandbox). Codex cannot ask mid-task in this mode, so choose before sending |

**Under the hood.** Claude runs as one live `claude -p --input-format stream-json` process, so context carries across turns and approvals are answered over its control channel. Codex runs `codex exec --json` once per message and continues the conversation with `codex exec resume`. Neither uses a terminal emulator.

**Settings.** `TANDEM_CWD` sets the folder the agents work in (default: this repo). `TANDEM_CLAUDE_MODEL` pins Claude's model, for example `haiku` to spend less. Add `?demo` to the URL, or press **Alt+D**, to replay a scripted session that touches neither CLI.

**Security.** Bound to `127.0.0.1`; Host and Origin are checked; the WebSocket needs a per-launch token; only the two known CLIs can be started, never a shell; `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and similar variables are removed from the agents' environment so they stay on your subscriptions. Do not expose the port to a network.

## Goal

Let a user work with one primary agent that coordinates a second agent on the same codebase. Both use existing $20 subscriptions—Claude Pro and ChatGPT Plus—with no API keys or API billing.

Claude runs through Claude Code CLI with a Claude Pro login. ChatGPT's coding agent runs through Codex CLI with a ChatGPT login, rather than through the chat app. How primary and sub roles can be swapped remains undecided.

Live coordination, task state, and job records stay local. After a session, a record containing the summary, decisions, changes, unresolved questions, and commit links is pushed to the owner's personal site. The site serves as an archive and durable memory, avoiding the latency and token overhead of using it as a live coordination channel.

## How it works

The user talks to the primary CLI session. The primary plans, splits work, delegates, reviews, and merges. The sub runs as a bounded job, returns a diff and summary, and does not talk to the user directly. After coordination, both agents can work in parallel on separate parts.

Each job gets its own git worktree and branch; agents never share a working directory. Jobs run for minutes and are polled by job ID because the models have no shared live context. Each job has a capped subscription quota budget.

Planned job lifecycle:

1. The primary writes a task spec: goal, files in scope, branch/worktree, acceptance checks, and limits.
2. The sub CLI starts non-interactively in a fresh worktree.
3. The sub works and logs progress locally.
4. The sub returns status, diff, summary, test output, and questions.
5. The primary reviews and either merges, requests changes through a new job, or discards the result.
6. A short handoff note is recorded locally.

## Architecture

```text
User
  |
Primary agent CLI -- delegated task --> Sub agent CLI
  |                                     |
  | reviews and merges                  | own branch/worktree per job
  <----------- diff + summary -----------+
  |
Local job records and logs
  |
Post-session export --> Personal site archive
```

`CLAUDE.md` and `AGENTS.md` are planned to point to one shared conventions file.

An optional Phase 3 hub would be a localhost-only service that starts each CLI as a subprocess, tracks jobs, enforces limits, and stores results. The primary remains responsible for review and merging.

## Non-goals

- API billing or a pay-per-token fallback.
- Scraping `claude.ai` or `chatgpt.com`.
- Reusing subscription login tokens in a custom HTTP client.
- Free-running agent-to-agent chat; collaboration uses bounded jobs.
- Network exposure; any hub stays localhost-only.
- Automatic merging by the hub.

## Tooling on the dev machine

Recorded on 2026-10-01:

| Tool | Version |
| --- | --- |
| Windows | 10 Pro |
| Git | 2.56 |
| Python | 3.13.15 |
| uv | 0.12.21 |
| Node | 24.19.0 |
| npm | 11.17 |
| GitHub CLI | 2.102 |
| Claude Code | 2.1.286 |
| Codex CLI | 0.159.3 |

## Open questions

- What is the first project for the pair?
- Which interface, stack, and language should Tandem use: web, desktop, or terminal?
- Should Codex ever be primary, and should roles be chosen per session or per task?
- Should session export to the site be automatic or manual?
- How does the Codex sandbox behave on native Windows, and is WSL needed?
- What are the current quota limits on both subscription plans?
- Is `claude mcp serve` sufficient for delegation? The command exists but is untested.
- How much of the planned workflow does the Codex plugin cover?

## Next steps

1. ~~Complete user logins for `gh`, `claude`, and `codex`.~~ **Done.**
2. ~~Create the Tandem GitHub repository and connect the local folder.~~ **Done.** `origin` is `yuvaava7-ops/Tandem-Agentic-Env`.
3. ~~Install the Codex plugin in Claude Code and run `/codex:setup`.~~ **Done.**
4. Pick the first project and write `CLAUDE.md` and `AGENTS.md`, pointing to shared conventions.
5. Test a delegation in its own git worktree and branch, then record the result. The first delegation (this README, written by Codex) ran in the main folder, so worktree separation is still untested.
