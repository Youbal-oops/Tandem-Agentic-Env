# What Tandem does, piece by piece

This describes the app as the code builds it today. It was written by reading the source, not by running every feature.

## The big picture

Tandem is a desktop app (Electron, Windows) that wraps a small local web server and a browser UI.

- You open a project folder.
- You start one or more AI coding agents on it: Claude Code, Codex, Gemini CLI, or a chat-only API model.
- The agents do the real work through their own command-line tools. Tandem drives them, shows what they do, keeps them apart, teaches you as they go, and makes you approve changes before they leave your machine.

```
Electron window  ->  local server (127.0.0.1:4317)  ->  agent CLIs (claude, codex, gemini)
   (UI, 3D scene)     (workspace, learning, review,        working in git worktrees
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

- **Centre: a 3D "system".** The sun is your repository. Each main agent is a planet.
  - Rings show how full the context window is and how much of the usage limit is used.
  - A shield shows the permission mode.
  - Small moons are running tools, and large moons are subagents.
  - Edits fly into the sun as light, and flares mark errors and approval requests.
- **Left: the agent chats.** Each has its own message box, model picker, effort, and mode.
- **Right: the info panel.** It shows usage, what the agents are doing, and the project's git state.
- **Top bar:** System, Workspace, Set up, Files/Diff, Review, Terminal, Editor, Push, Connect agents, Settings, Learn profile, Learning journal, Prompt, Notes, Export conversations, Stop all, Lite, Eco, Demo, Sky, Hide panels.
- **Lite** turns the 3D scene off. **Eco** lowers the frame rate and effects.

## 4. Agents (`server/agents/`)

- **Claude Code:** one live process, using its JSON stream. Modes are Ask, Plan, Edit and Auto.
- **Codex:** one process per turn. It reads Codex's own session files for context size and limits, and uses a read-only or edit sandbox.
- **Gemini CLI:** one process per turn, with a task passed on standard input.
- **API models:** any Chat Completions-compatible endpoint. They are chat-only, with no file or shell tools. The key comes from a named environment variable, never from the UI.
- All of them are turned into one event stream: messages, tool calls, approvals and results. Tool calls are labelled read, search, shell, edit, web and so on, so the UI looks the same for every agent.
- Full access (no sandbox) exists for Codex and Gemini. It is off unless you switch it on in Settings and then confirm per agent.

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
- The Review window shows each change with the agent's own note. If you edit a hunk or ask about it, the agent receives that as a message. The window never writes to the agent's folder.

## 10. Push (`server/gitpush.mjs`)

- A dialog lists changed files. You choose what to commit, write the message, and edit the branch name.
- Pushes only go to `tandem/...` branches, and never by force. Files that look private (`.env`, keys) start unticked.

## 11. Files and Diff (`server/inspect.mjs`)

- Browse the repository (skipping `.git`, `.tandem`, `node_modules` and the like), read files up to 256 KB, and see the git diff.
- You can add a file to the chat draft.

## 12. Terminal and editor (`server/launcher.mjs`)

- **Terminal** opens your real terminal window (Windows Terminal if installed, otherwise PowerShell) in the selected agent's worktree, or in the repository when no agent is selected. There is no built-in terminal.
- **Editor** opens that same folder in VS Code. If VS Code is not found it opens the folder in the default app. **Open in editor** in Files / Diff opens a single file.
- The folder always comes from Tandem's own list of work folders, and a file must be inside it.

## 13. Setup and connecting (`server/connect.mjs`, `repos.mjs`, `folders.mjs`)

- The **Workspace** dialog opens a folder, lists recent repositories, clones from a URL, or lists your GitHub repositories through the `gh` login.
- **Connect agents** checks what is installed, installs a CLI with npm, and opens a real terminal window at its sign-in. Package names and commands come from a fixed list.
- A first-run **Set up** walkthrough covers all of this.

## 14. Structure standardizer (`server/structure/`)

- Off by default. It only works on projects cloned or created in Tandem.
- It splits large JS/TS, Python, CMake and PowerShell files into smaller component files on a new git worktree and branch. Each original file re-exports its pieces.
- It is plain code with no model involved, and it never changes your files in place.

## 15. Settings

- Review and limits, learning mode, subagent behaviour and the full-access switch, structure, saved text (global prompt, notes, export), and appearance (Eco and Lite).

## 16. Extras

- **Demo:** replays a scripted session with no quota used.
- **Sky:** sends a ship, meteor, comet or asteroid through the scene.
- **Stop all:** stops every running agent session.

## 17. What is stored, and where

- In your project: `.tandem/PROJECT_CONTEXT.md`, `.tandem/conversations/`, `.tandem/worktrees/`, `.tandem/learning/`, and `LEARNING.md`.
- In Tandem's data folder: the workspace settings, saved profile, recent repositories, and other chats.
- Chats, notes and uploads stay on your machine. Requests still go to whichever provider an agent uses.

## Open questions I could not settle from the code

- Whether Gemini is a full peer in the 3D scene and info panel. Those views only name Claude and Codex.
- Whether the Demo and Sky buttons belong in a release.
