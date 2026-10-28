// Run: gjs -m tests/window_paused_test.js
// Focus after a start, resume or recovery (whatdidido AT_REST_GUARD.md
// Amendment 2, A2.2): while window activity reporting is on and the session
// takes geometry, the extension polls at poll-active while paused or stopped,
// reports focus while paused (with changed_at), and re-sends the current
// focus at once at a new window epoch. A paused report answered with
// recorded: false is a success (no retry).
import System from 'system';

import {pollPeriod} from '../whatdidido@wporter.org/lib/model.js';
import {
    SETTLE_MS, SPACING_MS, RETRY_MAX_MS, rfc3339, windowEligible, WindowReporter,
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
const M1 = [0, 0, 1920, 1080];
const RAW = {appId: 'a.desktop', appName: 'A', wmClass: 'a', title: 'one', frame: R(10, 10, 100, 100), layout: LAYOUT};
const WA = {available: true, recorded: 0, dropped: 0};
const st = (state, {epoch = 0, geometry = true} = {}) => ({state, window_activity: {...WA, epoch, geometry}});

// --- eligibility ----------------------------------------------------------------
eq('eligible: paused with geometry', windowEligible(st('paused'), true), true);
eq('not eligible: paused without geometry (older session, as before)',
    windowEligible(st('paused', {geometry: false}), true), false);
eq('not eligible: stopped / recovering / failed even with geometry',
    ['stopped', 'recovering', 'failed', 'starting', 'stopping'].map(s => windowEligible(st(s), true)),
    [false, false, false, false, false]);
eq('not eligible: paused, not running', windowEligible(st('paused'), false), false);

// --- poll cadence -------------------------------------------------------------------
eq('poll fast while paused/stopped when watching windows',
    ['paused', 'stopped'].map(s => pollPeriod(s, false, 2, 10, true)), [2, 2]);
eq('poll slow while paused/stopped when not watching',
    ['paused', 'stopped'].map(s => pollPeriod(s, false, 2, 10, false)), [10, 10]);
eq('poll default (no flag) while paused/stopped stays slow',
    ['paused', 'stopped'].map(s => pollPeriod(s, false, 2, 10)), [10, 10]);
eq('watching does not speed up failed or not running',
    [pollPeriod('failed', false, 2, 10, true), pollPeriod(null, false, 2, 10, true)], [10, 10]);
eq('busy states stay fast either way', ['recording', 'starting'].map(s => pollPeriod(s, false, 2, 10, true)), [2, 2]);

// --- the reporter -------------------------------------------------------------------
const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};
const WALL0 = Date.UTC(2026, 9, 23, 9, 0, 0, 0);
const wall = t => rfc3339(WALL0 + t);
function harness({enabled = true} = {}) {
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
        enabled,
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
    h.at = () => h.sent.map(s => `${s.at}:${s.p.title}`);
    return h;
}

async function reporterTests() {
    // watching: what the extension's poll cadence follows.
    let h = harness();
    eq('watching: nothing polled yet', h.r.watching, false);
    for (const s of ['paused', 'stopped', 'recording']) {
        h.r.updateStatus(st(s), true);
        eq(`watching while ${s} (geometry, setting on)`, h.r.watching, true);
    }
    h.r.updateStatus(st('paused', {geometry: false}), true);
    eq('not watching: older session without geometry', h.r.watching, false);
    h.r.updateStatus(null, false);
    eq('not watching: server not running', h.r.watching, false);
    h.r.updateStatus({state: 'paused'}, true);
    eq('not watching: window activity not offered', h.r.watching, false);
    h.r.updateStatus(st('stopped'), true);
    h.r.setEnabled(false);
    eq('not watching: setting off', h.r.watching, false);
    h.r.setEnabled(true);
    eq('watching again: setting on', h.r.watching, true);
    h.r.destroy();
    eq('not watching: destroyed', h.r.watching, false);
    h = harness();
    h.reply = () => Promise.reject(Object.assign(new Error('409 unavailable'), {status: 409, code: 'unavailable'}));
    h.r.updateStatus(st('paused'), true);
    await h.advance(0);
    eq('not watching: after a 409 until the next poll', [h.sent.length, h.r.watching], [1, false]);
    h.r.updateStatus(st('stopped'), true);
    eq('watching: the next poll clears the 409', h.r.watching, true);

    // Focus reported while paused, with changed_at; recorded: false is a success.
    h = harness();
    h.r.updateStatus(st('recording'), true);
    await h.advance(3000);
    h.reply = () => Promise.resolve({recorded: false});
    h.r.updateStatus(st('paused'), true);     // t=3000, same epoch
    await h.advance(1000);
    eq('pause with the same focus: nothing re-sent', h.at(), ['0:one']);
    h.focus = {...RAW, appId: 'org.keepassxc.KeePassXC.desktop', title: 'pm'};
    h.r.changed();                          // t=4000, while paused
    await h.advance(SETTLE_MS);
    eq('change while paused: sent after the settle', h.at(), ['0:one', '5000:pm']);
    eq('paused report carries changed_at and monitors', [h.last().changed_at, h.last().monitors],
        [wall(4000), [M1]]);
    await h.advance(RETRY_MAX_MS * 3);
    eq('recorded: false is a success: no retry', h.sent.length, 2);
    const tSignal = h.t;
    h.r.changed();                          // a signal with no visible change
    await h.advance(5000);
    eq('recorded: false still dedupes', h.sent.length, 2);

    // Resume (a new epoch): the current focus at once, no settle.
    h.reply = () => Promise.resolve({recorded: true});
    h.r.updateStatus(st('recording', {epoch: 1}), true);
    await h.advance(0);
    eq('resume at a new epoch: re-sent at once', h.at().at(-1), `${h.t}:pm`);
    eq('resume re-send: changed_at of the last signal, not the poll', h.last().changed_at, wall(tSignal));

    // A recovery while paused (epoch bump) re-sends at once too.
    h.r.updateStatus(st('paused', {epoch: 1}), true);
    await h.advance(5000);
    const n = h.sent.length;
    h.r.updateStatus(st('paused', {epoch: 2}), true);
    await h.advance(0);
    eq('epoch bump while paused: re-sent at once', [h.sent.length, h.sent.at(-1).at], [n + 1, h.t]);

    // Resume with no epoch change still re-sends (time accounting: the
    // paused report was not recorded).
    h = harness();
    h.r.updateStatus(st('paused'), true);
    await h.advance(3000);
    h.r.updateStatus(st('recording'), true);
    await h.advance(0);
    eq('paused -> recording, same epoch: re-sent at once', h.at(), ['0:one', '3000:one']);
    h.r.updateStatus(st('recording'), true);
    await h.advance(3000);
    eq('recording -> recording: nothing more', h.sent.length, 2);

    // A paused -> recording edge and an epoch bump in the same poll send once.
    h.r.updateStatus(st('paused'), true);
    await h.advance(3000);
    h.r.updateStatus(st('recording', {epoch: 5}), true);
    await h.advance(SPACING_MS * 3);
    eq('resume + epoch: one re-send', h.sent.length, 3);

    // Stopped: nothing sent; a start (new epoch) sends the focus at once with
    // the time of a change made while stopped.
    h = harness();
    h.r.updateStatus(st('stopped'), true);
    await h.advance(2000);
    h.focus = {...RAW, title: 'unlock'};
    h.r.changed();                          // t=2000, while stopped
    await h.advance(8000);
    eq('stopped: nothing sent', h.sent.length, 0);
    h.r.updateStatus(st('recording', {epoch: 1}), true);
    await h.advance(0);
    eq('start: sent at once with the stopped-time change', [h.at(), h.last().changed_at], [['10000:unlock'], wall(2000)]);

    // Paused without geometry (older session): exactly the old behavior.
    h = harness();
    h.r.updateStatus(st('recording', {geometry: false}), true);
    await h.advance(3000);
    h.r.updateStatus(st('paused', {geometry: false}), true);
    h.focus = {...RAW, title: 'two'};
    h.r.changed();
    await h.advance(5000);
    eq('older session: nothing sent while paused', h.at(), ['0:one']);
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
