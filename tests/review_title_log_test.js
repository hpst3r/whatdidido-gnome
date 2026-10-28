// Run: gjs -m tests/review_title_log_test.js
// Review PoC (not in the Makefile), TR-3: ignored title rules are "logged
// once" through the reporter's log-once set, which keeps only LOGGED_MAX
// (32) messages. More than 32 ignored rules evict each other, so every
// setTitleRules() (every change of window-title-rules) logs all of them
// again, and they also evict a send failure that was already logged, which
// is then logged a second time.
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
    const h = {t: 0, timers: new Map(), sent: [], logs: [], fail: false,
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
            return h.fail ? Promise.reject({status: 503, message: 'HTTP 503'}) : Promise.resolve({recorded: true});
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

    let h = harness({titleRules: bad});
    const first = h.logs.length;
    eq('TR-3 every ignored rule is logged at start', first, bad.length);
    h.r.setTitleRules(bad);
    h.r.setTitleRules(bad);
    eq('TR-3 the same ignored rules are not logged again on later changes', h.logs.length, first);

    // A failure logged once stays logged once, whatever the title rules log.
    h = harness();
    h.fail = true;
    h.r.updateStatus(st, true);
    await h.advance(SETTLE_MS + SPACING_MS);
    const failures = () => h.logs.filter(m => m.includes('report failed')).length;
    eq('TR-3 the failure is logged', failures(), 1);
    h.r.setTitleRules(bad);
    await h.advance(RETRY_MAX_MS * 2);
    eq('TR-3 the same failure is not logged again after the rule problems', failures(), 1);
}

await main();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
