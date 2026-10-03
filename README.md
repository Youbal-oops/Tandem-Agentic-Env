# Tandem

A planned local environment for two coding agents to collaborate on one codebase through bounded, delegated jobs.

## Status

As of **2026-10-01**, Tandem has a first working **local cockpit** (see "Running Tandem" below): a chat interface for Claude Code and Codex CLI, shown as planets orbiting a star that stands for the selected codebase. Repo switching, additional CLI/API planets, reasoning controls, chat filters, local persistence, export and an Eco mode are implemented. Delegation between the agents, a git worktree per job and session export to the site are still **planned, not built**. The repository folder is `Tandem-Agentic-Env`.

## Running Tandem

### Taking it to a Windows laptop

Copy the updated project (or commit and push these changes before cloning), install Node.js 22.12+ and the Claude Code / Codex CLIs, and log into each CLI on that laptop. Double-click `start-tandem.cmd`; it installs dependencies if needed, builds the UI and runs the local server. Open http://127.0.0.1:4317. In PowerShell you can also use `npm.cmd ci` then `npm.cmd start`.

Click the **sun** or **Workspace**, then **Browse…** to navigate local folders. The picker includes Home, drives, parent navigation, folder filtering and Git repository badges. Choose **Use this folder**, then **Open workspace**; you can also enter a path directly. Stop agents before switching. Old chats are archived under `.tandem/archives`; conversations start fresh in the new repo, with model, effort and permission settings retained.

Workspace settings have separate **Local folder**, **Clone repository** and **Agents** tabs. Chat controls use labeled Model and Reasoning selectors. The top toolbar's **More** menu contains export, Stop all, Eco mode, sky effects and panel visibility.

**Clone a repository** in the same dialog supports a public HTTPS repository link (or GitHub `owner/repo` shorthand), or **My GitHub account**. The account picker uses the GitHub CLI login on the machine running Tandem, and includes accessible personal, collaborator and organization repositories with public/private labels, filtering and pagination. Install Git and GitHub CLI; sign in using `gh auth login` if needed. A GitHub connection in the chat application does not automatically sign in the laptop's GitHub CLI.

Choose a full path to a **new** local clone folder; its parent must exist. Existing destinations are never overwritten. Clone progress appears in the dialog. Successful clones become the working repo; failed clones leave the current repo selected and preserve any partial destination for inspection. Sending agent tasks and starting another repo switch are blocked during cloning. Account cloning uses [GitHub CLI's repository clone command](https://cli.github.com/manual/gh_repo_clone); public links use Git directly. No dependencies or repository scripts are run automatically.

**System** / **Esc** returns to a top-down view of all planets. Select a planet or an agent row to open its chat. Add up to eight independent planets through **Repo / Agents**: additional Claude Code or Codex CLI sessions, or a Chat Completions-compatible API. Each has its own thread, model and effort controls. Light means low reasoning effort; the available effort levels depend on the chosen model. Codex offers its configured default, models from its local model cache when available, and a custom model name; Claude offers opus, sonnet and haiku aliases plus a custom name.

API planets are **chat assistants without local file or shell tools**. Give the full endpoint (for example `https://api.openai.com/v1/chat/completions`, or a localhost model server), model name and the **name** of a server environment variable containing the API key. Set that variable in the terminal before launching Tandem. Never enter the key itself in the UI. Hosted API requests use the provider's API billing. Claude CLI and Codex CLI continue using their CLI logins. APIs must implement the Chat Completions response shape; API replies currently appear when the response completes. The endpoint contract follows the [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create); Codex effort maps to `model_reasoning_effort` in the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Chats, CLI thread IDs, planet definitions and preferences save locally to the ignored `.tandem/workspace.json` and reload on restart. CLI continuation also needs the CLI's own history on that machine; copying `.tandem` alone does not migrate CLI sessions. **Export** downloads a Markdown conversation record, including tool summaries. Search and filter each chat by messages, tools or thinking. **Eco** reduces rendering resolution and disables bloom and sky events, and remembers the setting. The **Theme** item in the More menu switches between the Solar System and the lightweight 2D Sunset Cats train interior; `?theme=space` and `?theme=forest` provide direct links. **Lite** (More menu, or open the UI with `?lite=1`; `?lite=0` turns it off) is text only: the 3D scene, WebGL and animations are never loaded. Agents are picked from the list instead of the planets, and the setting is remembered.

All coding planets share the selected repo. Isolated worktrees, automatic delegation and merging remain planned. Use separate file scopes when running agents concurrently. API chats receive pasted text and the repository path, with no automatic upload of repository files.

The **Sunset Cats** theme currently shows the sunset train background with drifting clouds. The imported cat model has been removed; custom Blender characters and animations are planned. The background pauses in hidden tabs and respects reduced-motion preferences.

### Local work tools

- **Files / Diff** browses the selected repository and previews UTF-8 text files up to 256 KB. Switch to Git diff to inspect staged, unstaged, or combined changes since the last commit. Previews are read-only; **Add to chat draft** puts the selected file or diff into an agent's composer for you to edit and send. Untracked files appear in Files. Generated directories and Git metadata are omitted from browsing; links pointing outside the repo cannot be read.
- **Prompt** is a global instruction set once and stored in `.tandem/workspace.json` (set it again on another computer). It is sent to every agent (Claude, Codex, API planets and subagent chats) with the first message of each session, and again after a repository switch, a new chat or an edit. `{{repo}}`, `{{path}}` and `{{agent}}` are filled in each time, so a prompt such as "check my site for context on {{repo}}" follows whichever repo is open.
- **Notes** saves goals, decisions and next steps separately for each repository inside `.tandem/workspace.json`. Use **Save notes** or Ctrl+S in the notes editor. Unsaved notes drafts survive a page refresh in the same browser tab. Notes are never automatically sent to an agent or synced to the site.
- **Recent repositories** in the sun's workspace dialog keeps the last twelve folders for quick switching. Switching still requires idle agents and archives the current conversation.
- **Stop all** stops every CLI session and in-flight API reply, keeping the chat history. It does not cancel a repository clone.

These tools and their stored data stay on your computer. Model requests and GitHub/clone operations still use their configured providers and network connections.

```powershell
npm install
npm run dev      # API on 127.0.0.1:4317, UI on http://localhost:5173
```

`npm start` builds the UI and serves it from the API alone at http://127.0.0.1:4317. Opening `index.html` directly will not work; the server runs the agents.

**Layout.** Left: the two agents as rows (number, name, activity graph, state) with a terminal-style chat under each. Middle: the system. Right: instruments and project info (context, usage limits, session stats, tool mix, sub-agents, plan, MCP servers, files edited, git branch, changed files, commits, and a live log). Bottom: a flap-style work board. Click a planet, press **Alt+1 / Alt+2**, or click an agent row, and the camera follows that planet along its orbit (the planet spins and the camera drifts around it) while its chat takes over the left column. **Esc** returns to the top-down system overview with the agent roster visible.

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
- Implemented interface: a local Vite web UI with a Node server; desktop packaging remains optional.
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
