# CC Mobile

A native Android front end for Claude Code: start tasks, watch Claude work, approve
commands from a notification, review the diff, and ask for a commit or PR — without a terminal.

```
┌──────────── Android app (Kotlin/Compose) ────────────┐
│ Tasks · Live session · Changes · Settings             │
│ Foreground service → approval notifications           │
└───────────────┬──────────────────────────────────────┘
                │ NDJSON over TCP, token auth (127.0.0.1:8765 by default)
┌───────────────┴─────────── bridge/ccm-bridge.mjs ────┐
│ Keeps sessions alive while the app is closed,         │
│ stores transcripts, lists repos, computes git diffs   │
└───────────────┬──────────────────────────────────────┘
                │ stdio, stream-json
          claude -p --input-format stream-json --output-format stream-json
                   --permission-prompt-tool stdio  (one process per task)
```

The app never runs `claude` itself: Android apps can't execute Termux binaries. The bridge
runs wherever your code lives — in Termux on the phone, or on a computer.

## Run the bridge

In Termux (needs Node and a logged-in `claude`):

```sh
termux-wake-lock        # optional: stops Android pausing Termux while tasks run
node ~/claude-code-mobile/bridge/ccm-bridge.mjs --pair
```

`--pair` opens the app with the address and token; confirm the dialog and you're connected.
Without the app installed yet, `--show-token` prints the token for manual entry.

Options: `--roots ~/src,~/work` (where to look for git repos, two levels deep; default `~`),
`--port 8765`, `--host 127.0.0.1`. **New folder…** in the repo picker creates an empty git repo
inside one of the roots. State (token, transcripts, attachments) lives in `~/.local/state/ccm-bridge/`.

**Attachments:** the paperclip in both composers attaches photos or files (up to 10, 20 MB each).
The bridge saves them in `attachments/<session id>/` and tells Claude their paths; that folder is
passed with `--add-dir`, so Claude reads them without asking. Photos are scaled to 1568 px and
also sent inline, so Claude sees them straight away.

**Phone use** (bridge in Termux on a rooted phone): the **Phone** chip on a new task, or *Turn on
phone use* in a task's menu, gives Claude `bridge/phone-mcp.mjs`, an MCP server that runs
`screencap`, `uiautomator`, `input`, `am` and `pm` through `su`. Tools: screenshot, screen_elements,
tap, long_press, swipe, type_text (ASCII only), key, list_apps, open_app, open_uri, set_alarm,
set_timer. Looking (screenshot, screen_elements, list_apps) runs without asking; every action goes
through the usual approval unless you allow it always or turn on YOLO. Phone tasks don't need a
repo. The chip only shows when the bridge's `su -c id` returns 0 (override with `CCM_PHONE=0|1`).

**Reasoning effort:** the model chip on a new task also picks effort (Low, Medium, High, Extra high,
Max, or the model's default; passed as `--effort`). In a running task, *Reasoning effort* in the menu
changes it from the next reply without restarting Claude. The default for new tasks is in Settings.

**Images Claude looked at** (screenshots, files it Read, video frames) show as thumbnails under the
tool call; tap one for full screen, then swipe, pinch or double-tap to zoom. The bridge keeps them in
`images/<session id>/` and sends each one when the app asks, not inline with the transcript. Images
from tasks before this was added are recovered from Claude Code's own transcript the first time
the task is opened.

**Usage limits:** when a task hits your plan's limit it pauses ("Usage limit") with the reset time.
Turn on *Continue after usage limits reset* (Settings for new tasks, or the switch on the paused
task) and the bridge sends "Continue where you left off" a minute after the reset, even across a
bridge restart. Sending a message yourself cancels the wait.

**Usage** (gauge icon on the task list): plan limits (the 5-hour and weekly windows, with reset
times) come from the `rate_limit_event` Claude Code sends with each reply, so they appear after the
first reply through the bridge and cover all your Claude use. Below that: tokens in and out per day,
project and model over 7 or 30 days, read from Claude Code's transcripts in `~/.claude/projects`
(terminal sessions included). The icon turns amber at 80% of a limit and red at 100%.

**On a computer:** run the same script with `--host <private address>`, e.g. your Tailscale IP,
and enter host, port and token in the app's Settings. Traffic is not encrypted, so only bind a
private network (or use an SSH tunnel to `127.0.0.1`).

## Build the app

```sh
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # transcript + diff parser tests
node --test bridge/test/*.test.mjs
```

Building on the phone in Termux works with two local tweaks (not committed):

- `local.properties`: `sdk.dir=/data/data/com.termux/files/home/android-sdk` with
  `platforms/android-36` and `build-tools/36.1.0` unzipped from Google's repository.
- `~/.gradle/gradle.properties`: `android.aapt2FromMavenOverride=/data/data/com.termux/files/usr/bin/aapt2`
  (`pkg install aapt2`), because the aapt2 on Maven is x86-64 only.

## How approvals work

Each task runs with `--permission-prompt-tool stdio`, so when Claude needs permission the CLI
sends a `can_use_tool` control request and waits. The bridge marks the task *Needs approval*
and forwards the request; the app shows it in the session and, when the app is in the background,
as a notification with **Allow once** / **Deny**. "Always allow this in this project" sends the
CLI's own `addRules` suggestion back, so it lands in the project's local settings exactly as it
would from the terminal.

While a task runs, a silent ongoing notification shows what Claude is doing (its latest tool
call or message), how long it has been working, and an **Interrupt** button. On Android 16 it
appears as a Live Update chip in the status bar. When the task ends while the app is in the
background, it turns into a *Finished* notification. Both are in the "Claude's progress" channel.

The default permission mode for new tasks (Ask first / Auto-edit / Plan only / YOLO) maps to
`--permission-mode default | acceptEdits | plan | bypassPermissions`.

**YOLO** runs commands and edits files without asking. Claude Code still sends writes to
settings, git and tool-configuration files to the app for approval. You can also switch a
running task into or out of YOLO from the session's ⋯ menu. For this, the bridge starts every
task with `--allow-dangerously-skip-permissions`, which only makes the mode available: tasks
still start in whatever mode you picked.

## Resuming Claude Code sessions

The **Resume** tab lists Claude Code sessions on the bridge's machine that the app isn't tracking yet,
such as ones started with `claude` in a terminal. The list is read from `~/.claude/projects`
(or `$CLAUDE_CONFIG_DIR/projects`). Sessions whose folder no longer exists, or where nothing was ever
asked, are left out. Tapping one imports its transcript and keeps its session id, model and
permission mode. Your next message runs `claude --resume <id>`, so Claude has the full context.

It works the other way too. App sessions are ordinary Claude Code sessions, so
`claude --resume <id>` in a terminal picks one up. When you reopen it in the app, the bridge adds
the turns you took elsewhere from Claude Code's transcript.

Don't drive the same session from the app and a terminal at the same time: both would append to
the same session.

## Layout

- `bridge/ccm-bridge.mjs` — the bridge (Node, no dependencies); `bridge/test/` runs it against a fake CLI.
- `bridge/phone-mcp.mjs` — the Phone use MCP server (stdio, no dependencies).
- `app/src/main/java/app/ccmobile/data/` — socket client, repository, stream-json → transcript reducer, diff parser.
- `app/src/main/java/app/ccmobile/ui/` — Compose screens.
- `app/src/main/java/app/ccmobile/notify/` — foreground service and approval notifications.

## Not done yet

- Cloud sessions (claude.ai/code) and Remote Control aren't wired in; "My computer" means running the bridge there.
- Sub-agent activity is collapsed into its Task row rather than shown in full.
