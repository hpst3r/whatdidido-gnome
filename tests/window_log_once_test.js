// Amendment 2 item 6: "logged once per distinct message" survives successes
// (up to 32 messages remembered), so a window whose POST keeps failing does
// not log the same warning every time it is focused.
// Run: gjs -m tests/window_log_once_test.js
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

async function main() {
    const h = harness();
    h.reply = p => (p.title === 'bad' ? Promise.reject(Object.assign(new Error('HTTP 400 invalid'),
        {status: 400, code: 'invalid'})) : Promise.resolve({recorded: true}));
    h.r.updateStatus(rec, true);
    await h.advance(0);
    for (let i = 0; i < 5; i++) {
        h.focus = {...h.focus, title: 'bad'};
        h.r.changed();
        await h.advance(3000);
        h.focus = {...h.focus, title: `good${i}`};
        h.r.changed();
        await h.advance(3000);
    }
    const n = h.logs.filter(m => m.includes('HTTP 400 invalid')).length;
    check('the same error message is logged once', n === 1, `logged ${n} times: ${JSON.stringify(h.logs)}`);
}

main().catch(e => {
    failed++;
    print(`FAIL exception: ${e}\n${e.stack}`);
}).finally(() => {
    print(failed ? `${failed} FAILED` : 'all ok');
    System.exit(failed ? 1 : 0);
});
