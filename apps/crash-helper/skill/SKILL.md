---
name: diagnose-crash
description: >
  Diagnose why a program crashed on this machine, from a systemd-coredump core dump.
  Use when a process has segfaulted, aborted, or otherwise dumped core, when asked
  why an application crashed or disappeared, or when a Crash Helper notification
  is acted on. Triggers: crash, segfault, SIGSEGV, SIGABRT, SIGTRAP, core dump,
  coredumpctl, "why did X crash", "X keeps crashing", backtrace.
---

# Diagnosing a Crash

This machine is a Daylight DC-1 running postmarketOS (Alpine-based: aarch64, musl,
`apk`), GNOME Shell on Wayland, with apps from apk, Flathub (per user) and
Daylight Apps (`~/Projects/daylight-apps`).

Work from evidence. The goal is an honest account of what happened, not a
plausible-sounding story.

## Establish the facts

`coredumpctl info <pid>` is the starting point. Beyond the backtrace, note the
**command line** the process was started with; it often reveals what the program
was doing when it died, which is sometimes the whole answer.

`coredumpctl list` shows whether this is a one-off or a pattern. Repeated crashes
of the same program, or several programs dying together, point somewhere
different than a single failure does.

Work out where the program came from: `apk info --who-owns <binary>` for system
packages; a binary under `/app/` or a `bwrap` parent means a Flatpak
(`flatpak list --app`); `~/.local/` means something installed per user.

## Rule out the boring causes first

Check resource exhaustion before blaming the program: `free -h`, and
`journalctl -k` for OOM kills. A process killed by the OOM killer is not a bug in
that process. A `SIGTRAP` from a browser or Electron app is usually a deliberate
`CHECK()` failure; the journal lines just before it usually say which.

## Correlate against the timeline

The crash time is the most underused piece of evidence. Compare it against:

- **The journal** around that moment (`journalctl --since ... --until ...`), for
  warnings from the same or neighbouring processes.
- **Recent package changes**: `/var/log/apk.log` if present, and the mtimes in
  `/lib/apk/db/`. A crash that starts right after an upgrade points at it.
- **Filesystem mtimes.** A file touched in the same second as the crash suggests
  what triggered it.

## Read the whole core, not just frame 0

Other threads' stacks show what work was in flight: image loaders, IPC readers,
GPU queues. That often explains the trigger even when the crashing frame cannot
be symbolized. Note third-party code in the address space (plugins, GNOME Shell
extensions, out-of-tree drivers), but do not blame it without evidence.

## Symbolize when you can

`gdb` and debug symbols are not installed by default. On Alpine, symbols come
from `<package>-dbg` packages. Installing either needs the user's password, so
**ask before running** `sudo apk add gdb <package>-dbg`, and say what it is for.
Many packages have no `-dbg` package; Flatpak apps need their `.Debug` extension.

```sh
core=$(mktemp -t crash-XXXXXX.core)
trap 'rm -f "$core"' EXIT
coredumpctl dump <pid> --output="$core"
gdb -q <executable> "$core" -batch -ex 'thread apply all bt'
```

A core is a copy of the process's memory and can hold passwords, tokens and
private documents. Write it to a fresh `mktemp` path and delete it when done.

When frames stay unresolved, say so; never invent function names. An
unsymbolized stack still has shape: which library each frame is in, and whether
it came from a signal handler, a main loop or a worker thread.

## Report

1. What crashed, and what it was doing at the time.
2. The most likely mechanism, separating what the evidence **proves** from what
   you are **inferring**.
3. Whether any user data was lost, and where it can be recovered from.
4. Whether it is likely to recur, and what would avoid or fix it.

Keep it short and plain: the user may be reading on a tablet. If the cause is
genuinely ambiguous, say so.

**Leave the system as you found it.** Diagnosis reads; it does not fix, tidy or
reconfigure without the user agreeing first. Delete any core you extracted.

## Offer to stop the notifications for this program

Finish by offering to silence notifications for **that one program**, and never
do it unprompted. Say how to undo it in the same breath.

```sh
crash-mute '<binary path or name>'       # silence it
crash-mute '<binary path or name>' off   # let it notify again
crash-mute                               # list what is muted
```

Prefer the binary path: a process name is cut to 15 characters, so muting that
can silently match nothing. Quote it. Anything run through an interpreter is
keyed as the interpreter, so muting `python3` silences every Python program; say
so rather than doing it quietly. A mute is no substitute for a fix within reach.
Crash Helper's switch in Daylight Apps turns off all notifications.

## Reporting upstream

Only with the user's explicit yes, after showing them the exact text. Find the
right project: the app itself, Alpine aports (`gitlab.alpinelinux.org`),
postmarketOS (`gitlab.postmarketos.org`), or, when the cause is one of the
Daylight Apps scripts or GNOME Shell extensions, `jamesbondini/daylight-apps` on
GitHub. Search existing issues first, including closed ones; a matching issue
closed as fixed is a regression worth reporting. If `gh` is not signed in, hand
the user the finished text instead. End the report with a line naming the model
and harness that wrote it.
