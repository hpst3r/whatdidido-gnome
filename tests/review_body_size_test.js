// Finding: client-side sanitising keeps the metadata under 3500 bytes, but the
// JSON body can still exceed the server's 4096-byte WINDOW_MAX_BYTES (JSON
// escapes '"' and '\' as two bytes), so the server answers 400 invalid and
// the window is never recorded ("what is sent is what gets recorded" breaks).
// Run: WDI_REVIEW=1 gjs -m tests/review_body_size_test.js
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
    // An app-less X11 window: Shell's app name is the WM_CLASS, which the
    // client controls. 255 quotes each, title of backslashes + emoji.
    const raw = {appId: 'window:42', appName: '"'.repeat(255), wmClass: '"'.repeat(255),
        title: '\\'.repeat(382) + '😀'.repeat(700)};
    const body = new TextEncoder().encode(JSON.stringify(windowPayload(raw))).length;
    check('sanitised POST body fits the server limit (4096 bytes)', body <= 4096, `body=${body} bytes`);
    const plain = new TextEncoder().encode(JSON.stringify(sanitizeWindow({focus: 'window',
        app_id: 'org.example.App.desktop', app_name: 'Example', wm_class: 'example',
        title: '"'.repeat(1024)}))).length;
    check('control case: a 1024-quote title alone fits', plain <= 4096, `body=${plain} bytes`);
}

main().catch(e => {
    failed++;
    print(`FAIL exception: ${e}\n${e.stack}`);
}).finally(() => {
    print(failed ? `${failed} FAILED` : 'all ok');
    System.exit(failed ? 1 : 0);
});
