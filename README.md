# Tandem

Run Claude Code, Codex and other coding AIs on your own project, and understand what they build.

Tandem is a Windows desktop app that keeps coding agents from becoming a black box. Several agents work side by side on one project, each in its own git branch. Tandem explains the choices behind the code at your level, and you review every change before it leaves your machine.

It is for people who build with AI and want to learn from it, and for developers who want to run agents in parallel without losing track of what changed. It is not tied to one provider: add Claude Code, Codex, Gemini CLI, or any Chat Completions-compatible API model.

## What it does

### Work with several agents at once

- Tandem starts with no agents. You add each one by choosing a connection type (Claude Code, Codex, Gemini CLI or an API model) and, if you like, naming it; a blank name takes the connection's own name ("Claude", then "Claude 2"). Run up to eight around one selected project, and give each a model of its own. Tandem remembers the last model used for each provider.
- Every CLI agent and every Tandem-created subagent gets an isolated git worktree and branch, where Git is available.
- Each subagent can open in its own window, and the main agent is told when one finishes. A context graph for each running subagent shows in the right-hand panel.
- A shared `.tandem/PROJECT_CONTEXT.md` is created in every project. All agents receive it, so they start from the same picture.
- Reopen saved conversations from **history** beside **new chat**. Chats stay grouped by project and agent, with their model settings and subagent chats. CLI conversations resume from that CLI's own thread history.

### Agents can build, test and browse

- Claude Code and Codex agents get Tandem's own tools over MCP: list and run the project's `package.json` scripts (build, test, lint), start and stop a dev server, and use a browser window of their own to open a page, read it, click, type, take a screenshot and read its console and failed requests.
- Each agent's browser is a separate window with its own empty session (no cookies or logins from elsewhere), limited to http and https. The **Browser** button brings the selected agent's window forward. The browser needs the desktop app; the build and test tools work anywhere.
- Tools that run scripts or start servers are refused while an agent is in a read-only mode (including learning mode before you approve). Turn the whole set off in Settings → Subagents. Gemini CLI and API agents do not get these tools yet.

### Learn while the project gets built

- Keep a learning profile: your familiar stack, what you want to learn, your experience level and your preferred explanation style.
- Tandem picks up the stack you work with. A technology counts as known once it has come up a few times in your messages or in files the agents edit for you. You can still edit the profile yourself.
- In learning mode the agent questions and challenges you before it codes. It asks one question at a time, pushes back on vague answers, and cannot write code until it says it is fully satisfied (`READY TO BUILD`). You cannot hand the thinking back ("you decide", "just do it"): Tandem flags it and the agent refuses it, and the agent may not decide for you either.
- **TODO mode** (Settings → Learning, needs learning mode): the agent builds the structure, wiring and real tests, and leaves the core logic for you as `TODO(you)` markers with throwing stubs. A checklist in the chat lists every marker with a hint and `file:line`; click one to open that block in VS Code. A marker that disappears from the code ticks itself off. **Check my work** asks the agent to read what you wrote and give hints, never the logic, and asking it to "write it for me" is refused.
- It keeps track of you. Agents note your level in each technology and habits such as vague answers or handing decisions back, and every agent sees those notes and adjusts how hard it pushes.
- It also writes `.tandem/learning/learning.md` (what was built, explained at your level) and `learningcontext.md` (how to teach you, shared by every agent).

### Review before anything ships

- **Review** opens a window showing what an agent changed since you last approved, with the agent's own note on each edit. Edit a hunk or ask about it and the agent receives your change. Nothing is written to its folder.
- Agents are given a size budget (default 300 lines, 10 files) and asked to split big requests and stop for review. A cutoff a little above it stops a runaway. Both can be switched off for unattended runs.
- **Push** opens a dialog where you choose which files to commit, write the message and edit the branch name. Pushes only go to `tandem/...` branches (default `tandem/<repo>`), never by force. Files that look private (`.env`, keys) start unselected.

### Set up without a terminal

- **Connect agents** installs and signs in to Claude Code, Codex and Gemini CLI from the app. Codex and Gemini have an opt-in full access mode (no sandbox), chosen per agent behind a warning.
- Open a local folder, clone a repo, start a new project, and connect GitHub through the GitHub CLI.
- Browse files, inspect Git changes, attach images, save notes and export chats.
- **Terminal** (Ctrl+`) opens your real terminal (Windows Terminal, or PowerShell) in the selected agent's worktree, or the repository. **Editor** (Ctrl+E) opens the same folder in VS Code, or the default app if VS Code is not installed. In Files / Diff, **Open in editor** opens one file.

### Also included

- A 3D solar-system view of your agents (it starts with just the sun), with **Lite** (text only) and **Eco** (lower frame rate) modes for slower computers.
- **Demo** replays a scripted session without using any quota.
- **Settings → Structure** (off by default, only for projects cloned or created in Tandem) builds a separate git worktree and branch with big JS/TS/Python/CMake/PowerShell files split into smaller component files. Each original path re-exports its pieces. It is plain code, uses no tokens, and never changes your files in place.

API agents are chat-only: they do not receive local shell or file tools, and their provider bills the usage. CLI agents use the local CLI account already signed in on your computer.

## Get Tandem on Windows

Go to the repository's **Releases** page and download one of these assets:

- `Tandem-Setup-<version>.exe` — normal installer.
- `Tandem-<version>-Portable.exe` — run it without installing.

No Node.js is needed just to run the desktop app. To use Claude Code, Codex, Git, or GitHub features, install those tools separately and sign into them on the same computer.

Open Tandem and hit **Set up**. From there you can:

1. Open an existing local repository.
2. Clone a GitHub repository.
3. Start a new project folder.
4. Connect GitHub using your existing GitHub CLI login.
5. Add a local CLI agent or an API model.
6. Fill in your Learn profile.

The first time you open a project, Tandem makes `.tandem/PROJECT_CONTEXT.md`. Keep the important project decisions and conventions there so every agent starts with the same picture. `.tandem/` is ignored by Git by default, so this stays local unless you deliberately add it.

## Use it locally from source

You need Node.js 22.12 or newer (or Node 20.19+).

```powershell
npm ci
npm run dev
```

The app server is at `http://127.0.0.1:4317`; Vite's development UI is at `http://localhost:5173`.

For a production-style local run:

```powershell
npm start
```

To create the Windows installer and portable executable:

```powershell
npm run package:win
```

The files are written to `release/`.

## Development checks

```powershell
npm test
npm run build
```

The `tests/` folder is the automated test suite. It is not part of the packaged app, but it is kept in the repository so changes can be checked before a release.

## A quick note on privacy

Tandem binds to your local machine. Chats, notes, profiles, uploads, and workspace settings stay local. Requests still go to the agent provider you choose, and GitHub actions still use Git/GitHub CLI on your machine.

Do not put API keys into Tandem's interface. For API agents, set a server environment variable with the key before starting Tandem, then enter only that variable's name in the app.

## Status

Tandem is early and actively being built. The main local workflow, onboarding, learning profile, shared project context, isolated workspaces, subagent model choices, and Windows packaging are in place. There is more to make smoother, especially project creation, agent coordination, and release polish.
