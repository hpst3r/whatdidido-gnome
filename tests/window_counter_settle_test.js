// Run: gjs -m tests/window_counter_settle_test.js
// Counter-only title changes are deferred, not dropped
// (window-title-ignore-digit-changes): a title that is the last one sent
// with only a short counter ticked (counterTick) is held and sent once the
// raw title has stayed unchanged for COUNTER_SETTLE_MS; every new tick
// restarts the wait. So an FPS counter ticking every few seconds never
// sends, while navigation ('Issue 123' -> 'Issue 124') is recorded about
// 15 s late, stamped (with geometry) with when that title first appeared.
// A newer non-counter payload, a focus change, a re-send, a paused report
// or a retry supersedes a held title, which is then never sent.
import System from 'system';

import {
    COUNTER_SETTLE_MS, RETRY_MIN_MS, SETTLE_MS, SPACING_MS, WindowReporter, rfc3339,
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
const LAYOUT = [R(0, 0, 1920, 1080), R(1920, 0, 1920, 1080)];
const RAW = {appId: 'org.mozilla.firefox.desktop', appName: 'Firefox', wmClass: 'firefox',
    title: 'Issue 123 - GitHub', frame: R(100, 100, 400, 300), layout: LAYOUT};
const OTHER = {appId: 'org.gnome.Ptyxis.desktop', appName: 'Ptyxis', wmClass: 'org.gnome.Ptyxis', title: 'Terminal',
    frame: R(100, 100, 400, 300), layout: LAYOUT};
const WA = {available: true, recorded: 0, dropped: 0};
const st = ({state = 'recording', epoch = 0, geometry = true} = {}) =>
    ({state, window_activity: {...WA, epoch, geometry}});
const wall = t => rfc3339(1e12 + t);

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
        ignoreDigitChanges: true,
        ...opts,
    });
    h.advance = async ms => {
        const end = h.t + ms;
        await drain();
        for (let guard = 0; guard < 10000; guard++) {
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
    h.titles = () => h.sent.map(s => s.p.title ?? s.p.focus);
    h.last = () => h.sent.at(-1);
    // A title change of the focused window (notify::title), no waiting.
    h.title = title => {
        h.focus = {...h.focus, title};
        h.r.changed();
    };
    h.start = async status => {
        h.r.updateStatus(status ?? st(), true);
        await h.advance(SPACING_MS);
    };
    return h;
}

async function main() {
    eq('COUNTER_SETTLE_MS is 15 s', COUNTER_SETTLE_MS, 15000);

    // An FPS counter ticking every 2 s for 2 minutes: only the first title.
    let h = harness();
    h.focus = {...RAW, title: 'Remote 30 FPS'};
    await h.start();
    for (let i = 1; i <= 60; i++) {
        h.title(`Remote ${30 + (i % 9)} FPS`);
        await h.advance(2000);
    }
    eq('FPS ticks every 2 s for 2 min: nothing beyond the first title', h.titles(), ['Remote 30 FPS']);
    // Once it stops ticking, the title it settled on is recorded.
    const stopped = h.t - 2000;
    await h.advance(COUNTER_SETTLE_MS);
    eq('FPS counter stops: its last title is sent 15 s after it appeared',
        [h.titles(), h.last().at - stopped], [['Remote 30 FPS', `Remote ${30 + (60 % 9)} FPS`], COUNTER_SETTLE_MS]);

    // Navigation: 'Issue 123' -> 'Issue 124', then stable.
    h = harness();
    await h.start();
    const t0 = h.t;
    h.title('Issue 124 - GitHub');
    await h.advance(COUNTER_SETTLE_MS - 1);
    eq('123 -> 124: nothing within 15 s', h.titles(), ['Issue 123 - GitHub']);
    await h.advance(1);
    eq('123 -> 124: sent 15 s after the change', [h.titles(), h.last().at - t0],
        [['Issue 123 - GitHub', 'Issue 124 - GitHub'], COUNTER_SETTLE_MS]);
    eq('123 -> 124: changed_at is when 124 first appeared', h.last().p.changed_at, wall(t0));
    eq('123 -> 124: monitors as usual', h.last().p.monitors, [[0, 0, 1920, 1080]]);
    await h.advance(60000);
    eq('123 -> 124: sent once', h.titles().length, 2);
    h.title('Issue 125 - GitHub');
    await h.advance(COUNTER_SETTLE_MS);
    eq('the next tick is held against 124 and sent in turn', h.titles().at(-1), 'Issue 125 - GitHub');

    h = harness();
    h.focus = {...RAW, title: 'Page 2 of 10 - Reader'};
    await h.start();
    h.title('Page 3 of 10 - Reader');
    await h.advance(COUNTER_SETTLE_MS);
    eq("'Page 2 of 10' -> 'Page 3 of 10' is recorded", h.titles(), ['Page 2 of 10 - Reader', 'Page 3 of 10 - Reader']);

    // Without geometry: the same, without changed_at.
    h = harness();
    await h.start(st({geometry: false}));
    h.title('Issue 124 - GitHub');
    await h.advance(COUNTER_SETTLE_MS);
    eq('no geometry: sent after 15 s, no changed_at', [h.titles().at(-1), 'changed_at' in h.last().p],
        ['Issue 124 - GitHub', false]);

    // A tick inside the 15 s restarts it.
    h = harness();
    await h.start();
    let t1 = h.t;
    h.title('Issue 124 - GitHub');
    await h.advance(10000);
    h.title('Issue 125 - GitHub');
    await h.advance(COUNTER_SETTLE_MS - 1);
    eq('a tick inside the 15 s: nothing 15 s after the first tick', h.titles(), ['Issue 123 - GitHub']);
    await h.advance(1);
    eq('a tick inside the 15 s: the newest title, 15 s after it', [h.titles(), h.last().at - t1,
        h.last().p.changed_at], [['Issue 123 - GitHub', 'Issue 125 - GitHub'], 10000 + COUNTER_SETTLE_MS,
        wall(t1 + 10000)]);

    // A tick and back within one settle still restarts it (the raw title
    // changed), though the payload is the held one again.
    h = harness();
    await h.start();
    t1 = h.t;
    h.title('Issue 124 - GitHub');
    await h.advance(10000);
    h.title('Issue 125 - GitHub');
    await h.advance(SETTLE_MS / 2);
    h.title('Issue 124 - GitHub');
    await h.advance(COUNTER_SETTLE_MS - 1);
    eq('124 -> 125 -> 124 within a settle: the 15 s restart', h.titles(), ['Issue 123 - GitHub']);
    await h.advance(SETTLE_MS);
    eq('124 -> 125 -> 124 within a settle: sent 15 s after the last change', [h.titles().at(-1),
        h.last().at - t1], ['Issue 124 - GitHub', 10000 + SETTLE_MS / 2 + COUNTER_SETTLE_MS]);

    // Back to the sent title: nothing is owed.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.title('Issue 123 - GitHub');
    await h.advance(60000);
    eq('back to the sent title within 15 s: nothing', h.titles(), ['Issue 123 - GitHub']);

    // Other changes inside the 15 s that don't touch the title don't restart it.
    h = harness();
    await h.start();
    t1 = h.t;
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.r.setExcluded([]);
    h.r.setTitleRules([]);
    await h.advance(COUNTER_SETTLE_MS - 5000);
    eq('a settings change inside the 15 s does not restart it', [h.titles().at(-1), h.last().at - t1],
        ['Issue 124 - GitHub', COUNTER_SETTLE_MS]);

    // A non-counter change supersedes the held title, which is never sent.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.title('Settings - GitHub');
    await h.advance(60000);
    eq('a non-counter change inside the 15 s is sent; the held title never is', h.titles(),
        ['Issue 123 - GitHub', 'Settings - GitHub']);

    // A focus change inside the 15 s: the new window is reported as usual
    // and the held title is dropped (it would only delay the focus report
    // and record the old window over time that belongs to the new one).
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    const tf = h.t;
    h.focus = {...OTHER};
    h.r.changed(true);
    await h.advance(60000);
    eq('focus change inside the 15 s: the new window, at the usual settle; the held title never',
        [h.titles(), h.last().at - tf, h.last().p.changed_at], [['Issue 123 - GitHub', 'Terminal'], SETTLE_MS, wall(tf)]);
    h.focus = {...RAW, title: 'Issue 124 - GitHub'};
    h.r.changed(true);
    await h.advance(SETTLE_MS);
    eq('focus back: the window\'s current title is sent at once', h.titles().at(-1), 'Issue 124 - GitHub');

    // Focus away and back within one settle: a focus burst always sends.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.focus = {...OTHER};
    h.r.changed(true);
    h.focus = {...RAW, title: 'Issue 124 - GitHub'};
    h.r.changed(true);
    await h.advance(SETTLE_MS);
    eq('focus away and back within a settle: sent at once', h.titles(), ['Issue 123 - GitHub', 'Issue 124 - GitHub']);
    await h.advance(60000);
    eq('... and not again', h.titles().length, 2);

    // Disable and enable inside the 15 s.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.r.setEnabled(false);
    await h.advance(60000);
    eq('disabled inside the 15 s: "none" once, the held title never', h.titles(), ['Issue 123 - GitHub', 'none']);
    h.r.setEnabled(true);
    await h.advance(0);
    eq('enabled again: the current title at once', h.titles().at(-1), 'Issue 124 - GitHub');
    await h.advance(60000);
    eq('enabled again: once', h.titles().length, 3);

    // Enabled again inside the 15 s: becoming active sends the current title.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(3000);
    h.r.setEnabled(false);
    await h.advance(3000);
    h.r.setEnabled(true);
    await h.advance(60000);
    eq('off and on inside the 15 s: the current title once, at enable', h.titles(),
        ['Issue 123 - GitHub', 'none', 'Issue 124 - GitHub']);

    // The setting turned off inside the 15 s: the held title is sent now.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    const toff = h.t;
    h.r.setIgnoreDigitChanges(false);
    await h.advance(SETTLE_MS);
    eq('setting off inside the 15 s: sent after the settle', [h.titles(), h.last().at - toff],
        [['Issue 123 - GitHub', 'Issue 124 - GitHub'], SETTLE_MS]);
    await h.advance(60000);
    eq('setting off: not again', h.titles().length, 2);
    h.r.setIgnoreDigitChanges(true);
    await h.advance(SETTLE_MS);
    h.title('Issue 125 - GitHub');
    await h.advance(COUNTER_SETTLE_MS - 1);
    eq('setting back on: ticks are deferred again', h.titles().length, 2);
    await h.advance(1);
    eq('... and sent once settled', h.titles().at(-1), 'Issue 125 - GitHub');

    // The epoch re-send inside the 15 s sends the current title at once.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.r.updateStatus(st({epoch: 1}), true);
    await h.advance(60000);
    eq('epoch re-send inside the 15 s: the current title once, at once', h.titles(),
        ['Issue 123 - GitHub', 'Issue 124 - GitHub']);
    eq('epoch re-send: at the poll', h.last().at, 2000 + 5000);

    // Paused (a session with geometry): a change is a paused report, sent
    // after the settle; the held title is not sent after it.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.r.updateStatus(st({state: 'paused'}), true);
    h.title('Issue 125 - GitHub');
    await h.advance(60000);
    eq('paused inside the 15 s: the paused report goes out, the held title never', h.titles(),
        ['Issue 123 - GitHub', 'Issue 125 - GitHub']);

    // A deferred send that fails is retried like any other send.
    h = harness();
    await h.start();
    t1 = h.t;
    h.title('Issue 124 - GitHub');
    h.reply = () => Promise.reject({status: 503, message: 'HTTP 503'});
    await h.advance(COUNTER_SETTLE_MS);
    eq('deferred send fails', [h.titles(), h.logs.length], [['Issue 123 - GitHub', 'Issue 124 - GitHub'], 1]);
    h.reply = () => Promise.resolve({recorded: true});
    await h.advance(RETRY_MIN_MS);
    eq('... and is retried with the same changed_at', [h.titles().slice(1), h.sent.slice(1).map(s => s.p.changed_at)],
        [['Issue 124 - GitHub', 'Issue 124 - GitHub'], [wall(t1), wall(t1)]]);
    await h.advance(60000);
    eq('... once', h.titles().length, 3);
    h.title('Issue 125 - GitHub');
    await h.advance(COUNTER_SETTLE_MS - 1);
    eq('after the retry succeeded, ticks are deferred again', h.titles().length, 3);

    // The held title waits for a request in flight, then goes.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    let resolve;
    h.reply = () => new Promise(r => {
        resolve = r;
    });
    await h.advance(COUNTER_SETTLE_MS);
    eq('deferred send in flight', h.titles().at(-1), 'Issue 124 - GitHub');
    h.title('Issue 125 - GitHub');
    await h.advance(SETTLE_MS);
    resolve?.({recorded: true});
    h.reply = () => Promise.resolve({recorded: true});
    await h.advance(COUNTER_SETTLE_MS);
    eq('a tick while the deferred send is in flight is deferred against it', h.titles(),
        ['Issue 123 - GitHub', 'Issue 124 - GitHub', 'Issue 125 - GitHub']);

    // Destroyed inside the 15 s: nothing more.
    h = harness();
    await h.start();
    h.title('Issue 124 - GitHub');
    await h.advance(5000);
    h.r.destroy();
    await h.advance(60000);
    eq('destroyed inside the 15 s: no timer left, nothing sent', [h.titles(), h.timers.size],
        [['Issue 123 - GitHub'], 0]);
}

await main();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
