# whatdidido-gnome

GNOME Shell (50) top-bar control for a [whatdidido](https://github.com/hpst3r/whatdidido) work
session. It talks to the work-session server's local control API
(`/control/v1/*`) and shows:

- **Top bar:** a state icon — recording (red record dot), paused, reconnecting,
  stopped, failed, or server not running — each with its own icon shape, plus a
  small microphone icon while the microphone is on (can be turned off in
  settings).
- **Menu:** the state in words and "N screenshots, every Xs, M monitors"
  (while paused, prefixed with how long: "Paused for 12 min", "<1 min" under
  a minute);
  Start / Pause / Resume / Stop (only those allowed in the current state);
  a **Microphone** switch; **Microphone source** (remembered in settings);
  **Screenshot interval** (5/10/30/60 s, current one marked); **Record active
  window**; Open session page; Open day view; the session's last error, if
  any; Settings.

Polling: every 2 s while the menu is open or the session is starting,
recording, reconnecting or stopping, otherwise every 10 s (both configurable);
also on menu open. When the server isn't running the icon shows that and the
menu says "whatdidido not running"; nothing is logged for it.

## Pause reminder

So a forgotten pause doesn't silently cost work capture: while the session
stays **paused**, a notification "Recording is paused" ("Paused for N minutes.
Screenshots, audio and window activity aren't being recorded.") appears after
`pause-reminder-minutes` (default 10) and again every that many minutes after
the previous one. Each reminder replaces the last, so the banner shows again
instead of piling up. It is a high-urgency notification: it shows a banner but
still respects Do Not Disturb.

- **Resume** resumes the session (same request as the menu's Resume); a
  failure is shown in the menu and logged once, and the reminders go on.
- **Stop reminding** stops the reminders until the session leaves paused.
- Leaving paused (resume, stop, failure, server not running) withdraws a shown
  reminder and starts over at the next pause.
- Changing the setting while paused counts from the pause start (or the last
  reminder); if that is already past, the reminder shows at once. 0 = off
  (withdraws a shown reminder).
- **Counting caveat:** the server doesn't report when a pause started, so the
  extension counts from the first status poll that saw "paused" (up to one
  idle poll, default 10 s, late). A pause that began before the extension
  started (login, shell restart, re-enable) counts from then. A resume and
  re-pause between two polls isn't seen, so it counts as one pause. A failed
  poll other than "not running" (e.g. a timeout) keeps the count. Time is
  measured on the monotonic clock, so time spent suspended is not counted.

## Active window (time accounting)

When the work-session server runs with `--window-activity`, the extension
reports the focused window to it (`POST /control/v1/window`) so active time can
be attributed to applications and window titles. Each report holds the app id
(`org.gnome.Ptyxis.desktop`; empty for windows without a desktop app), the app
name, the WM class and the window title, or "no focused window".

- Sent only while the last status poll shows the session **recording** and the
  server offering window activity, and the **Record active window** setting is
  on. Nothing is sent while paused, reconnecting, stopped or not running.
- Changes (focus, title, WM class) settle for 1 s, then the current window is
  sent if it differs from the last one sent; at most one request per 2 s.
  After every start/resume/reconnect the current window is sent again.
  So it is when the status's `window_activity.epoch` changed since the last poll
  (a pause/resume or recovery between two polls); servers without it are fine.
- A failed report (no answer, timeout, 5xx, 400) is retried with the window
  focused at that moment, after 2, 4, 8 … up to 60 s, until one succeeds or
  the focus changes.
- Turning **Record active window** off while recording reports "no focused
  window" once, so the time stops counting for the last window.
- Titles are cleaned like the server does (control characters become spaces,
  app fields at most 255 characters, title at most 1024, long titles shortened
  with `…`) before they leave the extension. The request body stays under the
  server's 8 KiB limit for windows even when every character needs escaping.
- The menu switch is insensitive, with "(not enabled on the server)", when the
  server doesn't offer it.

## Privacy

- The server writes `$XDG_RUNTIME_DIR/whatdidido/control.json` (mode 0600,
  0700 directory, new random token each start, deleted on shutdown). The
  extension re-reads it on every request and again on a 403, and only accepts
  a loopback `http://127.0.0.1:<port>` / `http://[::1]:<port>` URL from it, so
  the token is never sent anywhere else.
- The token is never stored in dconf/GSettings and never logged; error
  messages never include it. Settings hold only poll intervals, the preferred
  microphone's opaque id and label, the indicator toggle, the active-window
  switch, the excluded app ids and the pause-reminder delay.
- Requests carry `Authorization: Bearer …` and no `Origin`, `Cookie` or
  `Sec-Fetch-*` headers (the API refuses browser-shaped requests).
- Microphone capture is only offered when the server was started with
  `--allow-audio-capture`; otherwise the switch is insensitive.
- Window titles, app ids/names and WM classes are sent only to the loopback
  work session from the control file, only while it is recording (never while
  paused), and only when the server offers it and **Record active window** is
  on. Apps listed in `window-title-excluded-apps` are reported with an empty
  title. Window data is never logged; send errors are logged once per distinct
  message (the last 32 remembered) without titles or the token. The server stores reports as event
  metadata (see whatdidido's `TIME_ACCOUNTING.md` for where that can go).

## Settings

| Key | Default | |
|---|---|---|
| `poll-active` | 2 s | menu open, or starting/recording/reconnecting/stopping |
| `poll-idle` | 10 s | stopped/paused/failed/not running |
| `microphone-id` | empty | chosen in the menu; empty or missing = first microphone |
| `microphone-label` | empty | display only |
| `show-mic-indicator` | true | microphone icon in the top bar while it is on |
| `report-active-window` | true | report the focused window while recording (server needs `--window-activity`) |
| `window-title-excluded-apps` | empty | app ids (with or without `.desktop`) whose titles are sent empty; comma-separated in Settings |
| `pause-reminder-minutes` | 10 | notify after this many minutes paused, then every this many minutes; 0 = off (0..240) |

## Develop

```bash
make test      # model unit tests + client tests against a loopback fake API
make check     # test + syntax (node --check) + schema
make pack      # build/whatdidido@wporter.org.shell-extension.zip
make live      # read-only status/microphones from the running server
make install   # symlink into ~/.local/share/gnome-shell/extensions, compile schema
# log out/in (Wayland), then:
gnome-extensions enable whatdidido@wporter.org
journalctl --user -f -o cat /usr/bin/gnome-shell   # errors
```

`make nested` runs a throwaway nested shell in a window instead of
re-logging, with only this extension enabled and a separate dconf database
(`~/.config/dconf/whatdidido-nested`), so your real session's settings are
untouched. It needs `mutter-devkit` (GNOME 49+). The nested shell shares
`$XDG_RUNTIME_DIR`, so it controls the real running server.

`lib/model.js` is pure JS (no GI) holding every decision (icons, labels,
allowed actions, header text, microphone choice, poll period, control-file
validation), so it is unit-tested with plain `gjs -m`. Likewise
`lib/window_model.js` holds the active-window rules (payload, sanitising,
debounce/spacing/retry scheduler on an injected clock, availability gating,
the focused window's signal bookkeeping) and `lib/window_tracker.js` only
connects the Shell signals and GLib timers to it. `lib/pause_reminder.js`
holds the pause reminder's rules (paused-since, due time, repeats, withdraw,
"Stop reminding", texts) on an injected clock; `extension.js` arms one GLib
timeout for its next due time and shows the notification. `lib/client.js`
(libsoup 3) is tested against `tests/fake_control.js`, a Soup.Server fake that
enforces the contract's request rules. `extension.js`/`prefs.js` only run
inside GNOME Shell.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
