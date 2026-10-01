# Tandem

A planned local environment for two coding agents to collaborate on one codebase through bounded, delegated jobs.

## Status

As of **2026-10-01**, Tandem is at the **planning stage**. The development machine is set up, but **no Tandem code has been written yet**. The repository folder is `Tandem-Agentic-Env`.

Phase 1 uses Claude as primary and Codex as sub through the official Codex plugin in Claude Code, with no custom code. Role swapping and a local hub are later phases, only if needed.

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
