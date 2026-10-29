// window_tracker.js glue against fake shell objects (no GNOME Shell needed):
// the focused window's position/size signals and the monitor manager's
// monitors-changed feed the reporter only when the window's monitor set
// changes (AT_REST_GUARD.md section 6); every handler is disconnected on a
// focus change and on disable.
// Run: gjs -m tests/window_tracker_test.js
import System from 'system';

import {COUNTER_SETTLE_MS, SETTLE_MS} from '../whatdidido@wporter.org/lib/window_model.js';
import {WindowTracker} from '../whatdidido@wporter.org/lib/window_tracker.js';

let failed = 0;
function eq(name, got, want) {
    const g = String(JSON.stringify(got)), w = String(JSON.stringify(want));
    if (g !== w) {
        failed++;
        print(`FAIL ${name}: got ${g.slice(0, 300)} want ${w.slice(0, 300)}`);
    } else {
        print(`ok   ${name}`);
    }
}

// A GObject-like signal emitter.
function emitter(extra = {}) {
    const o = {handlers: new Map(), nextId: 1, ...extra};
    o.connect = (sig, fn) => {
        o.handlers.set(o.nextId, {sig, fn});
        return o.nextId++;
    };
    o.disconnect = id => {
        if (!o.handlers.delete(id))
            throw new Error(`no handler ${id}`);
    };
    o.emit = sig => {
        for (const h of [...o.handlers.values()].filter(x => x.sig === sig))
            h.fn();
    };
    o.signals = () => [...o.handlers.values()].map(h => h.sig).sort();
    return o;
}
const R = (x, y, width, height) => ({x, y, width, height});
function fakeWindow(title, frame) {
    const w = emitter({title, frame});
    w.get_title = () => w.title;
    w.get_wm_class = () => 'a';
    w.get_frame_rect = () => w.frame;
    return w;
}

let layout = [R(0, 0, 1920, 1080), R(1920, 0, 1920, 1080)];
const display = emitter({focus_window: null});
display.get_n_monitors = () => layout.length;
display.get_monitor_geometry = i => layout[i];
const monitorManager = emitter();
const settings = emitter();
settings.get_boolean = () => true;
settings.get_strv = () => [];
settings.get_value = () => ({deep_unpack: () => []});
const apps = {get_window_app: () => ({get_id: () => 'a.desktop', get_name: () => 'A'})};
const sent = [];

const a = fakeWindow('A', R(100, 100, 400, 300));
const b = fakeWindow('B', R(2000, 100, 400, 300));
display.focus_window = a;
const tracker = new WindowTracker({
    settings, send: p => {
        sent.push(p);
        return Promise.resolve({recorded: true});
    }, log: () => {}, onUnavailable: () => {}, apps, display, monitorManager,
});
// Count what the glue reports to the reporter.
let changes = 0;
const reporter = tracker._reporter;
const changed = reporter.changed.bind(reporter);
reporter.changed = (...args) => {
    changes++;
    changed(...args);
};

const FIVE = ['notify::title', 'notify::wm-class', 'position-changed', 'size-changed', 'unmanaged'];
eq('connects focus-window on the display', display.signals(), ['notify::focus-window']);
eq('connects monitors-changed on the monitor manager', monitorManager.signals(), ['monitors-changed']);
eq('watches the focused window: title, wm-class, position, size, unmanaged', a.signals(), FIVE);

for (let x = 100; x < 1400; x += 5) {   // a drag inside the first monitor
    a.frame = R(x, 100, 400, 300);
    a.emit('position-changed');
}
eq('drag within a monitor: nothing reported', changes, 0);
a.frame = R(1700, 100, 400, 300);
a.emit('position-changed');
a.frame = R(1710, 100, 400, 300);
a.emit('position-changed');
eq('crossing into the second monitor: reported once', changes, 1);
a.frame = R(1710, 100, 500, 400);
a.emit('size-changed');
eq('resize keeping the set: nothing', changes, 1);
a.frame = R(100, 100, 400, 300);
a.emit('size-changed');
eq('resize back onto one monitor: reported', changes, 2);
layout = [R(0, 0, 2560, 1440)];
monitorManager.emit('monitors-changed');
eq('monitor layout change altering the set: reported', changes, 3);
monitorManager.emit('monitors-changed');
eq('same layout again: nothing', changes, 3);
layout = [R(0, 0, 1920, 1080), R(1920, 0, 1920, 1080)];
monitorManager.emit('monitors-changed');
eq('layout back: reported', changes, 4);

display.focus_window = b;
display.emit('notify::focus-window');
eq('focus change: reported, old window fully disconnected, new one watched', [changes, a.signals(), b.signals()],
    [5, [], FIVE]);
a.emit('position-changed');
b.frame = R(2100, 200, 400, 300);
b.emit('position-changed');
eq('old window ignored; new window moving within its monitor: nothing', changes, 5);

// The payload reads the frame and the layout (logical coordinates).
tracker.updateStatus({state: 'recording', window_activity: {available: true, recorded: 0, dropped: 0, epoch: 0,
    geometry: true}}, true);
eq('payload carries the focused window\'s monitors', [sent.at(-1)?.title, sent.at(-1)?.monitors],
    ['B', [[1920, 0, 1920, 1080]]]);
eq('payload carries changed_at', typeof sent.at(-1)?.changed_at, 'string');
tracker.updateStatus({state: 'stopped', window_activity: {available: true, recorded: 0, dropped: 0, epoch: 0,
    geometry: true}}, true);
eq('watching while stopped (poll-active cadence)', tracker.watching, true);
tracker.updateStatus(null, false);
eq('not watching while not running', tracker.watching, false);

tracker.destroy();
eq('destroy disconnects everything',
    [display.signals(), monitorManager.signals(), b.signals(), settings.signals()], [[], [], [], []]);

// unmanaged before disable still leaves nothing behind.
display.focus_window = a;
const t2 = new WindowTracker({settings, send: () => Promise.resolve({}), log: () => {}, onUnavailable: () => {},
    apps, display, monitorManager});
a.emit('unmanaged');
eq('unmanaged: the window is disconnected', a.signals(), []);
t2.destroy();
eq('destroy after unmanaged: nothing left', [display.signals(), monitorManager.signals(), a.signals()], [[], [], []]);

// Title rules and the digit filter come from settings, and follow their changes.
const keys = {'report-active-window': true, 'window-title-ignore-digit-changes': true,
    'window-title-rules': [['a', '*secret*', 'hidden']]};
const s3 = emitter();
s3.get_boolean = k => keys[k];
s3.get_strv = () => [];
s3.get_value = k => ({deep_unpack: () => keys[k]});
const sent3 = [];
const c = fakeWindow('my secret 1', R(100, 100, 400, 300));
const d = fakeWindow('my secret 2', R(100, 100, 400, 300));
display.focus_window = c;
const t3 = new WindowTracker({settings: s3, send: p => {
    sent3.push(p.title);
    return Promise.resolve({recorded: true});
}, log: () => {}, onUnavailable: () => {}, apps, display, monitorManager});
// Timers fire in order, at once, but only those of at most maxMs.
let timers = [], timerId = 0;
t3._reporter._setTimer = (ms, fn) => {
    timers.push({id: ++timerId, ms, fn});
    return timerId;
};
t3._reporter._clearTimer = id => {
    timers = timers.filter(tm => tm.id !== id);
};
t3._reporter._spacingMs = 0;
const fire = async (maxMs = Infinity) => {
    for (let tm; (tm = timers.find(x => x.ms <= maxMs));) {
        timers = timers.filter(x => x !== tm);
        tm.fn();
    }
    for (let i = 0; i < 20; i++)
        await null;
};
t3.updateStatus({state: 'recording', window_activity: {available: true, recorded: 0, dropped: 0, epoch: 0}}, true);
await fire();
eq('tracker: rules from settings (wm_class "a" matches the app "a")', sent3, ['hidden']);
keys['window-title-rules'] = [];
s3.emit('changed::window-title-rules');
await fire();
eq('tracker: a rules change re-sends the current window', sent3, ['hidden', 'my secret 1']);
c.title = 'my secret 7';
c.emit('notify::title');
await fire(SETTLE_MS);
eq('tracker: a digit-only title change is held (filter on from settings)',
    [sent3.length, timers.map(tm => tm.ms > SETTLE_MS && tm.ms <= COUNTER_SETTLE_MS)], [2, [true]]);
await fire();
eq('tracker: ... and sent once it settles', sent3, ['hidden', 'my secret 1', 'my secret 7']);
c.title = 'my secret 8';
c.emit('notify::title');
await fire(SETTLE_MS);
keys['window-title-ignore-digit-changes'] = false;
s3.emit('changed::window-title-ignore-digit-changes');
await fire();
eq('tracker: turning the filter off sends it', sent3.at(-1), 'my secret 8');
keys['window-title-ignore-digit-changes'] = true;
s3.emit('changed::window-title-ignore-digit-changes');
await fire();
display.focus_window = d;
display.emit('notify::focus-window');
await fire();
eq('tracker: a focus change sends even a counter-alike title of the same app', sent3.at(-1), 'my secret 2');
t3.destroy();
eq('tracker: destroy disconnects the new settings too', s3.signals(), []);

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
