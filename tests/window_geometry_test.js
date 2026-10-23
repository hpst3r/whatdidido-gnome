// Run: gjs -m tests/window_geometry_test.js
// The at-rest guard's window geometry (whatdidido AT_REST_GUARD.md section 6,
// CONTROL_API.md Amendment 4): the monitors the focused window's frame
// intersects, changed_at taken when the shell signal fired (the first one of
// a burst, tests/window_burst_test.js), both sent only while the last poll
// showed window_activity.geometry === true.
import System from 'system';

import {
    MONITORS_MAX, METADATA_MAX_BYTES, rectsIntersect, windowMonitors, sameMonitors, rfc3339, windowGeometry,
    windowPayload, sanitizeWindow, metadataBytes, samePayload, WindowReporter, FocusWatch, MonitorSet,
} from '../whatdidido@wporter.org/lib/window_model.js';

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
const R = (x, y, width, height) => ({x, y, width, height});  // Mtk.Rectangle-like
// Two 1920x1080 monitors side by side, a third below the first.
const LAYOUT = [R(1920, 0, 1920, 1080), R(0, 0, 1920, 1080), R(0, 1080, 1920, 1080)];
const M1 = [0, 0, 1920, 1080], M2 = [1920, 0, 1920, 1080], M3 = [0, 1080, 1920, 1080];

// --- intersection -------------------------------------------------------------
eq('MONITORS_MAX', MONITORS_MAX, 16);
eq('overlap -> intersects', rectsIntersect([0, 0, 10, 10], [5, 5, 10, 10]), true);
eq('touching right edge -> no', rectsIntersect([0, 0, 10, 10], [10, 0, 10, 10]), false);
eq('touching bottom edge -> no', rectsIntersect([0, 0, 10, 10], [0, 10, 10, 10]), false);
eq('touching corner -> no', rectsIntersect([0, 0, 10, 10], [10, 10, 10, 10]), false);
eq('one pixel overlap -> yes', rectsIntersect([0, 0, 10, 10], [9, 9, 10, 10]), true);
eq('contained -> yes', rectsIntersect([0, 0, 100, 100], [10, 10, 1, 1]), true);
eq('zero width -> no', rectsIntersect([5, 5, 0, 10], [0, 0, 100, 100]), false);

eq('window on one monitor', windowMonitors(R(100, 100, 800, 600), LAYOUT), [M1]);
eq('window spanning two monitors, sorted by x', windowMonitors(R(1800, 100, 300, 300), LAYOUT), [M1, M2]);
eq('window spanning three, sorted by x then y', windowMonitors(R(1800, 1000, 300, 300), LAYOUT), [M1, M3, M2]);
eq('right edge touching the next monitor -> one', windowMonitors(R(1720, 0, 200, 200), LAYOUT), [M1]);
eq('bottom edge touching the monitor below -> one', windowMonitors(R(0, 880, 200, 200), LAYOUT), [M1]);
eq('fully off-screen -> empty', windowMonitors(R(5000, 5000, 100, 100), LAYOUT), []);
eq('negative coordinates', windowMonitors(R(-50, -50, 100, 100), [R(-1920, -1080, 1920, 1080), ...LAYOUT]),
    [[-1920, -1080, 1920, 1080], M1]);
eq('no frame -> empty', windowMonitors(null, LAYOUT), []);
eq('zero-size frame -> empty', windowMonitors(R(10, 10, 0, 0), LAYOUT), []);
eq('no layout -> empty', [windowMonitors(R(0, 0, 10, 10), []), windowMonitors(R(0, 0, 10, 10), null)], [[], []]);
eq('mirrored monitors deduplicated', windowMonitors(R(0, 0, 10, 10), [R(0, 0, 1920, 1080), R(0, 0, 1920, 1080)]), [M1]);
eq('same origin, different size: both, smaller first',
    windowMonitors(R(0, 0, 10, 10), [R(0, 0, 1920, 1080), R(0, 0, 1280, 720)]), [[0, 0, 1280, 720], M1]);
eq('invalid monitor rects skipped (never a 400)',
    windowMonitors(R(0, 0, 100, 100), [R(0, 0, 0, 10), R(0, 0, 10.5, 10), R(0, 0, '10', 10), null,
        R(-(2 ** 31), 0, 2 ** 31 + 10, 10), R(0, 0, 10, 10)]),
    [[0, 0, 10, 10]]);
const many = Array.from({length: 20}, (_, i) => R(19 - i, 0, 100, 100));
const capped = windowMonitors(R(0, 0, 200, 200), many);
eq('at most 16, the first 16 after sorting', [capped.length, capped[0], capped.at(-1)], [16, [0, 0, 100, 100], [15, 0, 100, 100]]);

eq('sameMonitors', [sameMonitors([M1, M2], [M1, M2]), sameMonitors([M1], [M2]), sameMonitors([], []),
    sameMonitors([M1], [M1, M2]), sameMonitors(null, [])], [true, false, true, false, false]);

// --- changed_at format ------------------------------------------------------------
const T0 = Date.UTC(2026, 9, 23, 12, 34, 56, 789);
eq('rfc3339: ms precision, Z', rfc3339(T0), '2026-10-23T12:34:56.789Z');
eq('rfc3339: whole second keeps .000', rfc3339(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02T03:04:05.000Z');
eq('rfc3339: sub-ms floored', rfc3339(T0 + 0.9), '2026-10-23T12:34:56.789Z');

// --- the geometry gate ------------------------------------------------------------
const WA = {available: true, recorded: 0, dropped: 0, epoch: 0};
const rec = {state: 'recording', window_activity: WA};
const recGeo = {state: 'recording', window_activity: {...WA, geometry: true}};
eq('geometry: true only for geometry === true',
    [windowGeometry(recGeo, true), windowGeometry(rec, true), windowGeometry({state: 'recording',
        window_activity: {...WA, geometry: 'true'}}, true), windowGeometry(recGeo, false), windowGeometry(null, true)],
    [true, false, false, false, false]);
eq('geometry: not offered -> false',
    windowGeometry({state: 'recording', window_activity: {available: false, geometry: true}}, true), false);

// --- payload ----------------------------------------------------------------
const RAW = {appId: 'a.desktop', appName: 'A', wmClass: 'a', title: 'one', frame: R(1800, 100, 300, 300), layout: LAYOUT};
const OLD = '{"focus":"window","app_id":"a.desktop","app_name":"A","wm_class":"a","title":"one"}';
eq('no geometry flag: body exactly as before', JSON.stringify(windowPayload(RAW, [], {changedAt: T0})), OLD);
eq('geometry false: body exactly as before', JSON.stringify(windowPayload(RAW, [], {geometry: false, changedAt: T0})), OLD);
eq('geometry true: monitors then changed_at, last',
    JSON.stringify(windowPayload(RAW, [], {geometry: true, changedAt: T0})),
    '{"focus":"window","app_id":"a.desktop","app_name":"A","wm_class":"a","title":"one",' +
    '"monitors":[[0,0,1920,1080],[1920,0,1920,1080]],"changed_at":"2026-10-23T12:34:56.789Z"}');
eq('geometry true, off-screen: no monitors key (unknown), changed_at kept',
    Object.keys(windowPayload({...RAW, frame: R(9000, 9000, 10, 10)}, [], {geometry: true, changedAt: T0})),
    ['focus', 'app_id', 'app_name', 'wm_class', 'title', 'changed_at']);
eq('geometry true, no change time: no changed_at key',
    Object.keys(windowPayload(RAW, [], {geometry: true, changedAt: null})),
    ['focus', 'app_id', 'app_name', 'wm_class', 'title', 'monitors']);
eq('geometry true, no focus: {focus: none} exactly',
    JSON.stringify(windowPayload(null, [], {geometry: true, changedAt: T0})), '{"focus":"none"}');

// The session's budget: monitors count as compact JSON and are never
// shortened (the title is); changed_at is not stored and does not count.
eq('metadataBytes: monitors as compact JSON, changed_at ignored',
    metadataBytes({focus: 'window', app_id: '', app_name: '', wm_class: '', title: '',
        monitors: [M1], changed_at: rfc3339(T0)}),
    38 + 'monitors'.length + '[[0,0,1920,1080]]'.length);
const longRaw = {...RAW, appId: '', appName: '€'.repeat(130), wmClass: '', title: '€'.repeat(1024)};
const longGeo = windowPayload(longRaw, [], {geometry: true, changedAt: T0});
const monBytes = 'monitors'.length + JSON.stringify([M1, M2]).length;
eq('title shortened for the monitors, monitors kept whole',
    [longGeo.monitors, longGeo.title.endsWith('…'), metadataBytes(longGeo) <= METADATA_MAX_BYTES,
        metadataBytes(longGeo) > METADATA_MAX_BYTES - monBytes, longGeo.changed_at],
    [[M1, M2], true, true, true, rfc3339(T0)]);
eq('same window without geometry keeps the full title',
    windowPayload(longRaw, []).title === '€'.repeat(1024), true);
eq('sanitizeWindow is idempotent with geometry', JSON.stringify(sanitizeWindow(longGeo)), JSON.stringify(longGeo));

const p1 = windowPayload(RAW, [], {geometry: true, changedAt: T0});
eq('dedupe ignores changed_at', samePayload(p1, windowPayload(RAW, [], {geometry: true, changedAt: T0 + 5000})), true);
eq('dedupe includes monitors',
    samePayload(p1, windowPayload({...RAW, frame: R(0, 0, 10, 10)}, [], {geometry: true, changedAt: T0})), false);
eq('dedupe: with vs without the keys differ', samePayload(p1, windowPayload(RAW)), false);

// --- the reporter ------------------------------------------------------------
const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};
// Fake monotonic clock t and wall clock WALL0 + t.
const WALL0 = Date.UTC(2026, 9, 23, 9, 0, 0, 0);
function harness() {
    const h = {t: 0, timers: new Map(), sent: [], focus: {...RAW}, reply: () => Promise.resolve({recorded: true})};
    let nextId = 1;
    h.r = new WindowReporter({
        now: () => h.t,
        wallNow: () => WALL0 + h.t,
        setTimer: (ms, fn) => {
            const id = nextId++;
            h.timers.set(id, {at: h.t + ms, fn});
            return id;
        },
        clearTimer: id => h.timers.delete(id),
        readFocus: () => h.focus,
        send: p => {
            h.sent.push({at: h.t, p});
            return h.reply(p);
        },
    });
    h.advance = async ms => {
        const end = h.t + ms;
        await drain();
        for (let guard = 0; guard < 1000; guard++) {
            let next = null;
            for (const [id, tm] of h.timers) {
                if (tm.at <= end && (!next || tm.at < next[1].at))
                    next = [id, tm];
            }
            if (!next)
                break;
            h.timers.delete(next[0]);
            h.t = next[1].at;
            next[1].fn();
            await drain();
        }
        h.t = end;
    };
    h.last = () => h.sent.at(-1)?.p;
    return h;
}
const wall = t => rfc3339(WALL0 + t);

async function reporterTests() {
    // Old session: no geometry flag, so neither key is ever sent.
    let h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('old session: no monitors/changed_at', JSON.stringify(h.last()), OLD);
    eq('geometry getter follows the poll', h.r.geometry, false);

    // The flag appears between polls: the current focus is re-sent with the keys.
    await h.advance(5000);
    h.r.updateStatus(recGeo, true);
    await h.advance(0);
    eq('flag on: re-sent with the keys', [h.sent.length, h.last()?.monitors, 'changed_at' in (h.last() ?? {})],
        [2, [M1, M2], true]);
    eq('flag on: changed_at is the construction time (no signal yet)', h.last()?.changed_at, wall(0));
    // ... and disappears again: re-sent without them (an old session refuses them).
    await h.advance(5000);
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('flag off: re-sent without the keys', [h.sent.length, JSON.stringify(h.last())], [3, OLD]);
    h.r.changed();
    await h.advance(5000);
    eq('flag off: later changes still without the keys', h.sent.length, 3);
    h.r.updateStatus(rec, true);
    await h.advance(5000);
    eq('same flag on the next poll: nothing re-sent', h.sent.length, 3);

    // changed_at is the signal time, not the send time after the settle.
    h = harness();
    h.r.updateStatus(recGeo, true);
    await h.advance(10000);
    h.focus = {...h.focus, title: 'two', frame: R(10, 10, 100, 100)};
    h.r.changed();                          // signal at t=10000
    await h.advance(999);
    eq('settle: nothing yet', h.sent.length, 1);
    await h.advance(1);
    eq('sent at t=11000 with changed_at from t=10000',
        [h.sent.at(-1).at, h.last().changed_at, h.last().monitors], [11000, wall(10000), [M1]]);

    // A re-armed settle keeps the burst's first signal time (A2.3).
    await h.advance(5000);                  // t=16000
    h.focus = {...h.focus, title: 'three'};
    h.r.changed();
    await h.advance(600);
    h.r.changed();                          // t=16600
    await h.advance(1000);
    eq('re-armed settle: changed_at of the first signal', h.last().changed_at, wall(16000));

    // Spacing delays the POST; changed_at stays at the signal.
    h = harness();
    h.r.updateStatus(recGeo, true);
    await h.advance(100);
    h.focus = {...h.focus, title: 'B', frame: R(10, 10, 100, 100)};          // M1 only
    h.r.changed();                          // t=100, settle at 1100, spacing until 2000
    await h.advance(5000);
    eq('spacing: sent at 2000, changed_at at 100', [h.sent.at(-1).at, h.last().changed_at], [2000, wall(100)]);

    // Dedupe ignores changed_at: a signal with no visible change sends nothing.
    const before = h.sent.length;
    h.r.changed();
    await h.advance(5000);
    eq('dedupe: same window and monitors, new changed_at -> not sent', h.sent.length, before);

    // A monitor-set change is sent after the settle; a same-set move is not.
    h.focus = {...h.focus, frame: R(50, 50, 100, 100)};      // still M1 only
    h.r.changed();
    await h.advance(5000);
    eq('same-set move: not sent', h.sent.length, before);
    const tMove = h.t;
    h.focus = {...h.focus, frame: R(1900, 50, 100, 100)};    // M1 + M2
    h.r.changed();
    await h.advance(999);
    eq('monitor-set change: waits for the settle', h.sent.length, before);
    await h.advance(1);
    eq('monitor-set change: sent after the settle with the new set and its signal time',
        [h.sent.length, h.last().monitors, h.last().changed_at], [before + 1, [M1, M2], wall(tMove)]);

    // A change while paused is stamped then; resume sends it with that time.
    h = harness();
    h.r.updateStatus(recGeo, true);
    await h.advance(3000);
    h.r.updateStatus({...recGeo, state: 'paused'}, true);
    await h.advance(1000);
    h.focus = {...h.focus, title: 'while paused'};
    h.r.changed();                          // t=4000, inactive
    await h.advance(6000);
    h.r.updateStatus(recGeo, true);         // t=10000
    await h.advance(0);
    eq('resume: changed_at of the change made while paused', [h.last().title, h.last().changed_at],
        ['while paused', wall(4000)]);

    // {focus: none} stays exactly as today with the flag on.
    h.focus = null;
    h.r.changed();
    await h.advance(5000);
    eq('no focus with geometry: {focus: none}', JSON.stringify(h.last()), '{"focus":"none"}');
}

// --- signal bookkeeping ---------------------------------------------------------
function fakeWindow() {
    const w = {handlers: new Map(), nextId: 1, disposed: false, attempts: 0};
    w.connect = (sig, fn) => {
        w.handlers.set(w.nextId, {sig, fn});
        return w.nextId++;
    };
    w.disconnect = id => {
        w.attempts++;
        if (w.disposed)
            throw new Error('Object has been already disposed');
        w.handlers.delete(id);
    };
    w.emit = sig => {
        for (const x of [...w.handlers.values()].filter(y => y.sig === sig))
            x.fn();
    };
    w.signals = () => [...w.handlers.values()].map(x => x.sig).sort();
    return w;
}
const FIVE = ['notify::title', 'notify::wm-class', 'position-changed', 'size-changed', 'unmanaged'];

function watchTests() {
    let changes = 0, moves = 0;
    const fw = new FocusWatch(() => changes++, () => moves++);
    const a = fakeWindow(), b = fakeWindow();
    fw.watch(a);
    eq('watch with onMove: position/size too', a.signals(), FIVE);
    a.emit('position-changed');
    a.emit('size-changed');
    eq('position/size -> onMove, not onChange', [moves, changes], [2, 0]);
    fw.watch(b);
    eq('focus change disconnects every signal of the old window', [a.signals(), b.signals()], [[], FIVE]);
    a.emit('position-changed');
    eq('old window moves are ignored', moves, 2);
    fw.clear();
    eq('clear (disable) disconnects every signal', [b.signals(), fw.window], [[], null]);
    fw.watch(a);
    a.emit('unmanaged');
    eq('unmanaged disconnects every signal', a.signals(), []);
    const plain = new FocusWatch(() => {});
    plain.watch(b);
    eq('without onMove: title/wm-class/unmanaged only', b.signals(), ['notify::title', 'notify::wm-class', 'unmanaged']);
    plain.clear();

    // MonitorSet: notifies only when the set changes.
    let frame = R(10, 10, 100, 100), layout = LAYOUT, notes = 0;
    const ms = new MonitorSet(() => windowMonitors(frame, layout), () => notes++);
    ms.reset();
    eq('reset: no notification', [notes, ms.monitors], [0, [M1]]);
    for (let x = 10; x < 1700; x += 7) {
        frame = R(x, 10, 100, 100);
        ms.update();
    }
    eq('drag within a monitor: no notification', notes, 0);
    frame = R(1850, 10, 100, 100);
    ms.update();
    ms.update();
    eq('crossing into a second monitor: one notification', [notes, ms.monitors], [1, [M1, M2]]);
    layout = [R(0, 0, 2560, 1440)];
    ms.update();
    eq('layout change (monitors-changed): notified', [notes, ms.monitors], [2, [[0, 0, 2560, 1440]]]);
    frame = R(0, 0, 10, 10);
    ms.reset();
    ms.update();
    eq('reset on focus change then same set: no notification', notes, 2);
}

// The tracker's wiring with fakes: FocusWatch -> MonitorSet -> reporter.
async function wiringTests() {
    const h = harness();
    const win = fakeWindow();
    const ms = new MonitorSet(() => windowMonitors(h.focus?.frame ?? null, h.focus?.layout ?? []), () => h.r.changed());
    const fw = new FocusWatch(() => h.r.changed(), () => ms.update());
    h.focus = {...h.focus, frame: R(100, 100, 300, 300)};    // M1 only
    h.r.updateStatus(recGeo, true);
    fw.watch(win);
    ms.reset();
    await h.advance(5000);
    const n = h.sent.length;
    for (let x = 100; x < 1500; x += 3) {    // a drag inside monitor 1
        h.focus = {...h.focus, frame: R(x, 100, 300, 300)};
        win.emit('position-changed');
        await h.advance(16);
    }
    await h.advance(5000);
    eq('wiring: drag within a monitor sends nothing', h.sent.length, n);
    const tCross = h.t;
    h.focus = {...h.focus, frame: R(1800, 100, 300, 300)};
    win.emit('position-changed');
    await h.advance(16);
    h.focus = {...h.focus, frame: R(1810, 100, 300, 300)};
    win.emit('position-changed');
    await h.advance(5000);
    eq('wiring: crossing sends once after the settle, stamped at the crossing',
        [h.sent.length, h.last().monitors, h.last().changed_at, h.sent.at(-1).at], [n + 1, [M1, M2], wall(tCross), tCross + 1000]);
    win.emit('size-changed');
    await h.advance(5000);
    eq('wiring: resize keeping the set sends nothing', h.sent.length, n + 1);
    fw.clear();
    h.r.destroy();
}

watchTests();
await reporterTests().then(wiringTests).catch(e => {
    failed++;
    print(`FAIL uncaught: ${e}\n${e.stack}`);
});

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
