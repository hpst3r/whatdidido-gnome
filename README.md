# whatdidido-gnome

GNOME Shell (50) top-bar control for a [whatdidido](https://github.com/hpst3r/whatdidido) work
session. It talks to the work-session server's local control API
(`/control/v1/*`) and shows:

- **Top bar:** a state icon — recording (red record dot), paused, reconnecting,
  stopped, failed, or server not running — each with its own icon shape, plus a
  small microphone icon while the microphone is on and not stopped for good
  (limit reached, failed); it can be turned off in settings.
- **Popover** (the menu; it looks like the whatdidido app's own capture
  popover in its GNOME skin, inside the shell's popup, light or dark with the
  shell's style and in your accent color), top to bottom:
  - header: the whatdidido logo and a **Settings** button;
  - status card: the state in words ("Recording", "Paused", "Waiting for
    unlock", …), "3 monitors · every 5 s · mic on" (while paused: "Paused for
    12 min · nothing is captured", "<1 min" under a minute), and a round
    **Pause** / **Resume** / **Start** button for what the state allows. When
    no work session runs: "Capture not running";
  - notices, each only when present: the last failed action, the session's
    last error, the microphone hint ("Choose a microphone", "USB headset is
    not connected"), an invalid app server URL in Settings;
  - tiles: **Microphone** (on/off, "On · USB headset (waiting for device)"
    with the microphone the session actually uses and its trouble), **PHI
    guard** ("3 frames withheld", when the server reports it; opens those
    frames in the app's Timeline) and **Active window** (the "Record active
    window" setting);
  - **Input**: the microphone; click to pick another in a list below (the
    saved choice is checked);
  - **Screenshot interval**: a slider over the app's stops, 5 s to 1 h; it
    commits on release (keyboard and scroll wheel: 600 ms after the last
    step);
  - **Now** (from the app server, below): the app and window title in focus,
    and, while the time since the last entry is unassigned, "5:00 PM – now is
    unassigned" with a ticket picker and **Assign**, which saves that stretch
    as an entry for the ticket (with the ticket's usual client, category and
    billable flag). Otherwise the last entry ("#4101 until 4:30 PM");
  - **Today** (from the app server): one bar per 15 minutes, colored by
    ticket, accent when active and unassigned, amber when paused; hover or
    focus a bar for its time and ticket, click it to open the Timeline there;
  - **Open whatdidido** (the app's Today view);
  - footer: "19,872 samples · 2 pending" and **Stop session**, which asks
    once more ("Cancel" / "Stop now", for 4 s).

  Clicking the controls keeps the popover open; opening a link or Settings
  closes it. Every control is reachable with Tab and the arrow keys, Space and
  Enter activate, Escape closes. Times follow the clock format in GNOME's
  settings (12 or 24 hours).

Polling: every 2 s while the menu is open or the session is starting,
recording, reconnecting or stopping, otherwise every 10 s (both configurable);
also on menu open. When the server isn't running the icon shows that and the
popover says "Capture not running"; nothing is logged for it.

## App server (Now card, Today bars, links)

The Now card, the Today bars and the app links come from the whatdidido app
server (the read server that serves `/app/`), not from the work session's
control API. By default the extension finds it from the work session's
`/day` redirect (without the control token); **Settings → App server** can
name it instead (`http://127.0.0.1:<port>`, nothing else; any other value
hides the Now card and Today bars and the popover says so).

- The day (`GET /api/v1/timesheet/day?date=<today>`) is read when the popover
  opens and every 15 s while it stays open, never while it is closed. A
  server without `--timesheet` (404) or no app server at all: no Now card and
  no Today bars, no notice.
- **Assign** posts `POST /api/v1/timesheet/assignments`; if the timesheet
  changed meanwhile the card says "The timesheet changed. Try again.", and
  the day is read again either way.
- Without an app server **Open whatdidido**, the PHI guard tile and the
  Today bars' links are insensitive.

## Microphone choice

The extension never picks a microphone you did not choose (issue #1).

- The choice is saved by its stable id (PipeWire node name, from servers that
  report `stable_id`), so a USB microphone that reconnects with a new id
  (dock, suspend) is still found. Older servers: the saved id is used.
- No saved choice: turning the Microphone tile on sends nothing; the popover
  says "Choose a microphone" and expands the **Input** list in place.
  Picking one saves it and turns the microphone on.
- Saved choice not connected: the tile stays off and the popover says
  "USB headset is not connected". No other microphone is used.
- Picking another source while the microphone is on switches over to it
  (decided from a fresh status; while the session is starting or stopping
  the pick is only saved).
- A microphone started elsewhere (e.g. the session page) is shown as the
  active one; it doesn't change the saved choice.
- Status polling never turns the microphone on or off.
- Choices saved before stable ids are migrated the first time the menu sees
  that microphone. After upgrading, a choice saved by an older version whose
  device has since been renumbered (reconnect, reboot) must be picked again
  once; until then the popover says it is not connected.
- **Settings → Forget microphone** clears the choice.

## Pause reminder

So a forgotten pause doesn't silently cost work capture: while the session
stays **paused**, a notification "Recording is paused" ("Paused for N minutes.
Screenshots, audio and window activity aren't being recorded.") appears after
`pause-reminder-minutes` (default 10) and again every that many minutes after
the previous one. Each reminder replaces the last, so the banner shows again
instead of piling up. It is a high-urgency notification: it shows a banner but
still respects Do Not Disturb.

- **Resume** resumes the session (same request as the popover's Resume); a
  failure is shown in the popover and logged once, and the reminders go on.
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

## Microphone reminder

A wrong or dead microphone shows up as transcripts that keep arriving but are
all empty. So while the session is **recording** with the microphone on and the
server transcribes audio (it reports `transcription_with_text`), a
notification "Check your microphone" ("No speech transcribed from USB headset
for N minutes.") appears when no speech has been transcribed for
`mic-reminder-minutes` (default 10), and again every that many minutes. It is
counted from the first poll that saw the microphone on and starts over when
speech is transcribed, the session server restarts, or another microphone is
used; that also withdraws a shown reminder. Transcripts land about one audio
segment (default 60 s) after the speech, so a delay of only a minute or two
can remind while you are talking. Leaving recording (pause, reconnecting,
stop), turning the microphone off, audio that stopped for the whole session
(limit reached or failed: no microphone choice fixes it), a captured output
monitor (the server's count includes its transcripts, so speech from a call
or video would hide a dead microphone), or a server without transcription (or
older than the counter) withdraws it and never reminds.
**Choose microphone** opens the popover with the **Input** list expanded (it
doesn't switch anything by itself); **Stop reminding** stops it until the next
speech, another microphone or leaving recording. It is independent of the
pause reminder, sends nothing to the server, and 0 = off.

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
- The Active window tile is insensitive, with "Not enabled on the server",
  when the server doesn't offer it.

## Privacy

- The server writes `$XDG_RUNTIME_DIR/whatdidido/control.json` (mode 0600,
  0700 directory, new random token each start, deleted on shutdown). The
  extension re-reads it on every request and again on a 403, and only accepts
  a loopback `http://127.0.0.1:<port>` / `http://[::1]:<port>` URL from it, so
  the token is never sent anywhere else.
- The token is never stored in dconf/GSettings and never logged; error
  messages never include it. Settings hold only poll intervals, the chosen
  microphone's stable id, opaque id and label, the indicator toggle, the active-window
  switch, the excluded app ids, the pause- and microphone-reminder delays and
  the app server URL.
- Requests carry `Authorization: Bearer …` and no `Origin`, `Cookie` or
  `Sec-Fetch-*` headers (the API refuses browser-shaped requests).
- Requests to the app server go only to `http://127.0.0.1:<port>`, never
  carry the control token, and carry no `Authorization`, `Origin`, `Cookie`
  or `Sec-Fetch-*` headers: the app server treats them as the local user.
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
| `microphone-stable-id` | empty | chosen in the menu (stable across reconnects); empty = none chosen |
| `microphone-id` | empty | chosen microphone's opaque id; only used without a stable id; never a fallback to another microphone |
| `microphone-label` | empty | chosen microphone's name, for messages |
| `show-mic-indicator` | true | microphone icon in the top bar while it is on |
| `report-active-window` | true | report the focused window while recording (server needs `--window-activity`) |
| `window-title-excluded-apps` | empty | app ids (with or without `.desktop`) whose titles are sent empty; comma-separated in Settings |
| `pause-reminder-minutes` | 10 | notify after this many minutes paused, then every this many minutes; 0 = off (0..240) |
| `mic-reminder-minutes` | 10 | notify after this many minutes with the microphone on and no speech transcribed, then every this many minutes; 0 = off (0..240) |
| `app-url` | empty | the app server, `http://127.0.0.1:<port>`; empty = found from the work session |

## Develop

```bash
make test      # model unit tests + client tests against a loopback fake API
make check     # test + syntax (node --check) + schema
make pack      # build/whatdidido@wporter.org.shell-extension.zip
make shots     # screenshots of the popover in an isolated headless shell (tests/shots/README.md)
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
allowed actions, header text, poll period, control-file validation), so it is
unit-tested with plain `gjs -m`. `lib/mic_model.js` likewise holds the
microphone choice (matching, migration, the popover's texts and the
`MicController` behind the mic tile and the input list). Likewise
`lib/window_model.js` holds the active-window rules (payload, sanitising,
debounce/spacing/retry scheduler on an injected clock, availability gating,
the focused window's signal bookkeeping) and `lib/window_tracker.js` only
connects the Shell signals and GLib timers to it. `lib/pause_reminder.js`
holds the pause reminder's rules (paused-since, due time, repeats, withdraw,
"Stop reminding", texts) on an injected clock; `extension.js` arms one GLib
timeout for its next due time and shows the notification; `lib/mic_reminder.js`
does the same for the microphone reminder. `lib/day_model.js` (the
timesheet day: unassigned stretch, last entry, 15-minute buckets, ticket
colors, times, app links) and `lib/popover_model.js` (every string, flag and
action of the popover, `docs/POPOVER.md`) are pure as well; `lib/popover.js`
only builds the St widgets once and updates them from that object.
`lib/client.js` (libsoup 3) is tested against `tests/fake_control.js`, a
Soup.Server fake that enforces the contract's request rules, and
`lib/app_client.js` against `tests/fake_app.js`. `extension.js`/`prefs.js`/
`lib/popover.js` only run inside GNOME Shell; `make shots` checks them there.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
