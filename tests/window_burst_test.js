// Run: gjs -m tests/window_burst_test.js
// Window bursts report the union (whatdidido AT_REST_GUARD.md Amendment 2,
// A2.3): within one settle burst the report carries the union of the monitor
// sets seen, stamped with the burst's first change time (over-dropping is the
// safe direction); a follow-up then reports the window's current set.
import System from 'system';

import {
    SETTLE_MS, SPACING_MS, MONITORS_MAX, rfc3339, unionMonitors, WindowReporter,
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

const R = (x, y, width, height) => ({x, y, width, height});
// Two 1920x1080 monitors side by side, a third below the first.
const LAYOUT = [R(0, 0, 1920, 1080), R(1920, 0, 1920, 1080), R(0, 1080, 1920, 1080)];
const M1 = [0, 0, 1920, 1080], M2 = [1920, 0, 1920, 1080], M3 = [0, 1080, 1920, 1080];
const ON_M1 = R(100, 100, 400, 300), ON_M1_M2 = R(1700, 100, 400, 300), ON_M2 = R(2000, 100, 400, 300),
    ON_M3 = R(100, 1200, 400, 300);
const RAW = {appId: 'org.keepassxc.KeePassXC.desktop', appName: 'KeePassXC', wmClass: 'keepassxc', title: 'pm',
    frame: ON_M1, layout: LAYOUT};
const WA = {available: true, recorded: 0, dropped: 0};
const st = ({state = 'recording', epoch = 0, geometry = true} = {}) =>
    ({state, window_activity: {...WA, epoch, geometry}});

// --- unionMonitors ------------------------------------------------------------------
eq('union: sorted, deduplicated', unionMonitors([M2, M1], [M1, M3]), [M1, M3, M2]);
eq('union: empty and missing sides', [unionMonitors([], [M1]), unionMonitors(null, [M2]), unionMonitors([M1], undefined)],
    [[M1], [M2], [M1]]);
const many = Array.from({length: 20}, (_, i) => [i, 0, 100, 100]);
eq('union: at most MONITORS_MAX, the first after sorting',
    [unionMonitors(many.slice(10), many.slice(0, 10)).length, unionMonitors(many.slice(10), many.slice(0, 10)).at(-1)],
    [MONITORS_MAX, [15, 0, 100, 100]]);

// --- the reporter -------------------------------------------------------------------
const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};
const WALL0 = Date.UTC(2026, 9, 23, 9, 0, 0, 0);
const wall = t => rfc3339(WALL0 + t);
function harness() {
    const h = {t: 0, timers: new Map(), sent: [], focus: {...RAW},
        reply: () => Promise.resolve({recorded: true})};
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
    // What the session sees: [sent at, title, monitors, changed_at].
    h.log = () => h.sent.map(s => [s.at, s.p.title, s.p.monitors ?? null, s.p.changed_at ?? null]);
    // The tracker calls changed() after the frame moved to a new monitor set.
    h.move = frame => {
        h.focus = {...h.focus, frame};
        h.r.changed();
    };
    return h;
}

// A drag m1 -> [m1, m2] -> [m2] within one settle.
async function drag(h) {
    h.r.updateStatus(st(), true);
    await h.advance(5000);
    h.move(ON_M1_M2);                       // t=5000
    await h.advance(400);
    h.move(ON_M2);                          // t=5400, settle re-armed to 6400
}

async function reporterTests() {
    let h = harness();
    await drag(h);
    await h.advance(SETTLE_MS);
    eq('drag: one report with the union, stamped with the first change',
        h.log(), [[0, 'pm', [M1], wall(0)], [6400, 'pm', [M1, M2], wall(5000)]]);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('drag: then the current set, stamped when the union was sent',
        h.log().slice(2), [[8400, 'pm', [M2], wall(6400)]]);
    await h.advance(30000);
    eq('drag: nothing more once the set is steady', h.sent.length, 3);

    // A single change is not a burst: its own set and time, no follow-up.
    h.move(ON_M1);
    const tOne = h.t;
    await h.advance(30000);
    eq('single change: own set and time, no follow-up', h.log().slice(3), [[tOne + SETTLE_MS, 'pm', [M1], wall(tOne)]]);

    // A failed union is retried as the union with the first change time.
    h = harness();
    let fails = 1;
    h.reply = p => (p.monitors?.length === 2 && fails-- > 0
        ? Promise.reject(Object.assign(new Error('HTTP 503'), {status: 503})) : Promise.resolve({recorded: true}));
    await drag(h);
    await h.advance(SETTLE_MS + 2000);
    eq('failed union: retried as the union, first change time',
        h.log().slice(1, 3), [[6400, 'pm', [M1, M2], wall(5000)], [8400, 'pm', [M1, M2], wall(5000)]]);
    await h.advance(30000);
    eq('failed union: then the current set', h.log().slice(3).map(x => x[2]), [[M2]]);

    // Alt-tab through windows on other monitors within one settle: the last
    // window, with every monitor seen, stamped at the first change.
    h = harness();
    h.r.updateStatus(st(), true);
    await h.advance(5000);
    h.focus = {...RAW, appId: 'b.desktop', title: 'B', frame: ON_M2};
    h.r.changed();                          // t=5000
    await h.advance(300);
    h.focus = {...RAW, appId: 'c.desktop', title: 'C', frame: ON_M3};
    h.r.changed();                          // t=5300
    await h.advance(SETTLE_MS);
    eq('alt-tab burst: last window, union of the sets seen, first change time',
        h.log().at(-1), [6300, 'C', [M3, M2], wall(5000)]);

    // A new epoch in the middle of a burst sends the union at once.
    h = harness();
    await drag(h);
    await h.advance(200);
    h.r.updateStatus(st({epoch: 1}), true); // t=5600
    await h.advance(0);
    eq('epoch mid-burst: union sent at once with the first change time',
        h.log().at(-1), [5600, 'pm', [M1, M2], wall(5000)]);

    // The burst works while paused too (A2.2).
    h = harness();
    h.r.updateStatus(st({state: 'paused'}), true);
    await h.advance(5000);
    h.move(ON_M1_M2);
    await h.advance(400);
    h.move(ON_M2);
    await h.advance(SETTLE_MS);
    eq('paused: union and first change time', h.log().at(-1), [6400, 'pm', [M1, M2], wall(5000)]);

    // Burst cut short by a stop: nothing sent; the start reports the current
    // set with the last change time.
    h = harness();
    await drag(h);
    h.r.updateStatus(st({state: 'stopped'}), true);
    await h.advance(5000);
    h.r.updateStatus(st({epoch: 1}), true);
    await h.advance(0);
    eq('stop mid-burst: the start sends the current set', h.log().at(-1), [10400, 'pm', [M2], wall(5400)]);

    // Geometry off (older session): no monitors, no changed_at, no follow-up.
    h = harness();
    h.r.updateStatus(st({geometry: false}), true);
    await h.advance(5000);
    h.move(ON_M1_M2);
    await h.advance(400);
    h.focus = {...h.focus, frame: ON_M2, title: 'pm2'};
    h.r.changed();
    await h.advance(30000);
    eq('geometry off: no keys, no follow-up', h.sent.map(s => JSON.stringify(s.p)),
        ['{"focus":"window","app_id":"org.keepassxc.KeePassXC.desktop","app_name":"KeePassXC","wm_class":"keepassxc","title":"pm"}',
            '{"focus":"window","app_id":"org.keepassxc.KeePassXC.desktop","app_name":"KeePassXC","wm_class":"keepassxc","title":"pm2"}']);
}

reporterTests().then(() => {
    if (failed) {
        print(`${failed} failed`);
        System.exit(1);
    }
    print('all passed');
}).catch(e => {
    print(`ERROR ${e}\n${e.stack}`);
    System.exit(1);
});
