# AGENTS.md

Guidance for contributors and coding agents working on whatdidido-gnome. The
[README](README.md) describes what the extension does for users; this file
covers how to change it safely. When the two disagree with the code, the code
wins: fix the doc in the same change.

## What this is

- A GNOME Shell top-bar extension, uuid `whatdidido@wporter.org`, that
  controls a whatdidido work session
  and shows a popover that mirrors the app's own capture status popover.
- It has no D-Bus API of its own and no server code. It is a client of two
  loopback HTTP servers run by the whatdidido app:
  - **The work session's control API**, `/control/v1/status`, `/microphones`,
    `/command`, `/mic`, `/interval` and `/window` (`lib/client.js`). It finds
    the session through `$XDG_RUNTIME_DIR/whatdidido/control.json`
    (`{"version": 1, "base_url": "http://127.0.0.1:<port>", "token": "..."}`),
    re-reads that file on every request and again on a `403`, accepts only a
    loopback `base_url`, and sends `Authorization: Bearer <token>`.
  - **The app server** (the read server that serves `/app/`):
    `GET /api/v1/timesheet/day` and `POST /api/v1/timesheet/assignments`
    (`lib/app_client.js`). It is found from the session's `GET /day` redirect
    (sent without the token) or the `app-url` setting, IPv4 loopback only,
    and every request goes without `Authorization`, `Origin`, `Cookie` or
    `Sec-Fetch-*` headers, so the server treats it as the local user.
- The wire contracts live in the whatdidido repository: `docs/CONTROL_API.md`
  (control API, including `window_activity` and its `epoch` and `geometry`),
  `docs/TIME_ACCOUNTING.md` (window reports), `docs/AT_REST_GUARD.md`
  (monitor geometry) and `docs/API.md` (local-principal rule). Read the
  relevant one before changing a request or a status field.
- Don't add or change server endpoints from this repository. Use the APIs that
  exist on the app's `main`; a wire change starts as a change to the app's
  contract.

## Layout

| Path | What it holds |
|---|---|
| `whatdidido@wporter.org/` | The extension: `metadata.json`, `extension.js` (shell glue), `prefs.js` (Adw preferences), `stylesheet.css`, `icons/` |
| `whatdidido@wporter.org/lib/` | `model.js`, `*_model.js`, `pause_reminder.js`, `mic_reminder.js`: pure logic with no `gi://` imports. `client.js`, `app_client.js`: libsoup 3 clients. `popover.js`: St widgets. `window_tracker.js`: focus and monitor signals on GLib timers, with the display and monitor manager injectable |
| `whatdidido@wporter.org/schemas/` | `org.gnome.shell.extensions.whatdidido.gschema.xml` (the compiled file is gitignored) |
| `docs/POPOVER.md` | The popover contract: blocks, app-server rules, frozen actor and module names, tests, screenshot harness, and its amendments |
| `tests/*_test.js` | Unit tests of the pure modules and client tests, each run with `gjs -m` |
| `tests/fake_control.js`, `tests/fake_app.js` | Loopback `Soup.Server` fakes of the control API and the app server |
| `tests/live_client.js` | Read-only smoke test against a running work session |
| `tests/shots/` | Screenshot harness: helper extension, fakes, JSON scenarios ([its README](tests/shots/README.md)) |
| `scripts/shots.sh` | Runs the screenshot harness in an isolated headless shell |
| `scripts/nested.sh` | Interactive nested shell (`make nested`) |

## Commands

| Command | What it does | Touches your desktop? |
|---|---|---|
| `make test` | Every unit and client test (pure models, client against the loopback fakes, harness fakes) | No; client tests use `build/test-runtime/` as their runtime dir |
| `make check` | `test`, then `node --check` on `whatdidido@wporter.org/*.js`, `whatdidido@wporter.org/lib/*.js` and `tests/*.js` (not `tests/shots/`), and `glib-compile-schemas --strict --dry-run` | No |
| `make pack` | `check`, then `build/whatdidido@wporter.org.shell-extension.zip` | No |
| `make shots [SCENARIOS="a b"]` | Popover screenshots in a private headless shell, `build/shots/<scenario>-<dark\|light>.png` | No (private HOME, XDG dirs, buses, dconf) |
| `make live` | `tests/live_client.js`: GETs status from the running work session, and microphones when `mic.available` is true | Reads the real session |
| `make install` | Compiles the schema and symlinks the checkout's `whatdidido@wporter.org/` into `~/.local/share/gnome-shell/extensions/` | Yes |
| `make uninstall` | Disables the extension and removes the symlink | Yes |
| `make nested` | Runs `install`, then a nested shell in a window with a separate dconf database | Yes: it shares `$XDG_RUNTIME_DIR`, so it controls the real running session |

- `make check` is the gate. This repository has no CI, so run it locally before
  every push and say in the PR that you did.
- Run `make pack` and `unzip -l build/*.zip` whenever you add a top-level
  directory to the extension: `gnome-extensions pack` silently leaves out any
  directory not named with `--extra-source` in the Makefile.
- Run `make shots` for any change to `popover.js`, `extension.js` or
  `stylesheet.css`, and look at both variants; nothing else exercises in-shell
  code.
- Coding agents: don't run `install`, `uninstall`, `nested` or `live` unless
  the person you work for asks; they change the desktop session or talk to
  the real work session.
- Run one test file with `gjs -m tests/<name>_test.js`; client tests take a
  scratch runtime dir as their argument, as in the Makefile.

## Testing rules

- Put every decision (labels, allowed actions, timing, payloads, validation)
  in a pure `lib/` module on an injected clock and test it with plain
  `gjs -m`; keep `extension.js`, `popover.js` and `window_tracker.js` to
  wiring. The first two only run inside the shell; `window_tracker.js` runs
  under plain `gjs` only with a fake display and monitor manager injected
  (`tests/window_tracker_test.js`), which doesn't check real shell signals.
- Add every new test file to `make test`; a test the Makefile doesn't run
  protects nothing.
- Test clients against `tests/fake_control.js` and `tests/fake_app.js` on
  `127.0.0.1`, with the control file in a scratch runtime dir. Tests never use
  the network beyond loopback and never read the real `$XDG_RUNTIME_DIR`.
- Keep the fakes independent of the code they test: `fake_control.js` has its
  own sanitizer, written apart from `lib/window_model.js`, so the client tests
  cross-check the two.
- Treat the fakes as assumptions. A change to a request body, a status field
  or an error shape is not done until it is checked against the real app's
  server code or output, because a fake that shares the client's misreading
  passes every test.
- Check any GNOME Shell, Mutter, St or GTK API against the installed version
  (typelib introspection or the shell's source at that tag), and confirm new
  shell behavior with a read-only probe in a real or isolated shell before
  calling it working; APIs change between majors and green unit tests don't
  exercise them.
- Point every harness at fakes or a throwaway session with its own
  `XDG_RUNTIME_DIR`: a work session started with the real runtime dir
  overwrites the `control.json` the installed extension reads, and deletes it
  on exit.
- Use synthetic data only in fixtures and shot scenarios: no real window
  titles, ticket numbers, names or captured text.
- Shell support is exactly the versions in `metadata.json` `shell-version`,
  currently `["50"]`. Supporting another major means adding it there after
  testing on it, so don't claim "GNOME N and later".

## Shell code rules

- Read only the status fields you need and ignore unknown keys, so additive
  server fields stay safe; a feature keyed on an optional field
  (`describe_withheld`, `transcription_with_text`, `window_activity.geometry`)
  stays inert while it is absent (an older server or the subsystem off).
- Send every app-server request with `Soup.MessageFlags.NO_REDIRECT`, so a
  `3xx` can't carry a request or its reply off loopback; treat it as a failure.
- Never send the control token anywhere but the control file's `base_url`, and
  validate every configured or discovered URL with an anchored loopback
  pattern; test hostile forms (`127.0.0.1.example.com`, userinfo, port 0).
- Choose devices explicitly and store them by stable id; never fall back to
  "first available" ([Microphone choice](README.md#microphone-choice)).
- Order multi-key settings writes so every intermediate state is safe: each
  write reaches the extension as its own `changed::` signal.
- Serialize request chains per control and decide live switches from a fresh
  status, so a quick on-then-off lands as off.
- Never build a `RegExp` from user text in the shell process; a pathological
  pattern freezes the whole desktop.
- Check popover layout at scale 2 with `SHOTS_SCALE=2` as well as at scale 1.
- Measure user-visible durations on the monotonic clock
  (`GLib.get_monotonic_time()`). Known exception: the interval-change hold in
  `lib/popover.js` sets its deadline with `Date.now()`.
- Keep the actor names that `docs/POPOVER.md` §5 freezes; the screenshot
  harness and its helper hooks find widgets by them.

## Deploying a change

- An extension change takes effect only when the shell loads it again. GNOME
  Shell imports extension code once per shell start, and disabling and
  re-enabling does not re-import cached modules, so on Wayland that means a
  logout and login.
- A symlinked install (`make install`) tracks whatever branch the installed
  checkout has checked out: switching or pulling there changes what the next
  shell start loads.
- Run `glib-compile-schemas whatdidido@wporter.org/schemas` in that checkout
  after a schema change (`make install` does it); new keys are missing until
  the schema is recompiled.
- Batch extension changes so one logout picks them all up; a logout also
  interrupts the work session's screen capture.
- Before calling a fix live, check that the shell started after the change
  reached the installed checkout (`ps -o lstart= -C gnome-shell` against the
  commit time). `gnome-extensions info` reporting ACTIVE says nothing about
  which code is loaded.
- Watch extension errors with `journalctl --user -f -o cat /usr/bin/gnome-shell`.

## Conventions

- Use American spelling in code, UI strings, schema summaries and docs.
- Keep PRs small: one feature or fix per branch, with tests in the same PR.
  Commit subjects use `feat:`, `fix:`, `test:` and `docs:` prefixes.
- Update `README.md` (user-facing behavior and settings) and `docs/POPOVER.md`
  (popover contract, as a numbered amendment) in the same change as the code.
- The extension stores no captured content: it writes no files, and its
  settings hold only the keys in the schema (poll intervals, the microphone
  choice, toggles, excluded app ids, reminder delays, the app server URL).
  Window data goes only to the loopback work session and is never logged, and
  the control token is never stored or logged. Keep it that way
  ([Privacy](README.md#privacy)).
- A filter that suppresses data on the client defers it rather than dropping
  it, and is a setting the user can turn off, because what the extension
  discards never reaches the server.
- The code is licensed AGPL-3.0-or-later ([LICENSE](LICENSE)).
