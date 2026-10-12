// Run: gjs -m tests/window_model_test.js
// Active-window reporting (TIME_ACCOUNTING.md section 4): payload building,
// the server's sanitising/clamping rules, and the debounce/spacing scheduler
// driven by a fake clock.
import System from 'system';

import {
    SETTLE_MS, SPACING_MS, APP_FIELD_MAX_CHARS, TITLE_MAX_CHARS, METADATA_MAX_BYTES,
    utf8Length, metadataBytes, sanitizeWindow, isExcluded, windowPayload, samePayload,
    windowEligible, windowSwitchView, parseExcludedApps, formatExcludedApps, WindowReporter,
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
const cps = s => [...s].length;
const win = (app_id, app_name, wm_class, title) => ({focus: 'window', app_id, app_name, wm_class, title});

// --- constants ------------------------------------------------------------
eq('constants', [SETTLE_MS, SPACING_MS, APP_FIELD_MAX_CHARS, TITLE_MAX_CHARS, METADATA_MAX_BYTES],
    [1000, 2000, 255, 1024, 3500]);

// --- byte accounting (domain rule: sum of utf-8 key + value bytes) --------
eq('utf8Length ascii/2/3/4-byte', [utf8Length('a'), utf8Length('é'), utf8Length('€'), utf8Length('😀'), utf8Length('')],
    [1, 2, 3, 4, 0]);
eq('metadataBytes none', metadataBytes({focus: 'none'}), 9);
eq('metadataBytes window keys = 38', metadataBytes(win('', '', '', '')), 38);
eq('metadataBytes counts values', metadataBytes(win('a', 'é', '€', '😀')), 38 + 10);

// --- sanitising -------------------------------------------------------------
eq('C0/C1 -> space, others kept',
    sanitizeWindow(win('a\u0000b', 'c\u001fd', 'e\u007ff', 'g\u009fh i\tj\nk ')),
    win('a b', 'c d', 'e f', 'g h i j k '));
eq('none passes through', sanitizeWindow({focus: 'none'}), {focus: 'none'});
const clampedApp = sanitizeWindow(win('a'.repeat(300), 'b'.repeat(256), 'c'.repeat(255), 't'));
eq('app fields clamped to 255 chars', [clampedApp.app_id.length, clampedApp.app_name.length, clampedApp.wm_class.length],
    [255, 255, 255]);
const euroTitle = sanitizeWindow(win('x', 'X', 'x', '€'.repeat(1100))).title;
eq('multi-byte title clamped by characters, no ellipsis', [cps(euroTitle), euroTitle === '€'.repeat(1024)], [1024, true]);
const emojiApp = sanitizeWindow(win('😀'.repeat(300), '', '', '')).app_id;
eq('astral chars count as one character', [cps(emojiApp), emojiApp.isWellFormed()], [255, true]);
eq('lone surrogate -> U+FFFD', sanitizeWindow(win('', '', '', 'a\ud800b')).title, 'a�b');

// 3500-byte shrink: title shortened at a character boundary, ends with '…'.
const big = sanitizeWindow(win('€'.repeat(255), 'é'.repeat(255), 'a'.repeat(255), 'ß'.repeat(2000)));
eq('3500 shrink: title', [big.title === `${'ß'.repeat(964)}…`, cps(big.title)], [true, 965]);
eq('3500 shrink: total bytes', metadataBytes(big), 3499);
eq('3500 shrink: app fields untouched', [big.app_id, big.app_name, big.wm_class],
    ['€'.repeat(255), 'é'.repeat(255), 'a'.repeat(255)]);
const emo = sanitizeWindow(win('x', 'X', 'x', '😀'.repeat(1100)));
eq('3500 shrink: 4-byte chars never split', [cps(emo.title), emo.title.endsWith('😀…'), emo.title.isWellFormed(), metadataBytes(emo)],
    [865, true, true, 3500]);
const exact = win('', '€'.repeat(130), '', '€'.repeat(1024));
eq('exactly 3500 bytes is kept', [metadataBytes(exact), sanitizeWindow(exact)], [3500, exact]);
const over = sanitizeWindow(win('', '€'.repeat(130), 'a', '€'.repeat(1024)));
eq('3501 bytes shrinks', [over.title === `${'€'.repeat(1022)}…`, metadataBytes(over)], [true, 3498]);
eq('sanitising is idempotent', sanitizeWindow(big), big);

// --- payload ----------------------------------------------------------------
eq('no focus -> none', windowPayload(null), {focus: 'none'});
eq('nulls -> empty strings', windowPayload({appId: null, appName: null, wmClass: null, title: null}),
    win('', '', '', ''));
eq('undefined -> empty strings', windowPayload({}), win('', '', '', ''));
eq('full payload, exact key order',
    JSON.stringify(windowPayload({appId: 'org.gnome.Ptyxis.desktop', appName: 'Terminal', wmClass: 'org.gnome.Ptyxis', title: 'vim'})),
    '{"focus":"window","app_id":"org.gnome.Ptyxis.desktop","app_name":"Terminal","wm_class":"org.gnome.Ptyxis","title":"vim"}');
eq('window: app id -> empty', windowPayload({appId: 'window:42', appName: 'xterm', wmClass: 'XTerm', title: 't'}),
    win('', 'xterm', 'XTerm', 't'));
eq('payload is sanitised', windowPayload({appId: 'a', appName: 'b', wmClass: 'c', title: 'x\ny'}).title, 'x y');
eq('excluded app -> empty title',
    windowPayload({appId: 'org.keepassxc.KeePassXC.desktop', appName: 'KeePassXC', wmClass: 'keepassxc', title: 'secret'},
        ['org.keepassxc.KeePassXC.desktop']),
    win('org.keepassxc.KeePassXC.desktop', 'KeePassXC', 'keepassxc', ''));
eq('excluded without .desktop suffix matches', isExcluded('org.keepassxc.KeePassXC.desktop', [' org.keepassxc.KeePassXC ']), true);
eq('other apps not excluded', isExcluded('org.gnome.Ptyxis.desktop', ['org.keepassxc.KeePassXC.desktop']), false);
eq('empty app id never excluded', [isExcluded('', ['']), isExcluded('', ['  '])], [false, false]);
eq('excluded is exact, not prefix', isExcluded('org.gnome.PtyxisX.desktop', ['org.gnome.Ptyxis']), false);

eq('samePayload equal', samePayload(win('a', 'b', 'c', 'd'), win('a', 'b', 'c', 'd')), true);
eq('samePayload title differs', samePayload(win('a', 'b', 'c', 'd'), win('a', 'b', 'c', 'e')), false);
eq('samePayload none', samePayload({focus: 'none'}, {focus: 'none'}), true);
eq('samePayload vs null', [samePayload(null, {focus: 'none'}), samePayload({focus: 'none'}, null)], [false, false]);

// --- availability gating ----------------------------------------------------------
const WA = {available: true, recorded: 0, dropped: 0};
const rec = {state: 'recording', window_activity: WA};
eq('eligible: recording + available', windowEligible(rec, true), true);
eq('not eligible: not running', windowEligible(rec, false), false);
eq('not eligible: null status', windowEligible(null, true), false);
eq('not eligible: paused', windowEligible({...rec, state: 'paused'}, true), false);
eq('not eligible: recovering', windowEligible({...rec, state: 'recovering'}, true), false);
eq('not eligible: no window_activity', windowEligible({state: 'recording'}, true), false);
eq('not eligible: available not === true',
    windowEligible({state: 'recording', window_activity: {available: 'true'}}, true), false);

const LABEL = 'Record active window';
const OFF_LABEL = 'Record active window (not enabled on the server)';
eq('switch: offered', windowSwitchView(rec, {running: true, enabled: true, unavailable: false}),
    {sensitive: true, on: true, label: LABEL});
eq('switch: offered while paused', windowSwitchView({...rec, state: 'paused'}, {running: true, enabled: false, unavailable: false}),
    {sensitive: true, on: false, label: LABEL});
eq('switch: not offered', windowSwitchView({state: 'recording'}, {running: true, enabled: true, unavailable: false}),
    {sensitive: false, on: true, label: OFF_LABEL});
eq('switch: 409 unavailable', windowSwitchView(rec, {running: true, enabled: true, unavailable: true}),
    {sensitive: false, on: true, label: OFF_LABEL});
eq('switch: not running', windowSwitchView(null, {running: false, enabled: true, unavailable: false}),
    {sensitive: false, on: true, label: LABEL});

eq('parseExcludedApps', parseExcludedApps(' a.desktop, b ,,a.desktop\n c\t'), ['a.desktop', 'b', 'c']);
eq('parseExcludedApps empty', parseExcludedApps('  , '), []);
eq('formatExcludedApps', formatExcludedApps(['a.desktop', 'b']), 'a.desktop, b');

// --- scheduler ------------------------------------------------------------
const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};

function harness({enabled = true, excluded = []} = {}) {
    const h = {t: 0, timers: new Map(), sent: [], logs: [], focus: {appId: 'a.desktop', appName: 'A', wmClass: 'a', title: 'one'},
        inFlight: 0, maxInFlight: 0, reply: () => Promise.resolve({recorded: true}), reads: 0};
    let nextId = 1;
    h.r = new WindowReporter({
        now: () => h.t,
        setTimer: (ms, fn) => {
            const id = nextId++;
            h.timers.set(id, {at: h.t + ms, fn});
            return id;
        },
        clearTimer: id => h.timers.delete(id),
        readFocus: () => {
            h.reads++;
            return h.focus;
        },
        send: p => {
            h.sent.push({at: h.t, title: p.title ?? null, p});
            h.inFlight++;
            h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
            return h.reply(p).finally(() => h.inFlight--);
        },
        log: m => h.logs.push(m),
        onUnavailable: () => h.onUnavailable?.(),
        enabled,
        excluded,
    });
    // Run timers in time order up to now + ms, letting promises settle between.
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
    h.at = () => h.sent.map(s => `${s.at}:${s.title}`);
    return h;
}

async function schedulerTests() {
    let h = harness();
    h.r.changed();
    await h.advance(5000);
    eq('inactive before any status: nothing sent, focus not read', [h.sent.length, h.reads], [0, 0]);
    eq('inactive', h.r.active, false);

    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('transition into recording sends at once', h.at(), ['5000:one']);
    eq('active', h.r.active, true);

    // Debounce: each change re-arms the 1000 ms settle timer.
    h.sent = [];
    await h.advance(3000);
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    await h.advance(500);
    h.r.changed();
    await h.advance(999);
    eq('settle re-armed: nothing yet', h.sent.length, 0);
    h.focus = {...h.focus, title: 'three'};
    await h.advance(1);
    eq('fires 1000 ms after the last change with the current focus', h.at(), ['9500:three']);

    // Dedupe.
    h.sent = [];
    h.r.changed();
    await h.advance(5000);
    eq('identical payload skipped', h.sent.length, 0);

    // Spacing + latest wins.
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(0);
    h.focus = {...h.focus, title: 'B'};
    await h.advance(100);
    h.r.changed();
    await h.advance(1400); // t=1500: settle fired at 1100, deferred to 2000
    eq('send inside the spacing is deferred', h.at(), ['0:one']);
    h.focus = {...h.focus, title: 'C'};
    h.r.changed();
    await h.advance(5000);
    eq('deferred send at spacing end uses the latest focus; settle then dedupes', h.at(), ['0:one', '2000:C']);

    // At most one POST per 2000 ms under a storm of changes.
    h = harness();
    h.r.updateStatus(rec, true);
    for (let i = 0; i < 100; i++) {
        h.focus = {...h.focus, title: `t${i}`};
        h.r.changed();
        await h.advance(i % 3 === 0 ? 1100 : 150);
    }
    await h.advance(5000);
    const gaps = h.sent.slice(1).map((s, i) => s.at - h.sent[i].at);
    eq('storm: spacing >= 2000 between every POST', gaps.every(g => g >= SPACING_MS), true);
    eq('storm: last focus eventually sent', h.sent.at(-1)?.title, 't99');
    eq('storm: never two in flight', h.maxInFlight, 1);

    // Transition re-send of the same focus.
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(3000);
    h.r.updateStatus({...rec, state: 'paused'}, true);
    eq('paused -> inactive', h.r.active, false);
    h.r.changed();
    await h.advance(3000);
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('resume: same focus re-sent at once', h.at(), ['0:one', '6000:one']);
    h.r.updateStatus({...rec, state: 'paused'}, true);
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('transition re-send still respects spacing (deferred)', h.at(), ['0:one', '6000:one']);
    await h.advance(SPACING_MS);
    eq('... then sent', h.at(), ['0:one', '6000:one', '8000:one']);
    h.r.updateStatus(rec, true);
    await h.advance(3000);
    eq('recording -> recording is not a transition', h.sent.length, 3);

    h = harness();
    h.r.updateStatus(null, false);
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('transition from not running', h.sent.length, 1);

    h = harness();
    h.r.updateStatus({state: 'recording'}, true);
    h.r.changed();
    await h.advance(3000);
    eq('recording but not offered: nothing sent', h.sent.length, 0);
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('transition from unavailable', h.sent.length, 1);

    // Pause cancels pending settle and deferred sends.
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(100);
    h.focus = {...h.focus, title: 'secret-while-paused'};
    h.r.changed();
    await h.advance(1000); // deferred to 2000 by spacing
    h.r.updateStatus({...rec, state: 'paused'}, true);
    h.r.changed();
    await h.advance(10000);
    eq('nothing sent after pause', h.at(), ['0:one']);
    eq('no timers left while paused', h.timers.size, 0);

    // Setting.
    h = harness({enabled: false});
    h.r.updateStatus(rec, true);
    h.r.changed();
    await h.advance(3000);
    eq('setting off: nothing sent', [h.sent.length, h.reads], [0, 0]);
    h.r.setEnabled(true);
    await h.advance(0);
    eq('setting on while recording sends at once', h.sent.length, 1);
    h.r.setEnabled(false);
    h.focus = {...h.focus, title: 'x'};
    h.r.changed();
    await h.advance(5000);
    eq('setting off again: nothing more', h.sent.length, 1);

    // Excluded apps.
    h = harness({excluded: ['a.desktop']});
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('excluded app sends empty title', h.sent[0]?.p, win('a.desktop', 'A', 'a', ''));
    h.r.setExcluded([]);
    await h.advance(3000);
    eq('un-excluding re-sends with title', h.sent.map(s => s.title), ['', 'one']);

    // No focus.
    h = harness();
    h.focus = null;
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('no focused window -> focus none', h.sent[0]?.p, {focus: 'none'});

    // 409 unavailable: off until the next status poll.
    h = harness();
    h.reply = () => Promise.reject(Object.assign(new Error('HTTP 409 unavailable'), {status: 409, code: 'unavailable'}));
    let notified = 0;
    h.onUnavailable = () => notified++;
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('409 -> inactive', [h.r.active, h.r.unavailable], [false, true]);
    eq('409 -> onUnavailable called once', notified, 1);
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    await h.advance(5000);
    eq('409: no sends until the next poll', h.sent.length, 1);
    h.reply = () => Promise.resolve({recorded: true});
    h.r.updateStatus(rec, true);
    await h.advance(0);
    eq('next poll still offered -> re-send', h.at(), ['0:one', '5000:two']);
    eq('409 view', windowSwitchView(rec, {running: true, enabled: true, unavailable: h.r.unavailable}).sensitive, true);

    // Errors logged once per distinct message, never with the title.
    h = harness();
    h.reply = () => Promise.reject(Object.assign(new Error('HTTP 400 invalid'), {status: 400, code: 'invalid'}));
    h.focus = {...h.focus, title: 'TOPSECRET'};
    h.r.updateStatus(rec, true);
    for (const t of ['TOPSECRET2', 'TOPSECRET3']) {
        await h.advance(3000);
        h.focus = {...h.focus, title: t};
        h.r.changed();
    }
    await h.advance(3000);
    h.reply = () => Promise.reject(new Error('request failed: boom'));
    h.focus = {...h.focus, title: 'TOPSECRET4'};
    h.r.changed();
    await h.advance(3000);
    eq('error logged once per distinct message', [h.sent.length, h.logs.length], [4, 2]);
    eq('logs never contain titles', h.logs.some(l => l.includes('TOPSECRET')), false);

    // A failed send is not remembered as sent: the same focus is retried on
    // the next change.
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(3000);
    h.reply = () => Promise.reject(new Error('request failed: boom'));
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    await h.advance(3000);
    h.reply = () => Promise.resolve({recorded: true});
    h.r.changed();
    await h.advance(3000);
    eq('failed send retried on next change', h.at(), ['0:one', '4000:two', '7000:two']);

    // One request in flight; a change during it is sent after it completes.
    h = harness();
    let release;
    h.reply = () => new Promise(res => {
        release = () => res({recorded: true});
    });
    h.r.updateStatus(rec, true);
    await h.advance(2500);
    h.focus = {...h.focus, title: 'later'};
    h.r.changed();
    await h.advance(3000);
    eq('no second POST while one is in flight', h.sent.length, 1);
    h.reply = () => Promise.resolve({recorded: true});
    release?.();
    await h.advance(0);
    eq('pending change sent when the first completes', h.at(), ['0:one', '5500:later']);

    // A response for a POST made before a transition must not suppress the re-send.
    h = harness();
    h.reply = () => new Promise(res => {
        release = () => res({recorded: false});
    });
    h.r.updateStatus(rec, true);
    await h.advance(2500);
    h.r.updateStatus({...rec, state: 'paused'}, true);
    h.r.updateStatus(rec, true);
    h.reply = () => Promise.resolve({recorded: true});
    release?.();
    await h.advance(0);
    eq('stale response does not suppress transition re-send', h.at(), ['0:one', '2500:one']);

    // destroy removes every timer.
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(100);
    h.focus = {...h.focus, title: 'z'};
    h.r.changed();
    await h.advance(1000);
    h.r.changed();
    h.r.destroy();
    eq('destroy clears timers', [h.timers.size, h.r.active], [0, false]);
    h.r.updateStatus(rec, true);
    h.r.changed();
    await h.advance(10000);
    eq('nothing after destroy', h.sent.length, 1);
}

await schedulerTests().catch(e => {
    failed++;
    print(`FAIL uncaught: ${e}\n${e.stack}`);
});

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
