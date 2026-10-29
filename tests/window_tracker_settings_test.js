// window_tracker.js against the real gschema (compiled into a scratch dir,
// memory backend: nothing touches dconf): the schema's defaults reach the
// reporter (window-title-ignore-digit-changes defaults to true, while the
// reporter's own default is false) and the a(sss) title rules arrive in the
// shape the model takes, and both follow changes.
// Run: gjs -m tests/window_tracker_settings_test.js <dir with gschemas.compiled>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SETTLE_MS} from '../whatdidido@wporter.org/lib/window_model.js';
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

const [schemaDir] = ARGV;
if (!schemaDir) {
    print('usage: gjs -m tests/window_tracker_settings_test.js <compiled schema dir>');
    System.exit(2);
}
const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, null, false);
const settings = new Gio.Settings({
    settings_schema: source.lookup('org.gnome.shell.extensions.whatdidido', false),
    backend: Gio.memory_settings_backend_new(),
});

function emitter(extra = {}) {
    const o = {handlers: new Map(), nextId: 1, ...extra};
    o.connect = (sig, fn) => {
        o.handlers.set(o.nextId, {sig, fn});
        return o.nextId++;
    };
    o.disconnect = id => o.handlers.delete(id);
    o.emit = sig => {
        for (const h of [...o.handlers.values()].filter(x => x.sig === sig))
            h.fn();
    };
    return o;
}
const R = (x, y, width, height) => ({x, y, width, height});
const win = emitter({title: 'Remote 30 FPS'});
win.get_title = () => win.title;
win.get_wm_class = () => 'ninja';
win.get_frame_rect = () => R(100, 100, 400, 300);
const display = emitter({focus_window: win});
display.get_n_monitors = () => 1;
display.get_monitor_geometry = () => R(0, 0, 1920, 1080);
const apps = {get_window_app: () => ({get_id: () => 'ninja.desktop', get_name: () => 'NinjaOne'})};

const sent = [];
const tracker = new WindowTracker({settings, send: p => {
    sent.push(p.title);
    return Promise.resolve({recorded: true});
}, log: () => {}, onUnavailable: () => {}, apps, display, monitorManager: emitter()});
// The reporter's timers, run by hand: in order, at once, but only those
// of at most maxMs (not the 15 s wait of a held counter tick).
let timers = [], timerId = 0;
tracker._reporter._setTimer = (ms, fn) => {
    timers.push({id: ++timerId, ms, fn});
    return timerId;
};
tracker._reporter._clearTimer = id => {
    timers = timers.filter(tm => tm.id !== id);
};
tracker._reporter._spacingMs = 0;
const fire = async (maxMs = SETTLE_MS) => {
    for (let tm; (tm = timers.find(x => x.ms <= maxMs));) {
        timers = timers.filter(x => x !== tm);
        tm.fn();
    }
    for (let i = 0; i < 20; i++)
        await null;
};
const tick = async title => {
    win.title = title;
    win.emit('notify::title');
    await fire();
};

tracker.updateStatus({state: 'recording', window_activity: {available: true, recorded: 0, dropped: 0, epoch: 0}}, true);
await fire();
eq('defaults: no rules, the title is sent', sent, ['Remote 30 FPS']);
await tick('Remote 31 FPS');
eq('schema default: a digit-only change is held (the filter is on)', [sent, timers.length], [['Remote 30 FPS'], 1]);

settings.set_value('window-title-rules', new GLib.Variant('a(sss)', [['ninja', 'Remote * FPS', 'Remote session']]));
await fire();
eq('a(sss) rules from GSettings are used (relabeled, not failed closed)', sent.at(-1), 'Remote session');

settings.set_value('window-title-rules', new GLib.Variant('a(sss)', []));
settings.set_boolean('window-title-ignore-digit-changes', false);
await fire();
await tick('Remote 32 FPS');
eq('filter turned off in GSettings: the tick is sent', sent.at(-1), 'Remote 32 FPS');

tracker.destroy();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
