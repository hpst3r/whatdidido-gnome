// Finding: after a failed POST the reporter keeps deduping against the last
// payload the server *accepted*. When the failure was ambiguous (timeout or
// 5xx after the server queued it), switching back to that window is skipped
// and the server keeps attributing time to the window whose POST "failed".
// Run: WDI_REVIEW=1 gjs -m tests/review_stale_dedupe_test.js
import System from 'system';
import GLib from 'gi://GLib';

if (GLib.getenv('WDI_REVIEW') !== '1') {
    print('SKIP (set WDI_REVIEW=1)');
    System.exit(0);
}

import {WindowReporter, sanitizeWindow, windowPayload} from '../whatdidido@wporter.org/lib/window_model.js';

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
    const h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(0);                       // B ("one") accepted
    h.reply = () => fail('request failed: Socket I/O timed out'); // server may have recorded it
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    await h.advance(3000);                    // A ("two") POST fails ambiguously
    h.reply = () => Promise.resolve({recorded: true});
    h.focus = {...h.focus, title: 'one'};     // back to B
    h.r.changed();
    await h.advance(5000);
    check('returning to the last accepted window after a failed POST is re-sent',
        h.titles().filter(t => t.endsWith(':one')).length >= 2, `sent=${JSON.stringify(h.titles())}`);
}

main().catch(e => {
    failed++;
    print(`FAIL exception: ${e}\n${e.stack}`);
}).finally(() => {
    print(failed ? `${failed} FAILED` : 'all ok');
    System.exit(failed ? 1 : 0);
});
