// Amendment 2 item 6: a failed POST (transport error, timeout, 5xx, 400) is
// retried with the *current* focus, with backoff, until it succeeds or the
// focus changes; also the transition re-send after start/resume, which would
// otherwise leave the time attributed to the previous window.
// Run: gjs -m tests/window_retry_test.js
import System from 'system';

import {WindowReporter} from '../whatdidido@wporter.org/lib/window_model.js';

let failed = 0;
function check(name, ok, detail) {
    if (ok) {
        print(`ok   ${name}`);
    } else {
        failed++;
        print(`FAIL ${name}: ${detail}`);
    }
}
const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};
const rec = {state: 'recording', window_activity: {available: true, recorded: 0, dropped: 0}};
// Fake clock/timers, like tests/window_model_test.js.
function harness() {
    const h = {t: 0, timers: new Map(), sent: [], logs: [],
        focus: {appId: 'a.desktop', appName: 'A', wmClass: 'a', title: 'one'},
        reply: () => Promise.resolve({recorded: true})};
    let nextId = 1;
    h.r = new WindowReporter({
        now: () => h.t,
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
    h.titles = () => h.sent.map(s => `${s.at}:${s.p.title ?? s.p.focus}`);
    return h;
}
const fail = msg => Promise.reject(Object.assign(new Error(msg), {status: 0, code: null}));

async function main() {
    // Transition re-send fails once (e.g. timeout / 500), then the server is fine.
    const h = harness();
    let calls = 0;
    h.reply = () => (calls++ === 0 ? fail('request failed: Socket I/O timed out') : Promise.resolve({recorded: true}));
    h.r.updateStatus(rec, true);
    await h.advance(0);
    // The user keeps working in the same window for a minute; polls keep coming.
    for (let i = 0; i < 30; i++) {
        await h.advance(2000);
        h.r.updateStatus(rec, true);
    }
    check('transition re-send that failed is retried while the focus is unchanged',
        h.sent.length >= 2, `sent=${JSON.stringify(h.titles())} timers=${h.timers.size}`);

    // Same for an ordinary focus change whose POST failed.
    const g = harness();
    g.r.updateStatus(rec, true);
    await g.advance(0);
    g.reply = () => fail('HTTP 500 failed');
    g.focus = {...g.focus, title: 'two'};
    g.r.changed();
    await g.advance(3000);
    g.reply = () => Promise.resolve({recorded: true});
    await g.advance(60000);
    check('failed focus-change POST is retried once the server recovers',
        g.sent.filter(s => s.p.title === 'two').length >= 2, `sent=${JSON.stringify(g.titles())}`);
}

main().catch(e => {
    failed++;
    print(`FAIL exception: ${e}\n${e.stack}`);
}).finally(() => {
    print(failed ? `${failed} FAILED` : 'all ok');
    System.exit(failed ? 1 : 0);
});
