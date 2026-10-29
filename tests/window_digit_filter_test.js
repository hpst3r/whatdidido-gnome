// Run: gjs -m tests/window_digit_filter_test.js
// Digit-only title changes (whatdidido TIME_ACCOUNTING.md "Later": ignore
// digit-only title changes, window-title-ignore-digit-changes): an ordinary
// title-change send is held when, against the last payload sent, only short
// digit runs changed (the server's counter rule), so while a counter keeps
// ticking the first title stands (tests/window_counter_settle_test.js: a
// held title is sent once it settles for 15 s). Focus changes, re-sends,
// retries and paused reports always send.
// Title rules apply first, so a relabeled title's ticks never send.
import System from 'system';

import {SETTLE_MS, SPACING_MS, RETRY_MIN_MS, WindowReporter} from '../whatdidido@wporter.org/lib/window_model.js';

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
const LAYOUT = [R(0, 0, 1920, 1080), R(1920, 0, 1920, 1080)];
const M1 = [0, 0, 1920, 1080], M2 = [1920, 0, 1920, 1080];
const ON_M1 = R(100, 100, 400, 300), ON_M2 = R(2000, 100, 400, 300);
const RAW = {appId: 'ninja.desktop', appName: 'NinjaOne', wmClass: 'ninja', title: 'Remote 30 FPS', frame: ON_M1,
    layout: LAYOUT};
const WA = {available: true, recorded: 0, dropped: 0};
const st = ({state = 'recording', epoch = 0, geometry = false} = {}) =>
    ({state, window_activity: {...WA, epoch, geometry}});

const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};
function harness(opts = {}) {
    const h = {t: 0, timers: new Map(), sent: [], logs: [], focus: {...RAW},
        reply: () => Promise.resolve({recorded: true})};
    let nextId = 1;
    h.r = new WindowReporter({
        now: () => h.t,
        wallNow: () => 1e12 + h.t,
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
        log: m => h.logs.push(m),
        ignoreDigitChanges: true,   // the setting's default (the reporter's is off)
        ...opts,
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
    h.titles = () => h.sent.map(s => s.p.title);
    // A title change of the focused window (notify::title), then quiet.
    h.title = async (title, {wait = SETTLE_MS + SPACING_MS} = {}) => {
        h.focus = {...h.focus, title};
        h.r.changed();
        await h.advance(wait);
    };
    h.start = async status => {
        h.r.updateStatus(status ?? st(), true);
        await h.advance(SPACING_MS);
    };
    return h;
}

async function main() {
    // FPS ticks: the first title stands.
    let h = harness();
    await h.start();
    for (let fps = 31; fps < 60; fps += 3)
        await h.title(`Remote ${fps} FPS`);
    eq('FPS ticks are not sent: the first title stands', h.titles(), ['Remote 30 FPS']);
    await h.title('Remote 59 FPS - Settings');
    eq('a text change is sent', h.titles(), ['Remote 30 FPS', 'Remote 59 FPS - Settings']);

    h = harness();
    h.focus = {...RAW, title: 'Ticket #20591 - PSA'};
    await h.start();
    await h.title('Ticket #20592 - PSA');
    eq('a ticket number change (5 digits) is sent', h.titles(), ['Ticket #20591 - PSA', 'Ticket #20592 - PSA']);

    h = harness();
    h.focus = {...RAW, title: 'Remote 999 FPS'};
    await h.start();
    await h.title('Remote 1000 FPS');
    eq('a change involving a 4-digit run is sent', h.titles(), ['Remote 999 FPS', 'Remote 1000 FPS']);

    // Off: every change sends.
    h = harness({ignoreDigitChanges: false});
    await h.start();
    await h.title('Remote 31 FPS');
    await h.title('Remote 32 FPS');
    eq('filter off: every change is sent', h.titles(), ['Remote 30 FPS', 'Remote 31 FPS', 'Remote 32 FPS']);

    // The baseline is the last payload sent: a skipped one doesn't move it.
    h = harness();
    await h.start();
    await h.title('Remote 31 FPS');
    await h.title('Remote 30 FPS');
    eq('back to the sent title: nothing', h.titles(), ['Remote 30 FPS']);
    await h.title('Remote 32 FPS');
    h.r.setIgnoreDigitChanges(false);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('turning the filter off sends the held-back title (skips did not move the baseline)',
        h.titles(), ['Remote 30 FPS', 'Remote 32 FPS']);
    await h.title('Remote 33 FPS');
    eq('then ticks send', h.titles().at(-1), 'Remote 33 FPS');
    h.r.setIgnoreDigitChanges(true);
    await h.advance(SETTLE_MS + SPACING_MS);
    await h.title('Remote 34 FPS');
    eq('back on: ticks are held again', h.titles(), ['Remote 30 FPS', 'Remote 32 FPS', 'Remote 33 FPS']);

    // Focus changes always send, even between two windows of one app whose
    // titles differ only in a counter.
    h = harness();
    h.focus = {...RAW, title: 'Terminal 1'};
    await h.start();
    h.focus = {...RAW, title: 'Terminal 2'};
    h.r.changed(true);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('focus change to a same-app counter-alike window is sent', h.titles(), ['Terminal 1', 'Terminal 2']);
    h.focus = {...RAW, title: 'Terminal 3'};
    h.r.changed();
    h.r.changed(true);
    h.r.changed();
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('a burst with a focus change in it is sent', h.titles().at(-1), 'Terminal 3');
    await h.title('Terminal 4');
    eq('a later title tick of that window is held', h.titles().length, 3);

    // The epoch re-send and the paused -> recording edge always send.
    h = harness();
    await h.start(st({epoch: 1}));
    await h.title('Remote 31 FPS');
    h.r.updateStatus(st({epoch: 2}), true);
    await h.advance(SPACING_MS);
    eq('epoch change: the current (ticked) title is sent at once', h.titles(), ['Remote 30 FPS', 'Remote 31 FPS']);
    await h.title('Remote 32 FPS');
    h.r.updateStatus(st({state: 'paused', epoch: 2, geometry: true}), true);
    await h.advance(SPACING_MS);
    const beforeResume = h.titles().length;
    h.focus = {...h.focus, title: 'Remote 33 FPS'};
    h.r.updateStatus(st({epoch: 2, geometry: true}), true);
    await h.advance(SPACING_MS);
    eq('paused -> recording: the current title is sent', h.titles().slice(beforeResume), ['Remote 33 FPS']);

    // Paused reports (a session with geometry) always send.
    h = harness();
    await h.start(st({state: 'paused', geometry: true}));
    await h.title('Remote 31 FPS');
    await h.title('Remote 32 FPS');
    eq('while paused every change is sent (the at-rest guard\'s focus reports)', h.titles(),
        ['Remote 30 FPS', 'Remote 31 FPS', 'Remote 32 FPS']);

    // Retries always send: after a failure there is no baseline.
    h = harness();
    await h.start();
    let fail = 1;
    h.reply = () => (fail-- > 0 ? Promise.reject(Object.assign(new Error('HTTP 503'), {status: 503}))
        : Promise.resolve({recorded: true}));
    await h.title('Remote 31 FPS - Menu', {wait: SETTLE_MS});
    eq('a text change is sent (and fails)', h.titles().at(-1), 'Remote 31 FPS - Menu');
    h.focus = {...h.focus, title: 'Remote 32 FPS - Menu'};   // no signal: the retry reads the focus
    await h.advance(RETRY_MIN_MS + SPACING_MS);
    eq('the retry sends the current (ticked) title', h.titles().slice(1), ['Remote 31 FPS - Menu', 'Remote 32 FPS - Menu']);
    await h.title('Remote 33 FPS - Menu');
    eq('after the retry succeeded, ticks are held again', h.titles().length, 3);

    h = harness();
    await h.start();
    fail = 1;
    h.reply = () => (fail-- > 0 ? Promise.reject(Object.assign(new Error('HTTP 503'), {status: 503}))
        : Promise.resolve({recorded: true}));
    await h.title('Remote 31 FPS - Menu', {wait: SETTLE_MS});
    await h.title('Remote 32 FPS - Menu');
    eq('a tick after a failed send is sent (nothing to compare with)', h.titles().slice(1),
        ['Remote 31 FPS - Menu', 'Remote 32 FPS - Menu']);

    // Monitors (geometry): a tick that also changed the monitor set sends.
    h = harness();
    await h.start(st({geometry: true}));
    await h.title('Remote 31 FPS');
    eq('geometry: a tick alone is held', h.titles(), ['Remote 30 FPS']);
    h.focus = {...h.focus, title: 'Remote 32 FPS', frame: ON_M2};
    h.r.changed();
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('geometry: a tick with a monitor change is sent', h.sent.map(s => [s.p.title, s.p.monitors]),
        [['Remote 30 FPS', [M1]], ['Remote 32 FPS', [M2]]]);

    // Burst union (A2.3): a tick while dragging across monitors within one
    // settle sends the union, then the current set.
    h = harness();
    await h.start(st({geometry: true}));
    h.focus = {...h.focus, title: 'Remote 31 FPS', frame: R(1700, 100, 400, 300)};
    h.r.changed();
    await h.advance(400);
    h.focus = {...h.focus, title: 'Remote 32 FPS', frame: ON_M1};
    h.r.changed();
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('burst: a drag away and back with ticks sends the union', h.sent.slice(0, 2).map(s => s.p.monitors),
        [[M1], [M1, M2]]);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('burst: then the current set (a tick vs the union is still a monitor change)',
        h.sent.map(s => [s.p.title, s.p.monitors]),
        [['Remote 30 FPS', [M1]], ['Remote 32 FPS', [M1, M2]], ['Remote 32 FPS', [M1]]]);

    // Title rules come first: a relabeled title's ticks never send, filter on or off.
    for (const ignoreDigitChanges of [true, false]) {
        h = harness({ignoreDigitChanges, titleRules: [['ninja', 'Remote * FPS', 'Remote session']]});
        await h.start();
        await h.title('Remote 31 FPS');
        await h.title('Remote 5 FPS');
        eq(`relabeled title's ticks are not sent (filter ${ignoreDigitChanges ? 'on' : 'off'})`, h.titles(),
            ['Remote session']);
    }

    // setTitleRules: applies to the next send. A setting with an entry that
    // can't be used blanks every title (fail closed) until it is fixed,
    // logged whenever the list of problems changes, by rule number, never
    // its text.
    const BAD = [['', '*Other*', 'OTHER'], ['', '*', 'LBL']];
    h = harness();
    await h.start();
    h.r.setTitleRules(BAD);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('fail closed: the current window is re-sent with an empty title', h.titles(), ['Remote 30 FPS', '']);
    await h.title('Settings');
    eq('fail closed: other titles stay empty', h.titles(), ['Remote 30 FPS', '']);
    eq('fail closed: logged once, naming the rule, not its text',
        [h.logs.length, /rule 2/.test(h.logs[0]), h.logs.some(m => /LBL|OTHER|Other/.test(m))], [1, true, false]);
    h.r.setTitleRules(BAD.map(e => [...e]));
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('fail closed: the same bad setting again is not logged again', h.logs.length, 1);
    h.r.setTitleRules([['', '', 'x']]);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('fail closed: another bad setting is logged', [h.logs.length, /rule 1/.test(h.logs[1])], [2, true]);
    h.r.setTitleRules([['', '', 'y']]);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('fail closed: one with the same problems but other text is not logged again', h.logs.length, 2);
    h.r.setTitleRules([BAD[0]]);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('fixed: titles are sent again, nothing logged', [h.titles().at(-1), h.logs.length], ['Settings', 2]);
    h.r.setTitleRules(Array.from({length: 101}, (_, i) => ['', `t${i}`, '']));
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('fail closed: more than 100 rules', [h.titles().at(-1), h.logs.length, /101/.test(h.logs.at(-1))],
        ['', 3, true]);
    h.r.setTitleRules([]);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('no rules: titles are sent', h.titles().at(-1), 'Settings');
    h.r.setTitleRules([['', '', 'y']]);
    eq('broken again after a fix: logged again', [h.logs.length, /rule 1/.test(h.logs.at(-1))], [4, true]);

    h = harness({titleRules: [['', '', '']]});
    await h.start();
    eq('fail closed from the constructor too', [h.titles(), h.logs.length], [[''], 1]);
    h = harness({titleRules: [['', 'nothing', '']]});
    h.focus = {...RAW, title: 'x'.repeat(5000)};
    await h.start();
    eq('a title over 4096 characters is sent empty while rules are set', h.titles(), ['']);
}

await main();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
