# Screenshot harness

`scripts/shots.sh` takes screenshots of the whatdidido menu in a private
headless GNOME Shell 50, against fake control and app servers that serve
synthetic scenarios (docs/POPOVER.md §8).

## Run

```sh
make shots                              # every scenario, dark and light
make shots SCENARIOS="recording-full paused"
scripts/shots.sh recording-full         # same thing, directly
SHOTS_VARIANTS=light scripts/shots.sh recording-full   # one variant
```

One scenario in both variants takes about 5 s (shell startup ~1.5 s, then
~1.7 s per shot). PNGs land in `build/shots/<scenario>-<dark|light>.png`,
cropped to the open menu plus 16 px (the panel button is included when it
fits), with `build/shots/results.json` (status, error, notes, ms per shot).
Each line of output is `PASS`, `FAIL` (with the reason) or `SKIP`; the exit
status is non-zero if any shot failed, after all of them ran.

Environment: `SHOTS_TIMEOUT` (whole run, default 600 s), `SHOTS_ANIMATIONS=1`
(keep animations; default off for stable images), `SHOTS_VARIANTS`,
`SHOTS_TZ` (default `America/New_York`), `SHOTS_EXT_SRC` (another extension
tree), `SHOTS_KEEP=1` (keep the run dir `.shots/run-*/` with
`gnome-shell.log`, `fakes.log`, `session.log`; it is always kept when a run
fails), `SHOTS_SCALE=2` (a 2560x1600 virtual monitor at scale 2, through a
private `monitors.xml`; default 1).

HiDPI: GNOME Shell 50 lays the scale-2 monitor out logically, so the stage
stays 1280x800 and St's scale factor stays 1 while the framebuffer, and so
every PNG, is 2x (mutter rejects a physical layout for the virtual monitor).
Crops are computed in stage pixels and each PNG must come out at monitor
scale / St scale times the crop, or the shot fails.

Checks done on every run, besides each scenario's own expectations:

- light and dark really differ: the mean luminance inside the menu must be
  more than 40 (of 255) higher in light than in dark. Light is
  `color-scheme 'prefer-light'`: GNOME 50's user session mode is
  `prefer-dark`, so `'default'` keeps the dark shell style;
- no `JS ERROR`, extension error, helper warning or negative-size
  allocation in the shell log;
- the shell runs at the `SHOTS_SCALE` asked for;
- the host's `~/.config/dconf/user` mtime is unchanged.

`gjs -m tests/shots/fakes_test.js <scratch-dir>` checks the fakes alone.

## Scenarios

`tests/shots/scenarios/<name>.json`:

| key | meaning |
| --- | --- |
| `extends` | another scenario to start from; objects merge key by key, anything else (arrays, `null`) replaces. `description`, `tags`, `steps`, `expect_*` and `paused_minutes` are not inherited |
| `control` | `{"status": {...}}` served as `GET /control/v1/status` (whatdidido CONTROL_API.md), or `null`: not running, no control.json |
| `microphones` | `GET /control/v1/microphones` items (`id`, `label`, `stable_id`) |
| `app` | the timesheet day fixture, `{"timesheet": false}` (day answers 404) or `null` (same) |
| `settings` | the extension's settings (JSON values; set after a reset to the schema defaults) |
| `steps` | `{"click": "<actor name>"}`, `{"clickLabel": "<label text>"}`, `{"hover": "<actor name>"}`, `{"key": "Escape"}` (or a keyval number), `{"wait_ms": 500}`, `{"focus": "<actor name>"}` (keyboard focus there, for deep controls), `{"expect_focus": "<actor name>"}` (fails unless that menu actor has keyboard focus and its `:focus` style), `{"app": {...}}` (a new day fixture while the menu stays open, fetched at once) |
| `tags` | `needs-popover`: SKIP unless the menu has an actor named `wdi-pop`; `old-menu`: for today's menu, drop with it |
| `paused_minutes` | move the extension's pause start back (the paused-for text) |
| `expect_labels` | label texts that must be visible in the menu |
| `expect_requests` | `{"method", "path"}` the extension must have sent |
| `expect_status` | keys of the fake's status after the steps (e.g. `{"state": "paused"}`) |

Day fixture (`app`): times are local wall-clock `"HH:MM"` on whatever date
the extension asks for, in `$TZ`, so a shot looks the same on any run date:

```json
{
  "now": "17:42",
  "windows": {"sd": {"app_id": "org.example.ServiceDesk.desktop", "app_name": "Service Desk", "title": "#4101 — …"}},
  "segments": [["08:00", "09:30", "active", "sd"], ["09:30", "09:45", "idle", null]],
  "entries": [{"start": "08:00", "end": "09:30", "ticket": "#4101", "client": "Contoso", "category": "Network", "billable": true}],
  "tickets": ["#4101"],
  "ticket_defaults": [{"ticket": "#4101", "client": "Contoso", "category": "Network", "billable": true}]
}
```

The fake derives the rest of the `TimesheetDay` (`span`, `intervals`,
`unassigned` = segment time no entry covers, `totals`, ...). An Assign
(`POST /api/v1/timesheet/assignments`, exactly the seven keys) answers 201,
is recorded and turns that stretch into an entry. The admin's `POST /app`
replaces only the day fixture (the `app` step). Commands, `mic` and
`interval` change the fake's status (pause → paused, resume and start →
recording, stop → stopped).

Adding a scenario: copy one that is close, usually with
`"extends": "recording-full"` and only the keys that differ, then
`scripts/shots.sh <name>` and look at the PNGs. Synthetic data only
(fictional companies, tickets like `#4101`).

Each shot starts clean: the fakes load the scenario (fresh token), the
extension is disabled, its settings are reset and set, it is enabled again,
the menu is opened with a real click on the panel button, the steps run,
the pointer is parked away from the menu (unless the last step hovers), and
the shot is taken once no transition runs on the menu's actors and its
bounds have not changed for 400 ms. If a step closed the menu (today's menu
items do), it is opened again first.

## Helper extension

`wdishots@wporter.org` (test only, never packed or installed) exports
`org.wporter.WdiShots` on the private session bus: `Ping`, `Status`,
`OpenMenu(uuid)`, `CloseMenu`, `Click(name)`, `ClickLabel(text)`,
`Hover(name)`, `Key(keyval)`, `PointerMove(x, y)`, `SetSetting(key,
gvariantText)`, `ResetSettings`, `SetInterface(key, gvariantText)`,
`SetEnabled(uuid, enabled)`, `MenuBounds`, `MenuLabels`,
`FindActors(prefix)`, `Settle`, `Screenshot(path, x, y, w, h)`,
`BackdatePause(ms)`, `Focus(name)`, `KeyFocus`, `RefreshDay`,
`HideOverview`, `Log`. `OpenMenu` first drops every
notification source, so no startup banner shows behind the menu.

Shots repeat pixel for pixel between runs, except a crop wider than about
700 px (today's menu with `long-strings`): it reaches the top-bar clock.
The 340 px popover's crop stays clear of it. Clicks move a virtual pointer to
the actor's transformed center and press and release a real button; they
fail if the actor is missing, not visible, insensitive or covered.
A D-Bus call that gets no answer in 15 s counts as a hung shell: the driver
sends it SIGABRT (JS stack in `gnome-shell.log`) and stops.

## Isolation

- `HOME`, `XDG_CONFIG_HOME` (so dconf), `XDG_DATA_HOME` (the extensions,
  schemas compiled there, never in the worktree), `XDG_CACHE_HOME`,
  `XDG_STATE_HOME` live under `.shots/run-*/`; the environment is rebuilt
  with `env -i`.
- A private session bus that can only activate `ca.desrt.dconf`, and an
  empty private system bus (no logind, GDM, NetworkManager of the host).
  Sockets are in a short private runtime dir (`mktemp -d`, removed after).
- The fakes bind 127.0.0.1 on OS-picked ports and write control.json only
  into that private runtime dir; nothing talks to a real whatdidido server.
  Links the menu opens go to a stand-in browser that only appends them to
  `.shots/run-*/opened-urls.txt`.
- Every process of the run carries `SHOTS_RUN_MARK=<run dir>` in its
  environment; the shell and the fakes are stopped by PID, and any survivor
  with the mark is stopped at the end (also on timeout or Ctrl+C).
- The host's dconf database mtime is printed before and after; a change
  fails the run. The host's own gsd-color writes
  `night-light-last-coordinates` now and then, which can trip this without
  the harness being involved; the message says so.
