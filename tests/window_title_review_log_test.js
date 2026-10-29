// Run: gjs -m tests/window_title_review_log_test.js
// Logging of title rule problems (from the review's PoC, TR-3): the
// reporter's log-once set keeps only LOGGED_MAX (32) messages, shared with
// send failures. Rule problems are logged only when the list of problems
// changes, outside that set, so other messages can't make the same problems
// be logged again, and rule problems can't push out a send failure that was
// already logged, which would then be logged a second time.
import System from 'system';

import {LOGGED_MAX, RETRY_MAX_MS, SETTLE_MS, SPACING_MS, WindowReporter} from '../whatdidido@wporter.org/lib/window_model.js';

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

const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};
const st = {state: 'recording', window_activity: {available: true, recorded: 0, dropped: 0, epoch: 0, geometry: false}};
function harness(opts = {}) {
    const h = {t: 0, timers: new Map(), sent: [], logs: [], fail: false, message: 'HTTP 503',
        focus: {appId: 'a.desktop', appName: 'A', wmClass: 'a', title: 'one'}};
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
            h.sent.push(p);
            return h.fail ? Promise.reject({status: 503, message: h.message}) : Promise.resolve({recorded: true});
        },
        log: m => h.logs.push(m),
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
    return h;
}

async function main() {
    const bad = Array.from({length: LOGGED_MAX + 8}, (_, i) => ['', '', `label ${i}`]);  // empty patterns
    const failures = h => h.logs.filter(m => m.includes('report failed')).length;

    // The problems, then more than LOGGED_MAX distinct send failures.
    let h = harness({titleRules: bad});
    const first = h.logs.length;
    eq('TR-3 every ignored rule is logged at start', [first, /rule 1: .*; 37 more/.test(h.logs[0])], [1, true]);
    h.fail = true;
    h.r.updateStatus(st, true);
    for (let i = 0; i <= LOGGED_MAX; i++) {
        h.message = `HTTP 50${i}`;
        h.r.changed();
        await h.advance(SETTLE_MS + SPACING_MS);
    }
    eq('TR-3 the distinct failures are logged', failures(h), LOGGED_MAX + 1);
    h.r.setTitleRules(bad);
    h.r.setTitleRules(bad.map(e => [...e]));
    eq('TR-3 the same ignored rules are not logged again on later changes', h.logs.length - failures(h), first);

    // A failure logged once stays logged once, whatever the title rules log.
    h = harness();
    h.fail = true;
    h.r.updateStatus(st, true);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('TR-3 the failure is logged', failures(h), 1);
    for (let i = 0; i <= LOGGED_MAX; i++)  // problems that differ each time
        h.r.setTitleRules([...Array.from({length: i}, () => ['', 'ok', '']), ['', '', '']]);
    eq('TR-3 each new list of problems is logged', h.logs.length - failures(h), LOGGED_MAX + 1);
    await h.advance(RETRY_MAX_MS * 2);
    eq('TR-3 the same failure is not logged again after the rule problems', failures(h), 1);
}

await main();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
