# What Tandem does, piece by piece

This describes the app as the code builds it today. It was written by reading the source, not by running every feature.

## The big picture

Tandem is a desktop app (Electron, Windows) that wraps a small local web server and a browser UI.

- You open a project folder.
- You start one or more AI coding agents on it: Claude Code, Codex, Gemini CLI, or a chat-only API model.
- The agents do the real work through their own command-line tools. Tandem drives them, shows what they do, keeps them apart, teaches you as they go, and makes you approve changes before they leave your machine.

```
Electron window  ->  local server (127.0.0.1:4317)  ->  agent CLIs (claude, codex, gemini)
   (text UI)          (workspace, learning, review,        working in git worktrees
                       push, launcher, structure)           inside your project
```

## 1. Desktop shell (`desktop/main.cjs`)

- Starts the local server inside the app, then opens a window onto it.
- Creates `Documents/Tandem Workspace` as the default folder.
- Only two pop-out windows are allowed: the Review window and a subagent's chat. Any other link opens in your normal browser.

## 2. Local server and its safety rules (`server/app/`)

- Listens on `127.0.0.1` only. It checks the Host and Origin of every request.
- The live connection needs a random token created at each launch.
- Agents can only start the known CLIs. Agent processes do not receive your API keys.
- The server serves the built UI, takes image uploads, answers the live connection, and offers a small job API that main agents use to start subagents.
- It re-reads the git state of the open repository every few seconds.

## 3. The screen (`index.html`, `src/`)

The UI is text first and uses system fonts only. Nothing 3D and no editor code is downloaded until you open those views.

- **Top bar:** it is also the window's title bar in the desktop app (Windows draws its own minimise, maximise and close buttons over its right end). Menus: File (open project, push, notes, export, settings), Edit (undo, cut, copy, paste; they act on the text field you were in), View (Team and each side-panel view, planets, sidebar, reload), Agents (add, connect, agent browser, stop all, learning mode, learn profile, journal, demo), Help (set up, shortcuts). On the right: Review, Code, VS Code, Terminal and Activity, the connection light and Settings.
- **Left: the sidebar.** The project card, Team, then two sections that fold away: Agents (one row each, with its state) and Files, a file explorer of the repository or any agent's worktree. Files with uncommitted changes are marked; the tree reads open folders again when git sees a change. Clicking a file opens it in the Code view; choosing a folder there also points VS Code at it. `Ctrl+\` hides the sidebar.
- **Middle: the selected agent's chat**, in one centred column. An empty chat shows a greeting with the message box in the middle of the page; once there are messages the box stays at the bottom. The permission mode, Find, New chat and History sit in a slim bar on top; the model and reasoning effort are in the message box.
- **Right: an optional side panel**, closed by default, showing one of three views. Drag its edge to resize it.
  - **Code** (`Ctrl+B`): see section 11.
  - **Activity**: usage, limits, what the agents are doing, the project's git state and the log.
  - **Planets**: the 3D "system". The sun is your repository and each agent is a planet (rings for context and usage, a shield for the permission mode, moons for running tools and subagents). It is off by default, loads three.js only when first opened, and stops drawing whenever it is not on screen. **Eco** lowers its frame rate and effects.

## 3b. The Team chat (`server/team.mjs`, `src/team.js`)

- **Team**, at the top of the sidebar (`Alt+0`), is the screen Tandem starts on and one place to hand out work. You describe a task; Tandem picks the agent and the model, sends the task to that agent's own chat, and shows who got it, why, and how it ended.
- **A dispatcher agent decides** (`server/team-dispatch.mjs`). It is the cheapest model among your agents that answers (a chat-only API model first, then Claude, Codex, Antigravity, each on its light model), run once per task outside the agents' chats, in an empty temp folder. It is given a guide you can edit in Settings → Team, plus the live team (who is free, each model and its size), and replies with one JSON choice: agent, model, size and a one-line reason. Tandem checks that choice against the real team before using it. Measured here: about 8 seconds on Codex's cheapest model.
- If the dispatcher cannot answer, picks someone who is no longer free, or you chose both the agent and the size yourself, **Tandem's built-in rules decide instead**, and the card says which of the two chose. Settings → Team can also switch to rules only, or pin one agent as dispatcher.
- The rules are plain code, not a model, so they cost no tokens. A task is sized **light**, **standard** or **heavy** from what it asks for (a typo or a question is light; a refactor, a design or a long brief is heavy). Each agent's models are sized from their names and the provider's own descriptions (Haiku, Flash, Luna: light; Sonnet, Hydrogen, Sol: standard; Opus, Argon, Astra: heavy), and the task gets the matching one.
- Only agents that are free are considered; chat-only API models are not given tasks that change files; ties go to the agent that has done less. You can overrule both choices (who, and what size) next to the message box.
- It sets the chosen model on that agent, so the agent keeps it until the next assignment or until you change it. It never changes an agent's permission mode: a read-only agent proposes instead of editing, and the card says so.
- One task goes to one agent. It does not split a task between agents or merge their work; each still works in its own folder. The list is kept per project in this browser.

## 4. Agents (`server/agents/`)

- **Claude Code:** one live process, using its JSON stream. Modes are Ask, Plan, Edit and Auto.
- **Codex:** one process per turn. It reads Codex's own session files for context size and limits, and uses a read-only or edit sandbox.
- **Gemini CLI:** one process per turn, with a task passed on standard input.
- **API models:** any Chat Completions-compatible endpoint. They are chat-only, with no file or shell tools. The key comes from a named environment variable, never from the UI.
- All of them are turned into one event stream: messages, tool calls, approvals and results. Tool calls are labelled read, search, shell, edit, web and so on, so the UI looks the same for every agent.
- **Codex** runs in its own Windows sandbox: Read-only can write nothing; Edit can write only in its folder (and temp) and has the network on, so package installs work. **Antigravity** has no usable sandbox: in Edit it runs commands without asking, with your full rights. **Claude Code** and **Gemini** rely on their permission prompts.
- Full access (no sandbox) exists for Codex and Gemini. It is off unless you switch it on in Settings and then confirm per agent.

## 4b. Tandem tools for agents (`server/tools/`, `scripts/tandem-tools-mcp.mjs`, `desktop/browser.cjs`)

- Claude Code and Codex are started with a `tandem` MCP server (a small stdio script that calls the local `/api/tools` endpoint with the conversation key). Claude gets it through `--mcp-config`, Codex through `-c mcp_servers.tandem...` overrides, including `default_tools_approval_mode="approve"` because `codex exec` cannot ask and otherwise refuses every MCP call. Gemini and API agents do not get it yet.
- Tools: `project_commands`, `run_script`, `dev_server_start/status/stop` (only scripts named in package.json, run in the agent's worktree, output capped), `web_search` (keyless, via DuckDuckGo's HTML results), `download_asset` (http/https only, inside the agent's folder, 50 MB cap, no overwrite unless asked; refused in read-only modes), and `browser_open/snapshot/click/type/screenshot/console/close`.
- The browser is one Electron window per agent with its own in-memory session, http/https only, no downloads or permission prompts, driven with DevTools-protocol input. A plain `node server` run has no browser and says so.
- `run_script` and `dev_server_start` are refused when the agent is in a read-only mode (Claude/Gemini plan, Codex read-only), because these tools run outside the CLI's own sandbox. Settings → Subagents turns the tools off.
- Not yet checked against a real Codex or Claude model run: the launch arguments are tested with protocol fixtures only.

## 5. Subagents (`server/children.mjs`, `scripts/tandem-job.mjs`)

- A main agent can start a child chat with a small command (`tandem-job`) using a key made for that conversation.
- The child gets its own worktree and model. It can open in its own window, and the main agent is told when it finishes.
- Children get the standing prompt and project context, but not the learner profile.

## 6. Worktrees and project context (`server/worktrees.mjs`, `project-context.mjs`)

- Each CLI agent works in its own git worktree and branch under `.tandem/worktrees`. Work is never merged or deleted automatically.
- `.tandem/PROJECT_CONTEXT.md` is created in every project. Every agent receives it.
- The standing prompt every agent gets is built from three things: your global prompt, the project context, and, for main agents in learning mode, your learner profile.

## 7. Chats and history (`server/workspace/`)

- A workspace is the open repository plus the main agents in it, up to eight.
- Every chat is saved under `.tandem/conversations` and can be reopened from **history**. Each repository keeps its own chats, so switching away and back finds them.
- CLI chats resume from that CLI's own thread history.
- You can attach up to four images (10 MB each).

## 8. Learning mode (`server/learning/`)

- **Learner profile.** It records your stack, goals, level, and how you like things explained. It also counts which technologies you work with, from your messages and the files agents edit. A technology becomes "known" after it comes up three times. It can also detect the stack from the repository.
- **The checkpoint cycle.** Main agents go through four stages:
  1. **Build:** the agent questions and challenges you, one question at a time, your approach first. It may not code, and it may not decide for you. If you say "you decide" or "think of it yourself", Tandem adds a note to your message so the agent refuses it, and counts it as a habit.
  2. **Design:** a design is put to you.
  3. **Implement:** it starts only after the agent has written `READY TO BUILD: <the clear answer>` (it must be satisfied: goal, constraints and approach agreed, specific answers from you, an edge case tested, no open question) and you have pressed **Approve & implement**. Anything new you say takes its "ready" back, so it has to be satisfied again.
  4. **Report:** the step is summarised.
- The app enforces the lock. A locked agent stays read-only and is refused the exit from planning until it is satisfied and you approve. The prompt does not carry that rule.
- **TODO mode** (`server/learning/todo.mjs`). A switch next to learning mode. After you approve a step the agent builds the scaffold (structure, types, wiring, runnable tests) and leaves `TODO(you)` markers with throwing stubs where the logic belongs; the logic is yours. Tandem scans the agent's worktree with `git grep` and keeps a checklist: each item shows the hint and `file:line`, opens that block in VS Code when clicked, and ticks itself when the marker is gone. **Check my work** asks the agent to review what you wrote and give hints only. "Write it for me" and "just give me the answer" get a note that makes the agent refuse. If a step ends with no markers at all, Tandem says the agent may have written the logic itself.
- **What it learns about you** (`server/learning/understanding.mjs`). Agents end a message with a `## Learner notes` block: `skill: React = familiar (evidence)` and `behavior: ...`. Tandem files these, counts habits itself (messages, very short answers, handing the decision back, asking to hurry), saves them, and puts them in every agent's prompt so each one adjusts how hard it pushes. The profile dialog cannot overwrite them.
- **Documents it writes:**
  - `learning.md`: what was built, explained at your level.
  - `learningcontext.md`: how to teach you, shared by every agent.
  - `LEARNING.md`: a journal with one entry per approved step.

## 9. Review and limits (`server/review/`)

- A "batch" is everything an agent has changed since you last approved. Tandem snapshots the folder with git, without touching your index or branch, so counts are the same for every agent.
- The **budget** (default 300 lines, 10 files) is told to the agent: split big work and stop after each part. A job that ends over budget holds that agent's next task until you approve.
- The **cutoff** (25% above the budget) stops a runaway agent. Both can be switched off for unattended runs.
- **Review** (`Ctrl+R`) is a screen in the side panel, the same for every coding agent. Left: each agent with its changed files, line counts, how full its batch is, and Approve / Approve & continue. Right: what the agent said it did to the chosen file, then the diff with line numbers. **Ask…** sends a piece of the diff to the agent with your question; **Suggest an edit…** sends your own version; **Open file** shows the file in the Code view. It never writes to an agent's folder.
- A finished task in the Team chat lists what that agent now has waiting for review; each file there opens its diff in this screen.

## 10. Push (`server/gitpush.mjs`)

- A dialog lists changed files. You choose what to commit, write the message, and edit the branch name.
- Pushes only go to `tandem/...` branches, and never by force. Files that look private (`.env`, keys) start unticked.

## 11. The code view (`src/code.js`, `src/editor.js`, `server/inspect.mjs`)

- A file tree, tabs and an editor (CodeMirror 6, with VS Code's dark colours) in the side panel. It browses the repository or one agent's own worktree, skipping `.git`, `.tandem`, `node_modules` and the like.
- Text files up to 256 KB can be edited and saved (`Ctrl+S`). Only an existing file inside the chosen folder can be written, and a save is refused if the file changed on disk since it was opened, so an agent's newer edit is never overwritten. A tab with no unsaved edits is read again when you return to it.
- **Changes** lists the repository's uncommitted files; **Diff** opens the folder's git diff as a read-only tab.
- **Add to chat** puts the file, or the selected lines, in the selected agent's message box. **VS Code** opens the file there at the cursor line.
- It is an editor, not VS Code: VS Code extensions do not run in it. Use the VS Code button when you need them.

## 12. VS Code, the terminal and the agent browser (`server/vscode.mjs`, `src/vscode.js`, `server/launcher.mjs`)

- **VS Code panel** (`Ctrl+E`): the VS Code installed on this computer, running inside Tandem's side panel. Tandem starts `code serve-web` on a random local port the first time the panel is opened and passes it through its own address under `/vscode`, so the editor shares Tandem's origin (VS Code refuses to be framed by any other). It opens the repository or one agent's worktree.
- Starting it accepts Microsoft's VS Code Server license terms, so the panel asks first, once. The first start downloads VS Code's server component (about 245 MB, kept under `~/.vscode/cli`). The connection token is made once and kept in Tandem's data folder.
- Extensions are installed from the Extensions view inside the panel and are separate from the desktop app's. Extensions that only change the desktop window, and extension webviews, were not checked.
- **Terminal** (`Ctrl+\``) shows VS Code's own terminal inside the panel. VS Code asks whether to trust the folder before it runs commands. Before the embedded editor has been agreed to, the button still opens a terminal window.
- **Desktop app** in the panel's bar opens the same folder in the desktop VS Code. **Stop** ends the embedded editor and frees its memory; it also stops when Tandem quits.
- The agent browser is still a window per agent.
- The folder always comes from Tandem's own list of work folders.

## 13. Setup and connecting (`server/connect.mjs`, `repos.mjs`, `folders.mjs`)

- The **Workspace** dialog opens a folder, lists recent repositories, clones from a URL, or lists your GitHub repositories through the `gh` login.
- **Connect agents** checks what is installed, installs a CLI with npm, and opens a real terminal window at its sign-in. Package names and commands come from a fixed list.
- A first-run **Set up** walkthrough covers all of this.

## 14. Structure standardizer (`server/structure/`)

- Off by default. It only works on projects cloned or created in Tandem.
- It splits large JS/TS, Python, CMake and PowerShell files into smaller component files on a new git worktree and branch. Each original file re-exports its pieces.
- It is plain code with no model involved, and it never changes your files in place.

## 15. Settings

- Review and limits, learning mode, subagent behaviour and the full-access switch, structure, saved text (global prompt, notes, export), and appearance (the planet view and Eco).

## 16. Extras

- **Demo:** replays a scripted session with no quota used.
- **Sky** (in the planet view): sends a ship, meteor, comet or asteroid through the scene.
- **Stop all:** stops every running agent session.

## 17. What is stored, and where

- In your project: `.tandem/PROJECT_CONTEXT.md`, `.tandem/conversations/`, `.tandem/worktrees/`, `.tandem/learning/`, and `LEARNING.md`.
- In Tandem's data folder: the workspace settings, saved profile, recent repositories, and other chats.
- Chats, notes and uploads stay on your machine. Requests still go to whichever provider an agent uses.

## Open questions I could not settle from the code

- Whether Gemini is a full peer in the 3D scene and info panel. Those views only name Claude and Codex, and Gemini does not get Tandem's tools yet.
- Whether the Demo and Sky buttons belong in a release.
- The redesigned UI was checked in a browser against the dev server (chat, code view, activity, planets, settings), not in the packaged desktop app.
