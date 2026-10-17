// Run: gjs -m tests/popover_model_test.js
// Every block state of POPOVER.md section 4.
import {MicController} from '../whatdidido@wporter.org/lib/mic_model.js';
import {
    APP_URL_NOTICE, FAINT_COLORS, INTERVAL_STEPS, WARN_COLORS,
    assignErrorText, assignmentBody, intervalLabel, nearestStep, popoverView,
} from '../whatdidido@wporter.org/lib/popover_model.js';
import {ticketColor} from '../whatdidido@wporter.org/lib/day_model.js';
import {windowSwitchView} from '../whatdidido@wporter.org/lib/window_model.js';
import {sampleDay} from './fake_app.js';

let failed = 0;
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) {
        failed++;
        print(`FAIL ${name}: got ${g} want ${w}`);
    } else {
        print(`ok   ${name}`);
    }
}

const BASE = 'http://127.0.0.1:18851';
const MICS = [{id: 'm1', label: 'Built-in', stable_id: 'alsa-builtin'}, {id: 'm2', label: 'USB headset', stable_id: 'usb-headset'}];

function st(over = {}) {
    return {
        state: 'recording', monitors: 3, samples: 19872, pending: 2, interval_seconds: 5,
        waiting_for_unlock: false, last_error: null, reason: null,
        mic: {available: true, on: false, source_id: null},
        ...over,
    };
}

// A real MicController's view() for a saved choice and inventory.
function micView(status, {preferred = {}, mics = MICS, prompt = false, running = true} = {}) {
    const store = {'microphone-stable-id': preferred.stableId ?? '', 'microphone-id': preferred.id ?? '', 'microphone-label': preferred.label ?? ''};
    const c = new MicController({
        settings: {get: k => store[k], set: (k, v) => {
            store[k] = v;
        }},
        setMicOn: async () => {},
        readStatus: async () => status,
    });
    c.setInventory(mics);
    c.updateStatus(status, running);
    c.prompt = prompt;
    return {view: c.view(), controller: c};
}

function view(status, opts = {}) {
    const running = opts.running ?? true;
    const {view: mic, controller} = micView(status, {preferred: opts.preferred, mics: 'mics' in opts ? opts.mics : MICS, prompt: opts.prompt, running});
    return popoverView(status, {
        running,
        mic,
        mics: controller.mics,
        micChoiceLabel: controller.preferred.label,
        window: windowSwitchView(status, {running, enabled: opts.windowOn ?? true, unavailable: false}),
        app: {base: BASE, day: null, invalidSetting: false},
        nowMs: Date.parse('2026-10-15T15:10:00Z'),
        use24h: false,
        variant: 'dark',
        ui: {},
        ...opts.extra,
    });
}

const SAVED = {stableId: 'usb-headset', id: 'm2', label: 'USB headset'};

// --- intervals ------------------------------------------------------------------------
eq('steps (the app\'s)', INTERVAL_STEPS, [5, 10, 15, 20, 30, 45, 60, 90, 120, 300, 600, 900, 1800, 3600]);
eq('intervalLabel (app tests + every stop)', INTERVAL_STEPS.map(intervalLabel),
    ['5 s', '10 s', '15 s', '20 s', '30 s', '45 s', '1 min', '2 min', '2 min', '5 min', '10 min', '15 min', '30 min', '1 h']);
eq('intervalLabel: 1.5 h (app test)', intervalLabel(5400), '1.5 h');
eq('intervalLabel: 7 s off-stop', intervalLabel(7), '7 s');
eq('intervalLabel: not a number', [null, undefined, 0, -5, NaN].map(intervalLabel), ['?', '?', '?', '?', '?']);
eq('nearestStep: at stops', INTERVAL_STEPS.map(nearestStep), INTERVAL_STEPS.map((_, i) => i));
eq('nearestStep: between stops', [7, 8, 50, 100, 200, 2000, 3000, 99999, 1].map(nearestStep), [0, 1, 5, 7, 8, 12, 13, 13, 0]);
eq('nearestStep: a tie takes the smaller stop', nearestStep(25), 3);
eq('nearestStep: not a number', nearestStep(null), 0);

// --- header and variant -----------------------------------------------------------------
let v = view(st());
eq('header', [v.header.title, v.header.settings.name, v.header.settings.icon, v.header.settings.action],
    ['whatdidido', 'wdi-pop-settings', 'emblem-system-symbolic', {action: 'settings'}]);
eq('dark variant', [v.variant, v.styleClass], ['dark', 'wdi-dark']);
eq('light variant', popoverView(st(), {variant: 'light'}).styleClass, 'wdi-light');
eq('unknown variant is dark', popoverView(st(), {variant: 'x'}).variant, 'dark');

// --- status card ------------------------------------------------------------------------
const card = s => [s.kind, s.mark, s.pulse, s.paused, s.title, s.subtitle, s.primary && s.primary.action.command];
eq('recording', card(view(st()).status),
    ['session', 'recording', true, false, 'Recording', '3 monitors · every 5 s · mic off', 'pause']);
eq('recording, mic on', view(st({mic: {available: true, on: true, source_id: 'm2'}})).status.subtitle, '3 monitors · every 5 s · mic on');
eq('recording, no mic offered', view(st({mic: {available: false, on: false, source_id: null}})).status.subtitle, '3 monitors · every 5 s');
eq('recording, no mic object', view(st({mic: undefined})).status.subtitle, '3 monitors · every 5 s');
eq('one monitor, 1 min', view(st({monitors: 1, interval_seconds: 60})).status.subtitle, '1 monitor · every 1 min · mic off');
eq('primary pause', view(st()).status.primary,
    {name: 'wdi-pop-primary', icon: 'media-playback-pause-symbolic', accessibleName: 'Pause recording', accent: false, sensitive: true, action: {action: 'command', command: 'pause'}});
eq('paused with paused-for', card(view(st({state: 'paused'}), {extra: {pausedMs: 12 * 60000}}).status),
    ['session', 'paused', false, true, 'Paused', 'Paused for 12 min · nothing is captured', 'resume']);
eq('paused under a minute', view(st({state: 'paused'}), {extra: {pausedMs: 0}}).status.subtitle, 'Paused for <1 min · nothing is captured');
eq('paused without paused-for', view(st({state: 'paused'})).status.subtitle, 'Nothing is captured while paused');
eq('resume is accent', [view(st({state: 'paused'})).status.primary.accent, view(st({state: 'paused'})).status.primary.accessibleName],
    [true, 'Resume recording']);
eq('stopped', card(view(st({state: 'stopped'})).status),
    ['session', 'idle', false, false, 'Stopped', "Start recording when you're ready", 'start']);
eq('failed', card(view(st({state: 'failed', reason: 'capture_failed'})).status),
    ['session', 'idle', false, false, 'Failed', 'The session stopped after an error', 'start']);
eq('start is not accent', view(st({state: 'failed'})).status.primary.accent, false);
eq('starting', card(view(st({state: 'starting'})).status),
    ['session', 'idle', false, false, 'Starting…', '3 monitors · every 5 s · mic off', null]);
eq('recovering', card(view(st({state: 'recovering'})).status),
    ['session', 'idle', false, false, 'Reconnecting…', '3 monitors · every 5 s · mic off', null]);
eq('recovering, waiting for unlock', view(st({state: 'recovering', waiting_for_unlock: true})).status.title, 'Waiting for unlock');
eq('waiting_for_unlock only while recovering', view(st({waiting_for_unlock: true})).status.title, 'Recording');
eq('stopping', card(view(st({state: 'stopping'})).status),
    ['session', 'idle', false, false, 'Stopping…', '3 monitors · every 5 s · mic off', null]);
eq('primary insensitive while a command is in flight', view(st(), {extra: {ui: {commandBusy: true}}}).status.primary.sensitive, false);
v = view(null, {running: false});
eq('not running', [v.status.kind, v.status.mark, v.status.icon, v.status.title, v.status.subtitle, v.status.primary, v.running],
    ['not-running', 'power', 'system-shutdown-symbolic', 'Capture not running',
        'No work session is running on this computer. Start one to record; everything already captured stays browsable.', null, false]);
v = view(null, {running: false, extra: {pollError: 'Control token rejected'}});
eq('poll error', [v.status.kind, v.status.title, v.status.subtitle, v.status.primary],
    ['error', "Can't read the capture status", 'Control token rejected', null]);
eq('running but no status is not running', popoverView(null, {running: true}).status.kind, 'not-running');
eq('a status with running false is not running', popoverView(st(), {running: false}).status.kind, 'not-running');

// --- notices ----------------------------------------------------------------------------
eq('no notices', view(st()).notices, []);
v = view(st({last_error: 'capture', reason: 'capture_failed'}), {preferred: {}, prompt: true,
    extra: {notice: 'Not allowed in the current state', app: {base: null, day: null, invalidSetting: true}}});
eq('every notice, in order, with names', v.notices, [
    {index: 0, name: 'wdi-pop-notice-0', text: 'Not allowed in the current state'},
    {index: 1, name: 'wdi-pop-notice-1', text: 'Last error: capture (capture_failed)'},
    {index: 2, name: 'wdi-pop-notice-2', text: 'Choose a microphone'},
    {index: 3, name: 'wdi-pop-notice-3', text: APP_URL_NOTICE},
]);
eq('app-url notice text', APP_URL_NOTICE, 'App server URL in Settings is not a local address');
eq('missing microphone hint', view(st(), {preferred: SAVED, mics: [MICS[0]]}).notices.map(n => n.text), ['USB headset is not connected']);
eq('failed reason as a notice', view(st({state: 'failed', reason: 'capture_failed'})).notices.map(n => n.text), ['Failed: capture_failed']);
eq('no last-error notice when not running', view(null, {running: false}).notices, []);

// --- tiles: microphone ------------------------------------------------------------------
const mic = t => [t.subtitle, t.icon, t.on, t.accent, t.sensitive, t.action];
eq('mic off', mic(view(st(), {preferred: SAVED}).tiles.mic),
    ['Off · no audio', 'microphone-disabled-symbolic', false, false, true, {action: 'mic', on: true}]);
eq('mic on with label', mic(view(st({mic: {available: true, on: true, source_id: 'm2', label: 'USB headset', state: 'capturing'}}), {preferred: SAVED}).tiles.mic),
    ['On · USB headset', 'audio-input-microphone-symbolic', true, true, true, {action: 'mic', on: false}]);
eq('mic on, label from the inventory', view(st({mic: {available: true, on: true, source_id: 'm1'}})).tiles.mic.subtitle, 'On · Built-in');
eq('mic on, waiting for device', view(st({mic: {available: true, on: true, source_id: 'm2', label: 'USB headset', state: 'waiting_for_device'}})).tiles.mic.subtitle,
    'On · USB headset (waiting for device)');
eq('mic on, label with parentheses and trouble', view(st({mic: {available: true, on: true, source_id: 'm2', label: 'Headset (2)', state: 'retrying'}})).tiles.mic.subtitle,
    'On · Headset (2) (restarting)');
eq('mic on, no label known', view(st({mic: {available: true, on: true, source_id: 'gone'}}), {mics: []}).tiles.mic.subtitle, 'On · input');
eq('mic on, no label, trouble', view(st({mic: {available: true, on: true, source_id: 'gone', state: 'failed'}}), {mics: []}).tiles.mic.subtitle, 'On · input (failed)');
eq('mic unavailable', mic(view(st({mic: {available: false, on: false, source_id: null}})).tiles.mic),
    ['No audio in this session', 'microphone-disabled-symbolic', false, false, false, {action: 'mic', on: true}]);
eq('mic missing from the status', view(st({mic: undefined})).tiles.mic.subtitle, 'No audio in this session');
eq('mic unset: the tile still turns on (the controller opens the picker)', mic(view(st(), {preferred: {}}).tiles.mic),
    ['Off · no audio', 'microphone-disabled-symbolic', false, false, true, {action: 'mic', on: true}]);
eq('mic insensitive while starting', view(st({state: 'starting'})).tiles.mic.sensitive, false);
eq('mic sensitive while stopped', view(st({state: 'stopped'})).tiles.mic.sensitive, true);
eq('mic tile name', view(st()).tiles.mic.name, 'wdi-pop-mic');
eq('tiles hidden when not running', view(null, {running: false}).tiles.visible, false);
eq('tiles shown when running', view(st()).tiles.visible, true);

// --- tiles: PHI -------------------------------------------------------------------------
eq('PHI absent', view(st()).tiles.phi.visible, false);
v = view(st({describe_withheld: 3}));
eq('PHI n', [v.tiles.phi.visible, v.tiles.phi.subtitle, v.tiles.phi.sensitive, v.tiles.phi.link],
    [true, '3 frames withheld', true, {view: 'timeline', params: {date: '2026-10-15', phi: '1'}}]);
eq('PHI 1', view(st({describe_withheld: 1})).tiles.phi.subtitle, '1 frame withheld');
eq('PHI 0 still shows', [view(st({describe_withheld: 0})).tiles.phi.visible, view(st({describe_withheld: 0})).tiles.phi.subtitle], [true, '0 frames withheld']);
eq('PHI not a number', view(st({describe_withheld: '3'})).tiles.phi.visible, false);
eq('PHI without app server is insensitive', view(st({describe_withheld: 3}), {extra: {app: {base: null, day: null}}}).tiles.phi.sensitive, false);
eq('PHI date from the day', view(st({describe_withheld: 3}), {extra: {app: {base: BASE, day: {...sampleDay(), date: '2026-10-14'}}}}).tiles.phi.link.params.date, '2026-10-14');

// --- tiles: active window ---------------------------------------------------------------
const WA = {window_activity: {available: true, recorded: 0, dropped: 0, epoch: 0}};
const win = t => [t.subtitle, t.on, t.sensitive, t.accent, t.action];
eq('window on', win(view(st(WA)).tiles.window), ['Recording window titles', true, true, true, {action: 'window', on: false}]);
eq('window off', win(view(st(WA), {windowOn: false}).tiles.window), ['Off', false, true, false, {action: 'window', on: true}]);
eq('window not offered', win(view(st()).tiles.window), ['Not enabled on the server', true, false, false, {action: 'window', on: false}]);
eq('window 409 since the poll', win(popoverView(st(WA), {window: windowSwitchView(st(WA), {running: true, enabled: true, unavailable: true})}).tiles.window),
    ['Not enabled on the server', true, false, false, {action: 'window', on: false}]);
eq('window accessible name is the switch label', view(st()).tiles.window.accessibleName, 'Record active window (not enabled on the server)');

// --- input picker -----------------------------------------------------------------------
v = view(st({mic: {available: true, on: true, source_id: 'm2', label: 'USB headset'}}), {preferred: SAVED});
eq('input: active mic', [v.input.visible, v.input.value, v.input.expanded, v.input.action], [true, 'USB headset', false, {action: 'expand', list: 'input'}]);
eq('input: items with checked and names', v.input.items.map(i => [i.name, i.label, i.checked, i.action.action, i.action.item.id]),
    [['wdi-pop-input-item-0', 'Built-in', false, 'choose-mic', 'm1'], ['wdi-pop-input-item-1', 'USB headset', true, 'choose-mic', 'm2']]);
eq('input: saved choice while off', view(st(), {preferred: SAVED}).input.value, 'USB headset');
eq('input: saved choice not connected', view(st(), {preferred: SAVED, mics: [MICS[0]]}).input.value, 'USB headset');
eq('input: no choice', view(st()).input.value, 'Choose…');
eq('input: expanded', view(st(), {extra: {ui: {expanded: 'input'}}}).input.expanded, true);
eq('input: expanded collapses on click', view(st(), {extra: {ui: {expanded: 'input'}}}).input.action, {action: 'expand', list: null});
eq('input: the ticket list being open closes it', view(st(), {extra: {ui: {expanded: 'ticket'}}}).input.expanded, false);
eq('input: hidden without a microphone', view(st({mic: {available: false, on: false, source_id: null}})).input.visible, false);
eq('input: hidden when not running', view(null, {running: false}).input.visible, false);
eq('input: empty inventory', [view(st(), {mics: []}).input.items, view(st(), {mics: []}).input.emptyText], [[], 'No microphones found']);
eq('input: unknown inventory', view(st(), {mics: null}).input.emptyText, 'Microphones unavailable');

// --- interval ---------------------------------------------------------------------------
const iv = i => [i.value, i.index, i.sensitive, i.dragging];
eq('interval at a stop', iv(view(st({interval_seconds: 60})).interval), ['1 min', 6, true, false]);
eq('interval fraction and max', [view(st({interval_seconds: 3600})).interval.fraction, view(st()).interval.max, view(st()).interval.name], [1, 13, 'wdi-pop-interval']);
eq('interval between stops shows its own label', iv(view(st({interval_seconds: 7})).interval), ['7 s', 0, true, false]);
eq('interval 100 s', iv(view(st({interval_seconds: 100})).interval), ['2 min', 7, true, false]);
eq('interval while dragging', iv(view(st({interval_seconds: 7}), {extra: {ui: {dragIndex: 10}}}).interval), ['10 min', 10, true, true]);
eq('interval dragging seconds', view(st(), {extra: {ui: {dragIndex: 13}}}).interval.seconds, 3600);
eq('interval drag index out of range ignored', iv(view(st({interval_seconds: 30}), {extra: {ui: {dragIndex: 14}}}).interval), ['30 s', 4, true, false]);
for (const s of ['paused', 'starting', 'recovering'])
    eq(`interval sensitive while ${s}`, view(st({state: s})).interval.sensitive, true);
for (const s of ['stopped', 'failed', 'stopping'])
    eq(`interval insensitive while ${s}`, view(st({state: s})).interval.sensitive, false);
eq('interval insensitive while committing', view(st(), {extra: {ui: {intervalBusy: true}}}).interval.sensitive, false);
eq('interval hidden when not running', [view(null, {running: false}).interval.visible, view(null, {running: false}).interval.sensitive], [false, false]);

// --- Now card ---------------------------------------------------------------------------
const day = sampleDay();
const withDay = (status, ui = {}, extra = {}) => view(status, {extra: {app: {base: BASE, day, invalidSetting: false}, ui, ...extra}});
v = withDay(st());
eq('now: visible, not dimmed while recording', [v.now.visible, v.now.dimmed, v.now.overline, v.now.name], [true, false, 'NOW', 'wdi-pop-now']);
eq('now: focus', v.now.focus, {appId: 'org.gnome.Ptyxis', appName: 'Ptyxis Terminal', title: 'build — Contoso deploy', initials: 'PT',
    accessibleName: 'Ptyxis Terminal: build — Contoso deploy. Open the timesheet', sensitive: true, link: {view: 'timesheet', params: {date: '2026-10-15'}}});
eq('now: stretch text (server zone, 12h)', v.now.stretch.text, '10:40 AM – now is unassigned');
eq('now: stretch text 24h', withDay(st(), {}, {use24h: true}).now.stretch.text, '10:40 – now is unassigned');
eq('now: ticket picker unpicked', [v.now.stretch.ticket.name, v.now.stretch.ticket.label, v.now.stretch.ticket.expanded, v.now.stretch.ticket.sensitive],
    ['wdi-pop-ticket', 'Choose ticket…', false, true]);
eq('now: ticket items', v.now.stretch.ticket.items.map(i => [i.name, i.label, i.checked, i.action]), [
    ['wdi-pop-ticket-item-0', '#4101 · Northwind Traders', false, {action: 'pick-ticket', ticket: '#4101'}],
    ['wdi-pop-ticket-item-1', '#4102', false, {action: 'pick-ticket', ticket: '#4102'}],
    ['wdi-pop-ticket-item-2', '#4207 · Contoso', false, {action: 'pick-ticket', ticket: '#4207'}],
]);
eq('now: assign insensitive until picked', [v.now.stretch.assign.name, v.now.stretch.assign.sensitive, v.now.stretch.assign.action], ['wdi-pop-assign', false, null]);
v = withDay(st(), {ticket: '#4207', expanded: 'ticket'});
eq('now: picked ticket', [v.now.stretch.ticket.label, v.now.stretch.ticket.expanded, v.now.stretch.ticket.items[2].checked], ['#4207', true, true]);
eq('now: assign with ticket_defaults', [v.now.stretch.assign.sensitive, v.now.stretch.assign.action], [true, {action: 'assign', body: {
    start: '2026-10-15T14:40:00.000Z', end: '2026-10-15T15:10:00.000Z', ticket: '#4207', client: 'Contoso', category: 'Internal', note: '', billable: false,
}}]);
eq('now: assign body without defaults', withDay(st(), {ticket: '#4102'}).now.stretch.assign.action.body,
    {start: '2026-10-15T14:40:00.000Z', end: '2026-10-15T15:10:00.000Z', ticket: '#4102', client: '', category: '', note: '', billable: true});
eq('now: assign body keys exactly', Object.keys(assignmentBody(day, day.unassigned[2], '#4101')), ['start', 'end', 'ticket', 'client', 'category', 'note', 'billable']);
v = withDay(st(), {ticket: '#4101', assignBusy: true, expanded: 'ticket'});
eq('now: assign busy', [v.now.stretch.assign.sensitive, v.now.stretch.assign.busy, v.now.stretch.ticket.sensitive, v.now.stretch.ticket.expanded], [false, true, false, false]);
eq('now: assign error', withDay(st(), {assignError: assignErrorText({code: 'conflict'})}).now.error, 'The timesheet changed. Try again.');
eq('now: other assign error text', assignErrorText({code: 'invalid'}), "Couldn't assign that time.");
eq('now: assign insensitive without app server', view(st(), {extra: {app: {base: null, day}, ui: {ticket: '#4101'}}}).now.stretch.assign.sensitive, false);
eq('now: no tickets suggested', withDay(st(), {}, {}).now.stretch.ticket.sensitive && view(st(), {extra: {app: {base: BASE, day: {...day, suggestions: {tickets: [], ticket_defaults: []}}}}}).now.stretch.ticket.sensitive, false);
v = view(st(), {extra: {app: {base: BASE, day: {...day, unassigned: day.unassigned.slice(0, 2)}}}});
eq('now: no stretch, last entry', [v.now.stretch, v.now.last.text], [null, '#4101 until 10:00 AM']);
eq('now: last entry 24h', view(st(), {extra: {use24h: true, app: {base: BASE, day: {...day, unassigned: []}}}}).now.last.text, '#4101 until 10:00');
const noTicket = {...day.entries[0], assignment: {...day.entries[0].assignment, ticket: ''}};
eq('now: last entry without ticket uses the category', view(st(), {extra: {app: {base: BASE, day: {...day, unassigned: [], entries: [noTicket]}}}}).now.last.text,
    'Support until 10:00 AM');
v = view(st(), {extra: {app: {base: BASE, day: {...day, unassigned: [], entries: []}}}});
eq('now: no stretch, no entry: focus only', [v.now.visible, v.now.stretch, v.now.last, !!v.now.focus], [true, null, null, true]);
eq('now: nothing at all: hidden', view(st(), {extra: {app: {base: BASE, day: {...day, unassigned: [], entries: [], segments: []}}}}).now.visible, false);
eq('now: no day: hidden', view(st()).now.visible, false);
eq('now: dimmed while paused', withDay(st({state: 'paused'})).now.dimmed, true);
eq('now: dimmed when not running', view(null, {running: false, extra: {app: {base: BASE, day}}}).now.dimmed, true);
eq('now: focus insensitive without app server', view(st(), {extra: {app: {base: null, day}}}).now.focus.sensitive, false);

// --- Today bars -------------------------------------------------------------------------
v = withDay(st());
eq('today: visible with range', [v.today.visible, v.today.name, v.today.title, v.today.range, v.today.label], [true, 'wdi-pop-today', 'Today', '9:00 AM – now', '9:00 AM – now']);
eq('today: bar names', v.today.bars.map(b => b.name), Array.from({length: 9}, (_, i) => `wdi-pop-bar-${i}`));
eq('today: kinds', v.today.bars.map(b => b.kind), ['ticket', 'ticket', 'ticket', 'ticket', 'paused', 'faint', 'faint', 'accent', 'accent']);
eq('today: colors (dark)', v.today.bars.map(b => b.color), [...Array(4).fill(ticketColor('#4101', 'dark')), WARN_COLORS.dark, FAINT_COLORS.dark, FAINT_COLORS.dark, null, null]);
eq('today: colors (light)', withDay(st(), {}, {variant: 'light'}).today.bars.slice(3, 6).map(b => b.color),
    [ticketColor('#4101', 'light'), WARN_COLORS.light, FAINT_COLORS.light]);
eq('today: heights', v.today.bars.map(b => Math.round(b.height * 1000) / 1000), [1, 1, 1, 1, 0.22, 0.14, 0.14, 1, 0.767]);
eq('today: bar labels', v.today.bars.map(b => b.label), ['9:00 AM · #4101', '9:15 AM · #4101', '9:30 AM · #4101', '9:45 AM · #4101',
    '10:00 AM · paused', '10:15 AM · locked', '10:30 AM · locked', '10:45 AM · unassigned', '11:00 AM · unassigned']);
eq('today: accessible name', v.today.bars[0].accessibleName, '9:00 AM: #4101');
eq('today: link at the bar middle, 24h server zone', [v.today.bars[0].link, v.today.bars[8].link.params.t],
    [{view: 'timeline', params: {date: '2026-10-15', t: '09:07'}}, '11:07']);
eq('today: hover label', withDay(st(), {hoverBar: 4}).today.label, '10:00 AM · paused');
eq('today: hover out of range keeps the range', withDay(st(), {hoverBar: 40}).today.label, '9:00 AM – now');
eq('today: 24h', withDay(st(), {}, {use24h: true}).today.range, '09:00 – now');
const internal = {...day.entries[0], assignment: {...day.entries[0].assignment, ticket: ''}};
v = view(st(), {extra: {app: {base: BASE, day: {...day, entries: [internal]}}}});
eq('today: assigned without ticket is internal and neutral', [v.today.bars[0].label, v.today.bars[0].color], ['9:00 AM · internal', ticketColor('', 'dark')]);
eq('today: bars insensitive without app server', view(st(), {extra: {app: {base: null, day}}}).today.bars.every(b => !b.sensitive), true);
eq('today: no span hides', view(st(), {extra: {app: {base: BASE, day: {...day, span: null}}}}).today.visible, false);
eq('today: no day hides', view(st()).today.visible, false);

// --- Open whatdidido --------------------------------------------------------------------
eq('open with app', [view(st()).open.name, view(st()).open.label, view(st()).open.sensitive, view(st()).open.link],
    ['wdi-pop-open', 'Open whatdidido', true, {view: 'today', params: {}}]);
eq('open without app', view(st(), {extra: {app: {base: null, day: null}}}).open.sensitive, false);
eq('open shown when not running', [view(null, {running: false}).open.visible, view(null, {running: false}).open.sensitive], [true, true]);

// --- footer -----------------------------------------------------------------------------
v = view(st());
eq('footer counts', [v.footer.visible, v.footer.text], [true, '19,872 samples · 2 pending']);
eq('footer large pending grouped', view(st({pending: 1234})).footer.text, '19,872 samples · 1,234 pending');
eq('footer stop', [v.footer.stop.name, v.footer.stop.visible, v.footer.stop.label, v.footer.stop.sensitive, v.footer.stop.action, v.footer.confirm],
    ['wdi-pop-stop', true, 'Stop session', true, {action: 'ask-stop'}, false]);
eq('footer paused text', view(st({state: 'paused'})).footer.text, 'Nothing is captured while paused');
eq('footer no stop while stopped', view(st({state: 'stopped'})).footer.stop.visible, false);
eq('footer no stop while stopping', view(st({state: 'stopping'})).footer.stop.visible, false);
eq('footer stop while starting', view(st({state: 'starting'})).footer.stop.visible, true);
v = view(st(), {extra: {ui: {stopConfirm: true}}});
eq('footer stop confirm', [v.footer.confirm, v.footer.stop.visible, v.footer.cancel.name, v.footer.cancel.label, v.footer.cancel.action,
    v.footer.confirmStop.name, v.footer.confirmStop.label, v.footer.confirmStop.action],
[true, false, 'wdi-pop-stop-cancel', 'Cancel', {action: 'cancel-stop'}, 'wdi-pop-stop-confirm', 'Stop now', {action: 'command', command: 'stop'}]);
eq('footer confirm ignored when stop is not allowed', view(st({state: 'stopped'}), {extra: {ui: {stopConfirm: true}}}).footer.confirm, false);
eq('footer stop insensitive while a command is in flight', view(st(), {extra: {ui: {commandBusy: true}}}).footer.stop.sensitive, false);
eq('footer hidden when not running', view(null, {running: false}).footer.visible, false);
eq('footer missing counts are 0', popoverView({state: 'recording'}).footer.text, '0 samples · 0 pending');

if (failed) {
    print(`${failed} failed`);
    (await import('system')).default.exit(1);
}
print('all passed');
