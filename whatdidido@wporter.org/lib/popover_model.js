// The top-bar popover as plain data (POPOVER.md section 4): no GI imports, so
// it runs under plain `gjs -m` tests. lib/popover.js renders the object
// popoverView() returns and owns only widget state, which it passes back in
// as `ui`; every string, flag, number and action comes from here.
//
// Actions a control triggers are plain objects the widgets hand to the
// extension:
//   {action: 'settings'}                    open the preferences
//   {action: 'command', command}            POST /control/v1/command (start, pause, resume, stop)
//   {action: 'mic', on}                     MicController.toggle(on)
//   {action: 'choose-mic', item}            MicController.choose(item) (a mic_model source item)
//   {action: 'window', on}                  set report-active-window
//   {action: 'expand', list}                show inline list 'input' | 'ticket' (null: collapse)
//   {action: 'pick-ticket', ticket}         remember the picked ticket
//   {action: 'assign', body}                AppClient.assign(body)
//   {action: 'ask-stop'} / {action: 'cancel-stop'}   the footer's stop confirmation
//   {action: 'interval', seconds}           POST /control/v1/interval (the slider, on commit)
// Links are {view, params} for AppClient.url(view, params).

import {activeMicLabel, micSwitchLabel} from './mic_model.js';
import {allowedActions, lastErrorText, micSwitch, stateLabel} from './model.js';
import {pausedForText} from './pause_reminder.js';
import {
    appInitials, clockTime, currentStretch, hhmm, lastEntry, lastFocus, localDate, sparkBuckets, ticketColor,
} from './day_model.js';

/** The app's interval stops (seconds), 5 s .. 1 h. */
export const INTERVAL_STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 300, 600, 900, 1800, 3600];

/** How long a committed stop is held while no status reports it (Amendment 2.3). */
export const INTERVAL_HOLD_MS = 3000;

/**
 * The stop the slider keeps after a commit (POPOVER.md Amendment 2.3): the
 * held index until a status reports its seconds or its deadline passes.
 * @param {{index: number, seconds: number, until: number}|null} hold
 * @param {number|null} sessionSeconds the status's interval_seconds
 * @param {number} nowMs the clock `until` is on
 * @returns {number|null} the index to show, or null (the hold is over)
 */
export function heldIndex(hold, sessionSeconds, nowMs) {
    if (!hold || !Number.isInteger(hold.index) || hold.index < 0 || hold.index >= INTERVAL_STEPS.length)
        return null;
    if (sessionSeconds === hold.seconds || !(nowMs < hold.until))
        return null;
    return hold.index;
}

/**
 * The app's interval label (core/time.ts): "5 s", "2 min", "1 h", "1.5 h".
 * Minutes are rounded, so 90 s is "2 min", as in the app.
 * @param {number} seconds
 * @returns {string} '?' for a value that is not a positive number
 */
export function intervalLabel(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
        return '?';
    if (seconds < 60)
        return `${seconds} s`;
    if (seconds < 3600)
        return `${Math.round(seconds / 60)} min`;
    return `${Math.round(seconds / 360) / 10} h`.replace('.0 h', ' h');
}

/**
 * Index in INTERVAL_STEPS of the stop nearest to `seconds` (ties: the
 * smaller stop; not a number: 0), for the slider's thumb.
 * @param {number} seconds
 * @returns {number} 0..INTERVAL_STEPS.length - 1
 */
export function nearestStep(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds))
        return 0;
    return INTERVAL_STEPS.reduce((best, s, i) =>
        Math.abs(s - seconds) < Math.abs(INTERVAL_STEPS[best] - seconds) ? i : best, 0);
}

/**
 * Body for POST /api/v1/timesheet/assignments (POPOVER.md 3.5): exactly
 * start, end, ticket, client, category, note, billable, with the day's
 * ticket_defaults for the ticket ('', '', true when absent).
 * @param {object} day TimesheetDay
 * @param {{start: string, end: string}} stretch currentStretch(day)
 * @param {string} ticket
 * @returns {{start: string, end: string, ticket: string, client: string, category: string, note: string, billable: boolean}}
 */
export function assignmentBody(day, stretch, ticket) {
    const d = ticketDefaults(day, ticket);
    return {
        start: stretch.start,
        end: stretch.end,
        ticket,
        client: typeof d?.client === 'string' ? d.client : '',
        category: typeof d?.category === 'string' ? d.category : '',
        note: '',
        billable: typeof d?.billable === 'boolean' ? d.billable : true,
    };
}

function ticketDefaults(day, ticket) {
    const list = day?.suggestions?.ticket_defaults;
    return Array.isArray(list) ? list.find(d => d?.ticket === ticket) ?? null : null;
}

/** "The timesheet changed. Try again." for an AppError with code 'conflict', else "Couldn't assign that time.". */
export function assignErrorText(err) {
    return err?.code === 'conflict' ? 'The timesheet changed. Try again.' : "Couldn't assign that time.";
}

/** How an entry is named: ticket, else category, else client (the app's groupLabel). */
export function entryLabel(a) {
    return a?.ticket || a?.category || a?.client || 'Unlabeled';
}

export const NOT_RUNNING_TITLE = 'Capture not running';
export const NOT_RUNNING_DETAIL = 'No work session is running on this computer. Start one to record; ' +
    'everything already captured stays browsable.';
export const POLL_ERROR_TITLE = "Can't read the capture status";
export const APP_URL_NOTICE = 'App server URL in Settings is not a local address';
export const PAUSED_TEXT = 'Nothing is captured while paused';

// The extension's own amber (stylesheet.css, dark) and the GNOME skin's
// --faint (tokens.css), for the Today bars that are not ticket-colored.
// Light amber #7f5900: 6.0:1 on the light popup background #fafafb, 5.1:1 on
// a block tinted with the foreground at 10%.
export const WARN_COLORS = {light: '#7f5900', dark: '#f6d32d'};
export const FAINT_COLORS = {light: '#9a9a9f', dark: '#77767b'};

const LIVE_STATES = ['recording', 'paused', 'starting', 'recovering'];

const PRIMARY = {
    pause: {icon: 'media-playback-pause-symbolic', accessibleName: 'Pause recording', accent: false},
    resume: {icon: 'media-playback-start-symbolic', accessibleName: 'Resume recording', accent: true},
    start: {icon: 'media-playback-start-symbolic', accessibleName: 'Start recording', accent: false},
};

function isCount(n) {
    return Number.isInteger(n) && n >= 0;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function statusBlock(status, running, pollError, pausedMs, busy) {
    if (!running) {
        const error = !!pollError;
        return {
            name: 'wdi-pop-status',
            kind: error ? 'error' : 'not-running',
            mark: error ? 'info' : 'power',
            icon: error ? 'dialog-information-symbolic' : 'system-shutdown-symbolic',
            pulse: false,
            paused: false,
            title: error ? POLL_ERROR_TITLE : NOT_RUNNING_TITLE,
            subtitle: error ? pollError : NOT_RUNNING_DETAIL,
            primary: null,
        };
    }
    const state = status.state;
    let subtitle;
    if (state === 'paused')
        subtitle = pausedMs !== null && pausedMs !== undefined ? `${pausedForText(pausedMs)} · nothing is captured` : PAUSED_TEXT;
    else if (state === 'stopped')
        subtitle = "Start recording when you're ready";
    else if (state === 'failed')
        subtitle = 'The session stopped after an error';
    else {
        const monitors = isCount(status.monitors) ? status.monitors : 0;
        const mic = status.mic?.available === true ? ` · mic ${status.mic.on === true ? 'on' : 'off'}` : '';
        subtitle = `${plural(monitors, 'monitor')} · every ${intervalLabel(status.interval_seconds)}${mic}`;
    }
    const allowed = allowedActions(state);
    const command = ['pause', 'resume', 'start'].find(a => allowed[a]) ?? null;
    return {
        name: 'wdi-pop-status',
        kind: 'session',
        mark: state === 'recording' ? 'recording' : state === 'paused' ? 'paused' : 'idle',
        icon: null,
        pulse: state === 'recording',
        paused: state === 'paused',
        title: state === 'recovering' && status.waiting_for_unlock === true ? 'Waiting for unlock' : stateLabel(state),
        subtitle,
        primary: command ? {
            name: 'wdi-pop-primary',
            ...PRIMARY[command],
            sensitive: !busy,
            action: {action: 'command', command},
        } : null,
    };
}

function micTile(status, running, mics) {
    const mic = running ? status.mic : null;
    const sw = micSwitch(status, running);
    let subtitle;
    if (!mic || mic.available !== true) {
        subtitle = 'No audio in this session';
    } else if (mic.on === true) {
        // micSwitchLabel is "Microphone[: <label>][ (<trouble>)]"; reuse its
        // trouble text ("waiting for device", ...) rather than restating it.
        const label = activeMicLabel(mic, mics);
        const full = micSwitchLabel(status, running, mics);
        const head = label ? `Microphone: ${label}` : 'Microphone';
        const trouble = full.startsWith(head) ? full.slice(head.length) : '';
        subtitle = `On · ${label ?? 'input'}${trouble}`;
    } else {
        subtitle = 'Off · no audio';
    }
    const on = sw.on && mic?.available === true;
    return {
        name: 'wdi-pop-mic',
        visible: true,
        title: 'Microphone',
        accessibleName: 'Microphone',
        subtitle,
        icon: on ? 'audio-input-microphone-symbolic' : 'microphone-disabled-symbolic',
        on,
        accent: on,
        sensitive: sw.sensitive,
        action: {action: 'mic', on: !on},
    };
}

function phiTile(status, running, base, date) {
    const n = running ? status.describe_withheld : undefined;
    const visible = typeof n === 'number' && Number.isFinite(n);
    return {
        name: 'wdi-pop-phi',
        visible,
        title: 'PHI guard',
        accessibleName: 'PHI guard: review withheld frames in Timeline',
        subtitle: visible ? `${n} frame${n === 1 ? '' : 's'} withheld` : '',
        count: visible ? n : null,
        icon: 'security-high-symbolic',
        sensitive: visible && !!base,
        link: {view: 'timeline', params: {date, phi: '1'}},
    };
}

function windowTile(win, running) {
    const on = !!win?.on;
    const sensitive = !!win?.sensitive;
    let subtitle;
    if (!sensitive)
        subtitle = running ? 'Not enabled on the server' : 'Off';
    else
        subtitle = on ? 'Recording window titles' : 'Off';
    return {
        name: 'wdi-pop-window',
        visible: true,
        title: 'Active window',
        accessibleName: win?.label ?? 'Record active window',
        subtitle,
        icon: 'focus-windows-symbolic',
        on,
        accent: on && sensitive,
        sensitive,
        action: {action: 'window', on: !on},
    };
}

function inputBlock(status, running, micView, mics, micChoiceLabel, expanded) {
    const mic = running ? status.mic : null;
    const visible = mic?.available === true;
    const sources = Array.isArray(micView?.sources) ? micView.sources : [];
    const active = mic?.on === true ? activeMicLabel(mic, mics) : null;
    const saved = micChoiceLabel || sources.find(s => s.checked)?.label || '';
    const value = active || saved || 'Choose…';
    const open = visible && expanded === 'input';
    return {
        name: 'wdi-pop-input',
        visible,
        title: 'Input',
        value,
        accessibleName: `Microphone input: ${value}`,
        expanded: open,
        sensitive: visible,
        action: {action: 'expand', list: open ? null : 'input'},
        items: sources.map((item, index) => ({
            index,
            name: `wdi-pop-input-item-${index}`,
            label: item.label,
            checked: !!item.checked,
            accessibleName: item.label,
            action: {action: 'choose-mic', item},
        })),
        emptyText: sources.length ? null : Array.isArray(mics) ? 'No microphones found' : 'Microphones unavailable',
    };
}

function intervalBlock(status, running, dragIndex, hold, nowMs, intervalBusy) {
    const max = INTERVAL_STEPS.length - 1;
    const dragging = Number.isInteger(dragIndex) && dragIndex >= 0 && dragIndex <= max;
    const seconds = running ? status.interval_seconds : null;
    const held = dragging || !running ? null : heldIndex(hold, seconds, nowMs);
    const shown = dragging ? dragIndex : held;
    const index = shown !== null ? shown : nearestStep(seconds);
    const value = shown !== null ? intervalLabel(INTERVAL_STEPS[shown]) : intervalLabel(seconds);
    return {
        name: 'wdi-pop-interval',
        visible: running,
        title: 'Screenshot interval',
        value,
        accessibleName: 'Screenshot interval',
        steps: INTERVAL_STEPS,
        index,
        max,
        fraction: index / max,
        seconds: shown !== null ? INTERVAL_STEPS[shown] : seconds,
        sessionSeconds: seconds,
        dragging,
        holding: held !== null,
        sensitive: running && LIVE_STATES.includes(status.state) && !intervalBusy,
    };
}

function nowBlock(day, base, recording, use24h, ui) {
    const hidden = {name: 'wdi-pop-now', visible: false, dimmed: false, overline: 'NOW', focus: null, stretch: null, last: null, error: null};
    if (!day)
        return hidden;
    const zone = day.zone;
    const seg = lastFocus(day);
    const stretch = currentStretch(day);
    const done = stretch ? null : lastEntry(day);
    if (!seg && !stretch && !done)
        return hidden;
    const timesheet = {view: 'timesheet', params: {date: day.date}};
    const focus = seg ? {
        appId: seg.window.app_id ?? '',
        appName: seg.window.app_name ?? '',
        title: seg.window.title ?? '',
        initials: appInitials(seg.window.app_name ?? ''),
        accessibleName: `${seg.window.app_name}: ${seg.window.title}. Open the timesheet`,
        sensitive: !!base,
        link: timesheet,
    } : null;
    let stretchView = null;
    if (stretch) {
        const tickets = Array.isArray(day.suggestions?.tickets) ? day.suggestions.tickets : [];
        const picked = typeof ui.ticket === 'string' ? ui.ticket : '';
        const busy = !!ui.assignBusy;
        const open = ui.expanded === 'ticket';
        stretchView = {
            start: stretch.start,
            end: stretch.end,
            text: `${clockTime(Date.parse(stretch.start), zone, use24h)} – now is unassigned`,
            ticket: {
                name: 'wdi-pop-ticket',
                label: picked || 'Choose ticket…',
                accessibleName: picked ? `Ticket: ${picked}` : 'Choose ticket',
                expanded: open && !busy,
                sensitive: !busy && tickets.length > 0,
                action: {action: 'expand', list: open ? null : 'ticket'},
                items: tickets.map((t, index) => {
                    const client = ticketDefaults(day, t)?.client;
                    return {
                        index,
                        name: `wdi-pop-ticket-item-${index}`,
                        ticket: t,
                        label: client ? `${t} · ${client}` : t,
                        accessibleName: client ? `${t}, ${client}` : t,
                        checked: t === picked,
                        action: {action: 'pick-ticket', ticket: t},
                    };
                }),
            },
            assign: {
                name: 'wdi-pop-assign',
                label: 'Assign',
                accessibleName: 'Assign',
                busy,
                sensitive: !!picked && !busy && !!base,
                action: picked ? {action: 'assign', body: assignmentBody(day, stretch, picked)} : null,
            },
        };
    }
    return {
        name: 'wdi-pop-now',
        visible: true,
        dimmed: !recording,
        overline: 'NOW',
        focus,
        stretch: stretchView,
        last: done ? {
            ticket: done.assignment?.ticket ?? '',
            color: null,
            text: `${entryLabel(done.assignment)} until ${clockTime(Date.parse(done.clip_end), zone, use24h)}`,
        } : null,
        error: ui.assignError ?? null,
    };
}

function barKind(b) {
    if (b.state === 'paused')
        return 'paused';
    if (b.state !== 'active')
        return 'faint';
    return b.ticket === null ? 'accent' : 'ticket';
}

function barText(b) {
    if (b.state !== 'active')
        return b.state;
    return b.ticket === null ? 'unassigned' : b.ticket || 'internal';
}

const BAR_HEIGHT = {paused: 0.22, faint: 0.14};

function todayBlock(day, base, use24h, variant, hoverBar) {
    const buckets = day ? sparkBuckets(day) : [];
    if (!buckets.length)
        return {name: 'wdi-pop-today', visible: false, title: 'Today', range: '', label: '', bars: []};
    const zone = day.zone;
    const bars = buckets.map((b, index) => {
        const kind = barKind(b);
        const clock = clockTime(b.start, zone, use24h);
        const text = barText(b);
        return {
            index,
            name: `wdi-pop-bar-${index}`,
            start: b.start,
            end: b.end,
            state: b.state,
            ticket: b.ticket,
            kind,
            // null for 'accent': the widget uses the shell's -st-accent-color.
            color: kind === 'paused' ? WARN_COLORS[variant] : kind === 'faint' ? FAINT_COLORS[variant]
                : kind === 'accent' ? null : ticketColor(b.ticket, variant),
            height: BAR_HEIGHT[kind] ?? 0.3 + 0.7 * b.active,
            label: `${clock} · ${text}`,
            accessibleName: `${clock}: ${text}`,
            sensitive: !!base,
            link: {view: 'timeline', params: {date: day.date, t: hhmm(b.start + 7.5 * 60000, zone)}},
        };
    });
    const range = `${clockTime(Date.parse(day.span.start), zone, use24h)} – now`;
    const hovered = Number.isInteger(hoverBar) ? bars[hoverBar] : null;
    return {
        name: 'wdi-pop-today',
        visible: true,
        title: 'Today',
        range,
        label: hovered ? hovered.label : range,
        bars,
    };
}

function footerBlock(status, running, ui) {
    if (!running) {
        return {visible: false, text: '', stop: {name: 'wdi-pop-stop', visible: false, label: 'Stop session', accessibleName: 'Stop session', sensitive: false, action: {action: 'ask-stop'}},
            confirm: false, cancel: null, confirmStop: null};
    }
    const samples = isCount(status.samples) ? status.samples : 0;
    const pending = isCount(status.pending) ? status.pending : 0;
    const canStop = allowedActions(status.state).stop;
    const confirm = canStop && !!ui.stopConfirm;
    return {
        visible: true,
        text: status.state === 'paused' ? PAUSED_TEXT
            : `${samples.toLocaleString('en-US')} samples · ${pending.toLocaleString('en-US')} pending`,
        stop: {
            name: 'wdi-pop-stop',
            visible: canStop && !confirm,
            label: 'Stop session',
            accessibleName: 'Stop session',
            sensitive: !ui.commandBusy,
            action: {action: 'ask-stop'},
        },
        confirm,
        cancel: confirm ? {name: 'wdi-pop-stop-cancel', label: 'Cancel', accessibleName: 'Cancel stop', sensitive: true, action: {action: 'cancel-stop'}} : null,
        confirmStop: confirm ? {name: 'wdi-pop-stop-confirm', label: 'Stop now', accessibleName: 'Confirm stop', sensitive: !ui.commandBusy, action: {action: 'command', command: 'stop'}} : null,
    };
}

/**
 * Everything the popover renders, as plain data (POPOVER.md section 4).
 *
 * @param {object|null} status GET /control/v1/status, or null
 * @param {object} [opts]
 * @param {boolean} [opts.running] false: not running (no control file, refused)
 * @param {string|null} [opts.pollError] errorText of a poll failure other than "not running"
 * @param {string|null} [opts.notice] the last failed action's text
 * @param {number|null} [opts.pausedMs] PauseReminder.pausedFor(), or null
 * @param {{switchLabel: string, hint: string|null, sources: Array}} [opts.mic] MicController.view()
 * @param {Array|null} [opts.mics] MicController.mics (inventory; null = unknown)
 * @param {string} [opts.micChoiceLabel] the saved choice's label (MicController.preferred.label)
 * @param {{sensitive: boolean, on: boolean, label: string}} [opts.window] windowSwitchView()
 * @param {{base: string|null, day: object|null, invalidSetting: boolean}} [opts.app]
 *   app server origin (null: none), the TimesheetDay (null: none / 404 / not loaded),
 *   and whether the app-url setting is invalid
 * @param {number} [opts.nowMs] this machine's clock, for the local date of links without a day
 * @param {boolean} [opts.use24h] clock-format is 24h
 * @param {'light'|'dark'} [opts.variant]
 * @param {object} [opts.ui] widget state:
 *   expanded: 'input' | 'ticket' | null; ticket: the picked ticket ('' none);
 *   assignBusy: bool; assignError: string|null (assignErrorText); stopConfirm: bool;
 *   dragIndex: index into INTERVAL_STEPS while dragging or committing, else null;
 *   hold: {index, seconds, until (nowMs clock)} after a commit, else null (heldIndex);
 *   intervalBusy: bool; commandBusy: bool (a start/pause/resume/stop in flight);
 *   hoverBar: index of the hovered or focused Today bar, else null
 * @returns {object} Every interactive part has `name` (its frozen actor name,
 * POPOVER.md section 5), `accessibleName`, `sensitive`, and an `action` or a `link`.
 *   variant 'light'|'dark'; styleClass 'wdi-light'|'wdi-dark'; running; state (or null)
 *   header  {title, icon, settings: {name, icon, accessibleName, action}}
 *   status  {name, kind: 'session'|'not-running'|'error', mark: 'recording'|'paused'|'idle'|'power'|'info',
 *            icon (power/info only, else null), pulse, paused (amber tint), title, subtitle,
 *            primary: null | {name, icon, accessibleName, accent, sensitive, action}}
 *   notices [{index, name, text}]
 *   tiles   {visible, mic: {name, visible, title, subtitle, icon, on, accent, sensitive, action, accessibleName},
 *            phi: {name, visible, title, subtitle, count, icon, sensitive, link, accessibleName},
 *            window: {name, visible, title, subtitle, icon, on, accent, sensitive, action, accessibleName}}
 *   input   {name, visible, title, value, expanded, sensitive, action, accessibleName, emptyText (or null),
 *            items: [{index, name, label, checked, accessibleName, action}]}
 *   interval {name, visible, title, value, steps, index, max, fraction (0..1), seconds (shown),
 *            sessionSeconds (the status's), dragging, holding, sensitive, accessibleName}
 *   now     {name, visible, dimmed, overline, error (or null),
 *            focus: null | {appId, appName, title, initials, accessibleName, sensitive, link},
 *            stretch: null | {start, end, text,
 *              ticket: {name, label, expanded, sensitive, action, accessibleName,
 *                       items: [{index, name, ticket, label, checked, accessibleName, action}]},
 *              assign: {name, label, busy, sensitive, accessibleName, action (null until picked)}},
 *            last: null | {ticket, color (null), text}}
 *   today   {name, visible, title, range, label (the hovered bar's label, else range),
 *            bars: [{index, name, start, end, state, ticket, kind: 'ticket'|'accent'|'paused'|'faint',
 *                    color ('#rrggbb'; null for accent), height (0..1), label, accessibleName,
 *                    sensitive, link}]}
 *   open    {name, visible, label, accessibleName, sensitive, link}
 *   footer  {visible, text, confirm, stop: {name, visible, label, accessibleName, sensitive, action},
 *            cancel: null | {...}, confirmStop: null | {...}} (cancel/confirmStop only while confirming)
 */
export function popoverView(status, opts = {}) {
    const {
        pollError = null, notice = null, pausedMs = null, mic: micView = null, mics = null, micChoiceLabel = '',
        window: win = null, app = {}, nowMs = Date.now(), use24h = false, ui = {},
    } = opts;
    const variant = opts.variant === 'light' ? 'light' : 'dark';
    const running = (opts.running ?? true) && !!status;
    const base = app?.base ?? null;
    const day = app?.day ?? null;
    const date = day?.date ?? localDate(nowMs);

    const notices = [];
    if (notice)
        notices.push(notice);
    const lastError = running ? lastErrorText(status) : null;
    if (lastError)
        notices.push(lastError);
    if (micView?.hint)
        notices.push(micView.hint);
    if (app?.invalidSetting)
        notices.push(APP_URL_NOTICE);

    return {
        variant,
        styleClass: `wdi-${variant}`,
        running,
        state: running ? status.state : null,
        header: {
            title: 'whatdidido',
            icon: 'whatdidido.svg',
            settings: {name: 'wdi-pop-settings', icon: 'emblem-system-symbolic', accessibleName: 'Settings', action: {action: 'settings'}},
        },
        status: statusBlock(status, running, pollError, pausedMs, !!ui.commandBusy),
        notices: notices.map((text, index) => ({index, name: `wdi-pop-notice-${index}`, text})),
        tiles: {
            visible: running,
            mic: micTile(status, running, mics),
            phi: phiTile(status, running, base, date),
            window: windowTile(win, running),
        },
        input: inputBlock(status, running, micView, mics, micChoiceLabel, ui.expanded),
        interval: intervalBlock(status, running, ui.dragIndex, ui.hold ?? null, nowMs, !!ui.intervalBusy),
        now: nowBlock(day, base, running && status.state === 'recording', use24h, ui),
        today: todayBlock(day, base, use24h, variant, ui.hoverBar),
        open: {
            name: 'wdi-pop-open',
            visible: true,
            label: 'Open whatdidido',
            accessibleName: 'Open whatdidido',
            sensitive: !!base,
            link: {view: 'today', params: {}},
        },
        footer: footerBlock(status, running, ui),
    };
}
