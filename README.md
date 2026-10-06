# Tandem

Tandem is a local place to work with coding AIs without letting them become a black box.

The idea is simple: let an AI help build the project, while Tandem helps you understand the choices behind the code. It can explain the architecture, slow down and teach a concept, show a few ways to solve something, and make the trade-offs clear before work starts. You do not need to write every line yourself just to learn from the project.

It is built around local agent tools first, but it is not tied to one provider. Add Claude Code, Codex, another compatible CLI, or a Chat Completions-compatible API model.

## What it does

- Run multiple coding agents around one selected project.
- Keep a learning profile: your familiar stack, what you want to learn, experience level, and preferred explanation style.
- Pick up the stack you actually work with. A technology counts as known once it has come up a few times in your messages or in files the agents edit for you, most frequent first. You can still edit the profile yourself.
- Open a **Terminal** drawer (Ctrl+`) in the repository or any agent's worktree. It runs one command line at a time in your system shell and keeps `cd` between commands; it is not a full terminal, so vim-style programs do not work.
- **Push** opens a review dialog: choose which changed files to commit, write the commit message, and edit the branch name. Pushes only go to `tandem/...` branches (default `tandem/<repo>`), never by force. Files that look private (`.env`, keys) start unselected.
- Show a context graph for each running subagent under its main agent in the right-hand panel.
- Let you choose a model for a main agent or subagent; Tandem remembers the last model used for each provider.
- Detect available models from compatible API providers when they expose a `/models` endpoint.
- Give each CLI agent and Tandem-created subagent an isolated Git worktree and branch where Git is available.
- Create a shared `.tandem/PROJECT_CONTEXT.md` in every selected or created project. All Tandem agents receive it as common project context.
- Browse files, inspect Git changes, attach images, save notes, export chats, and keep local workspace state.
- Reopen saved conversations from **history** beside **new chat**. Chats stay grouped by project and agent, with their messages, model settings, and associated subagent chats. CLI conversations resume using that CLI's local thread history.
- Set up a folder, clone a repo, connect GitHub through the GitHub CLI, and configure agents from inside the app.

API agents are chat-only: they do not receive local shell or file tools. Their usage is billed by their provider. CLI agents use the local CLI account already signed in on your computer.

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
