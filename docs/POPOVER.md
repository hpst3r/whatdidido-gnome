# Top-bar popover (contract)

The extension's menu is replaced by a popover that looks and behaves like
the whatdidido app's capture status popover (the app's
`StatusPopover.svelte`, GNOME skin). The panel indicator (state icon + mic
icon), the reminders, window reporting and the microphone rules of issue #1
are unchanged.

Status: contract for branch `feat/popover`. Sections are numbered so
workers, tests and reviews can cite them.

## 1. Scope

1. **Same blocks as the app**, top to bottom: header; status card; notices;
   tiles; input picker; screenshot interval; Now card; Today bars; Open
   whatdidido; footer (§4).
2. **Data:** status, microphones, commands, mic and interval come from the
   work session's control API (unchanged client, `lib/client.js`). The Now
   card and Today bars come from the **app server** (the read server that
   serves `/app/`) over `GET /api/v1/timesheet/day`, and Assign posts
   `POST /api/v1/timesheet/assignments` (§3).
3. **No server changes.** Everything uses APIs that exist on whatdidido
   `main` today.
4. **The old menu is removed**, not kept as an option. Removed items:
   Start/Pause/Resume/Stop menu items (now the round button and the footer),
   the Microphone switch item and Microphone source submenu (now the mic
   tile and the input picker), the Screenshot interval submenu (now a
   slider), "Open session page" and "Open day view" (now Open whatdidido).
   "Record active window" becomes a tile. Settings becomes a header button.

## 2. Look and feel

1. **Reference images** (synthetic data): the app's GNOME skin, light and
   dark, and the macOS skin for layout. Paths are given in the worker
   briefs. Match the GNOME skin: rounded blocks (12 px status card, pill
   tiles, 12 px blocks), neutral round primary button that turns accent
   when paused, accent-filled mic tile when on, warning-tinted PHI tile,
   tinted block backgrounds (foreground at ~10% opacity), 8 px gaps,
   "Stop session" in the recording red.
2. **It is still a GNOME Shell popup.** It opens from the panel button with
   the shell's own BoxPointer animation and the shell's popup background,
   font and colors. Use the shell theme's accent (`-st-accent-color`,
   `-st-accent-fg-color`) so the user's accent color applies. The recording
   red and the warning amber are the extension's own colors (same values as
   the current `stylesheet.css` for the panel icon: `#ff7b63`, `#f6d32d`
   on dark; darker equivalents with ≥ 4.5:1 contrast on light).
3. **Light and dark:** the shell has a light and a dark style. The popover's
   root gets style class `wdi-light` or `wdi-dark` from the shell's current
   style variant and updates live when the color scheme changes. Every
   color in `stylesheet.css` is defined for both.
4. **Width** 340 logical px (fixed), so content changes never resize it.
5. **No entrance animations, no fades, no layout crossfades**, no
   skeletons. Content that is not loaded yet keeps its place empty (the
   app's 300 ms "hold" rule) rather than flashing a placeholder. The only
   motion: press feedback on buttons/tiles (scale ~0.96, 150 ms), and the
   recording dot's slow pulse (opacity 1 → 0.45 → 1 over 2.4 s) while the
   menu is open and the state is recording. Both are skipped when
   animations are disabled (`St.Settings.get().enable_animations`).
6. **Logo:** the app icon (`icon.svg` from the app, copied into the
   extension as `icons/whatdidido.svg`), 18 px, next to "whatdidido".
7. Times follow the user's GNOME clock format
   (`org.gnome.desktop.interface clock-format`, `12h` → "5:00 PM",
   `24h` → "17:00") in the app server's time zone (`day.zone`).
8. American spelling everywhere.

## 3. App server

1. **Discovery.** Setting `app-url` (string, default empty).
   - Non-empty: must be a loopback http origin (`http://127.0.0.1:<port>`
     or `http://[::1]:<port>`, optional trailing slash, nothing else);
     otherwise it is treated as invalid and the Now card and Today bars are
     hidden with the notice "App server URL in Settings is not a local
     address".
   - Empty (automatic): `GET <control base_url>/day` without following
     redirects and **without** the control bearer token. A `307`/`303`/`302`
     whose `Location` is an absolute loopback http URL gives that URL's
     origin; a relative `Location` starting with `/app/` gives the control
     base_url's origin; anything else (other status, a non-loopback or
     non-http absolute URL, no Location) means "no app server". The result
     is cached and discovered again when the control file's base_url
     changes or an app request fails with a connection error. When the
     session is not running, the last discovered origin is still used.
   - Pure helpers decide both rules (§6).
2. **Requests.** Plain loopback requests with `Host: 127.0.0.1:<port>`
   (Soup's default), no `Authorization`, no `Origin`, no `Cookie`, no
   `Sec-Fetch-*`: the server treats them as the local principal (whatdidido
   `docs/API.md`, "Security status", rule 2), which may read and write.
3. **Day.** `GET /api/v1/timesheet/day?date=<YYYY-MM-DD>`, the local date
   on this machine. `404` means the server runs without `--timesheet`: hide
   the Now card and Today bars, no notice. Connection refused: hide them, no
   notice, re-discover next time. Other failures: hide them and log once
   per distinct message.
4. **When:** fetched when the menu opens, every 15 s while it stays open,
   and right after an Assign. Never while the menu is closed. A response
   that arrives after the menu closed, or after a newer request started, is
   dropped.
5. **Assign.** `POST /api/v1/timesheet/assignments` with exactly
   `{start, end, ticket, client, category, note, billable}`: `start`/`end`
   of the current unassigned stretch (§4.7), `ticket` the picked ticket,
   `client`/`category`/`billable` from `day.suggestions.ticket_defaults`
   for that ticket (`""`, `""`, `true` when absent), `note` `""`. `409`
   with `{"error": "conflict"}` → "The timesheet changed. Try again.";
   other failures → "Couldn't assign that time."; either way refetch the
   day. At most one Assign in flight.
6. **Links** (opened with the default browser, like today): Open whatdidido
   `<app>/app/#/today`; PHI tile `<app>/app/#/timeline?date=<d>&phi=1`;
   a Today bar `<app>/app/#/timeline?date=<d>&t=<HH:MM>` (24-hour, server
   zone); the Now card's app/title row `<app>/app/#/timesheet?date=<d>`.
   Without an app server these controls are insensitive. Opening a link
   closes the menu.

## 4. Blocks

1. **Header:** logo + "whatdidido" on the left; a round Settings button
   (`emblem-system-symbolic`) on the right that opens the preferences.
2. **Status card** (12 px radius, tinted; amber-tinted while paused):
   - leading mark: a 12 px dot (recording red, pulsing per §2.5), a rounded
     amber square while paused, a faint dot otherwise;
   - title (20 px, semibold): the state label (`Recording`, `Paused`,
     `Stopped`, `Starting…`, `Reconnecting…`, `Stopping…`, `Failed`);
     while recovering with `waiting_for_unlock`, "Waiting for unlock";
   - subtitle (12 px, muted): recording/starting/recovering →
     "3 monitors · every 5 s · mic on" (mic part only when the server
     offers a microphone: "mic on"/"mic off"); paused → "Paused for 12 min
     · nothing is captured" (from the pause reminder's paused-for time;
     without it "Nothing is captured while paused"); stopped → "Start
     recording when you're ready"; failed → "The session stopped after an
     error";
   - primary round button (46 px): Pause (recording), Resume (paused,
     accent-filled), Start (stopped/failed); hidden in other states;
     insensitive while a command is in flight.
   - **Not running:** the card instead shows a power icon, "Capture not
     running" and "No work session is running on this computer. Start one
     to record; everything already captured stays browsable." A poll
     failure other than "not running" shows "Can't read the capture
     status" and the error text.
3. **Notices** (amber-tinted rounded strip, 12.5 px), each only when
   present: the last action's failure (today's `_notice`), the status's
   last error (`lastErrorText`), the microphone hint (`Choose a
   microphone`, `<label> is not connected`), the app-url notice (§3.1).
4. **Tiles** (two columns, pill-shaped, 8 px gap, wrapping):
   - **Microphone** switch tile: icon `audio-input-microphone-symbolic` /
     `microphone-disabled-symbolic`; accent-filled when on; subtitle
     "On · <active label>" (with the trouble state as today:
     "waiting for device", …), "Off · no audio", or "No audio in this
     session" (insensitive). Toggling runs the existing
     `MicController.toggle` (issue #1 rules unchanged). With no saved
     choice, turning it on expands the input picker instead (the
     controller's `openSources`), and the menu stays open.
   - **PHI guard** tile, only when the status has `describe_withheld`
     (a number): shield icon, "<n> frames withheld" (singular for 1) in
     amber; opens the Timeline link (§3.6).
   - **Active window** switch tile: the existing "Record active window"
     setting and its `windowSwitchView` label/sensitivity rules; subtitle
     "Recording window titles", "Off", or the unavailable text.
5. **Input picker** (row, tinted, 12 px radius), visible whenever the
   server offers a microphone: "Input" on the left, the active microphone's
   label (else the saved choice's, else "Choose…") with a pan-down arrow on
   the right. Clicking expands an inline list of the sources below the row
   (current one checked); picking runs `MicController.choose`. Only one
   inline list (input or ticket) is expanded at a time.
6. **Screenshot interval** block: "Screenshot interval" and the value
   ("5 s", "1 min", "15 min", "1 h") on one line, the shell's `Slider`
   below. Stops: 5, 10, 15, 20, 30, 45, 60, 90, 120, 300, 600, 900, 1800,
   3600 s (the app's). The thumb shows the nearest stop to the session's
   value; dragging shows the dragged stop's label and commits once on
   release (keyboard/scroll: commit 600 ms after the last change). A value
   set elsewhere that is not a stop shows its own label until changed.
   Insensitive unless recording, paused, starting or recovering.
7. **Now card** (only with a day, §3.3): small caps "NOW"; the most recent
   focused window (`lastFocus`): the app's real icon when `app_id`
   resolves through `Shell.AppSystem` (else an accent square with
   `appInitials`), the app name (semibold) and the title (one line,
   ellipsized). Below a separator, when there is an unassigned stretch
   running up to now (`currentStretch`): "<start> – now is unassigned", a
   ticket picker (inline list of `day.suggestions.tickets`, "Choose
   ticket…") and an Assign button (accent, insensitive until a ticket is
   picked). With no stretch: the last entry ("<ticket> until <end>") or
   nothing. While the session is not recording the card is dimmed (the
   app's `paused` prop).
8. **Today bars** (only with a day that has a span): "Today" and
   "<span start> – now" on one line; one bar per 15 minutes from
   `sparkBuckets`, colored by assigned ticket (`ticketColor`), accent when
   active and unassigned, amber when paused, faint otherwise; heights as
   the app (paused 0.22, other inactive 0.14, active 0.3 + 0.7 × active
   share). Hovering or focusing a bar replaces the right-hand label with
   "<bar start> · <ticket or state>"; clicking opens the Timeline link.
9. **Open whatdidido:** a full-width pill button (accent), insensitive
   without an app server.
10. **Footer** (thin top border, 11.5 px muted): "19,872 samples · 2
    pending" (`en-US` grouping), or "Nothing is captured while paused";
    on the right "Stop session" in red when stop is allowed; clicking it
    turns into "Cancel" + "Stop now" for 4 s; "Stop now" sends stop.

## 5. Actor names (frozen; tests and the screenshot harness use them)

`wdi-pop` (root), `wdi-pop-settings`, `wdi-pop-status`, `wdi-pop-primary`,
`wdi-pop-notice-<n>` (0-based), `wdi-pop-mic`, `wdi-pop-phi`,
`wdi-pop-window`, `wdi-pop-input`, `wdi-pop-input-item-<n>`,
`wdi-pop-interval`, `wdi-pop-now`, `wdi-pop-ticket`,
`wdi-pop-ticket-item-<n>`, `wdi-pop-assign`, `wdi-pop-today`,
`wdi-pop-bar-<n>`, `wdi-pop-open`, `wdi-pop-stop`, `wdi-pop-stop-cancel`,
`wdi-pop-stop-confirm`. Every interactive one is an `St.Button` (or the
shell `Slider`) with `can_focus` and an `accessible_name`.

## 6. Modules (names frozen)

Pure modules (no `gi://` or `resource://` imports; `gjs -m` testable):

- `lib/day_model.js`: `currentStretch(day, slackMs = 60000)`,
  `lastEntry(day)`, `lastFocus(day)`, `sparkBuckets(day, minutes = 15)`,
  `appInitials(name)`, `ticketColor(ticket, variant)` (the app's palette
  and hashing, per `'light'|'dark'`), `clockTime(ms, zone, use24h)`,
  `hhmm(ms, zone)` (24-hour, for links), `appRoute(view, params)` (the
  app's `formatHash`), `appBaseFromLocation(controlBase, status,
  location)`, `parseAppUrlSetting(text)`.
- `lib/popover_model.js`: `INTERVAL_STEPS`, `intervalLabel(seconds)`,
  `nearestStep(seconds)`, `popoverView(status, opts)` returning one plain
  object with a key per block of §4 (`header`, `status`, `notices`,
  `tiles`, `input`, `interval`, `now`, `today`, `open`, `footer`) holding
  every string, flag and number the widgets render.

GI modules:

- `lib/app_client.js`: `class AppClient` with `constructor({control,
  settings})` (`control`: the `ControlClient`, for its base_url;
  `settings`: `{get(key)}`), `async base(cancellable)` (origin or `null`),
  `async day(date, cancellable)` (`TimesheetDay`, or `null` for 404/no app
  server), `async assign(body, cancellable)`, `url(view, params)` (string or
  `null`), `destroy()`. Errors are `AppError` with `{status, code,
  unreachable}`.
- `lib/popover.js`: the widgets, rendering a `popoverView` object; owns no
  state beyond widget state (expanded list, dragged slider value, stop
  confirmation).

## 7. Tests

1. Pure models: unit tests per module, including the app's own expectations
   where the app has tests (`day.ts` behavior) and every state of §4.
2. `AppClient` against `tests/fake_app.js` (loopback Soup fake of the two
   routes that also records request headers): discovery cases of §3.1
   (absolute loopback, relative `/app/`, non-loopback refused, `404`, no
   Location, override valid/invalid), the forbidden headers of §3.2 are
   never sent, `404` day → `null`, Assign body keys exactly as §3.5,
   `409` code surfaces.
3. Screenshot harness (`scripts/shots.sh`, §8) for the visual check.
4. `make check` stays the gate; every new test file joins `make test`.

## 8. Screenshot harness

`scripts/shots.sh [scenario…]` starts a fully isolated headless GNOME
Shell (private XDG dirs, private session bus with dconf only, empty private
system bus, host dconf mtime unchanged), with this extension and a test
helper extension, plus fake control and app servers serving scenario
fixtures. For each scenario and each of dark/light it opens the indicator's
menu, runs the scenario's steps (clicks by actor name, waits), waits for
the menu to settle, and saves `build/shots/<scenario>-<dark|light>.png`
cropped to the menu with a small margin. Scenarios are JSON files under
`tests/shots/scenarios/`. Synthetic data only.

## Amendment 1 (after wave 1)

1. **IPv4 loopback only.** The app server grants the local principal only
   for `Host: 127.0.0.1[:port]` (whatdidido `docs/API.md`, rule 2), so
   `http://[::1]:<port>` is refused for the `app-url` setting and for a
   discovered `Location` (§3.1). A missing port is refused too.
2. **Error envelope.** The app server answers errors as
   `{"error": {"code": "conflict", ...}}`; the client reads both that and a
   bare string (§3.5).
3. **PHI and Now dates.** `<d>` in §3.6 is `day.date` when a day is
   loaded, else this machine's local date.
4. **Light/dark** (§2.3) follow `Main.getStyleVariant()` (updated on
   `St.Settings` `notify::color-scheme`), not `color-scheme == 'default'`:
   on GNOME Shell 50 `default` renders the dark style.
5. **Interval labels** follow the app's `intervalLabel` exactly (the 90 s
   stop reads "2 min", like the app).
6. **Harness hook.** The harness's `BackdatePause` reaches the
   indicator's `_reminder._pausedSince` and `_render()`; keep those names
   (or update `tests/shots/wdishots@wporter.org/extension.js` with them).

## Amendment 2 (after the adversarial review)

1. **No redirects anywhere.** Every app-server request (`day`, `assign`)
   is sent with `Soup.MessageFlags.NO_REDIRECT`, like discovery. A 3xx is
   an ordinary failure (`HTTP 302`): logged once, Now card and Today bars
   hidden. (Review: high, a redirect sent the day request off 127.0.0.1.)
2. **A pending interval change is committed, not dropped.** Closing the
   menu while the keyboard/scroll commit timer runs commits the pending
   stop at once (§4.6).
3. **After a commit the slider keeps the committed stop** until a status
   reports that value or 3 s pass, so it never snaps back for one poll.
4. **Visible keyboard focus on the slider** in both variants (accent ring
   on the handle or a focus outline on its block), like the other controls.
5. **Rebuilding the Today bars never re-enters the render** and never
   drops keyboard focus into nothing: if a bar had focus, focus moves to
   the bar at the same index (or the last bar), else to the Today block.
6. **An Assign error clears when the menu closes.**
7. **HiDPI:** the harness takes `SHOTS_SCALE` (1 default, 2 for a
   scale-2 monitor) and the popover is checked at scale 2.
