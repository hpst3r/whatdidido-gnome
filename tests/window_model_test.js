// Run: gjs -m tests/window_model_test.js
// Active-window reporting (TIME_ACCOUNTING.md section 4): payload building,
// the server's sanitising/clamping rules, and the debounce/spacing scheduler
// driven by a fake clock.
import System from 'system';

import {
    SETTLE_MS, SPACING_MS, APP_FIELD_MAX_CHARS, TITLE_MAX_CHARS, METADATA_MAX_BYTES,
    RETRY_MIN_MS, RETRY_MAX_MS, LOGGED_MAX,
    utf8Length, metadataBytes, sanitizeWindow, isExcluded, windowPayload, samePayload,
    windowEligible, windowSwitchView, parseExcludedApps, formatExcludedApps, WindowReporter, FocusWatch,
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
eq('constants', [SETTLE_MS, SPACING_MS, APP_FIELD_MAX_CHARS, TITLE_MAX_CHARS, METADATA_MAX_BYTES,
    RETRY_MIN_MS, RETRY_MAX_MS, LOGGED_MAX], [1000, 2000, 255, 1024, 3500, 2000, 60000, 32]);

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
    eq('setting off while active: focus none once (spacing respected), nothing more',
        h.sent.map(s => `${s.at}:${s.p.focus}`), ['3000:window', '5000:none']);
    eq('setting off: no timers left', h.timers.size, 0);

    // Switching off while a POST is in flight: "none" follows its reply.
    h = harness();
    let hold;
    h.reply = () => new Promise(res => {
        hold = () => res({recorded: true});
    });
    h.r.updateStatus(rec, true);
    await h.advance(2500);
    h.r.setEnabled(false);
    await h.advance(1000);
    eq('off during flight: nothing until the reply', h.sent.length, 1);
    h.reply = () => Promise.reject(new Error('request failed: boom'));
    hold();
    await h.advance(10000);
    eq('off during flight: none sent after it, failure not retried',
        h.sent.map(s => `${s.at}:${s.p.focus}`), ['0:window', '3500:none']);
    eq('off during flight: max one in flight', h.maxInFlight, 1);

    // Off owed but recording ends first (or the setting comes back): no none.
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(500);
    h.r.setEnabled(false);
    h.r.updateStatus({...rec, state: 'paused'}, true);
    await h.advance(5000);
    eq('off then paused before the spacing end: no none', h.sent.length, 1);
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(500);
    h.r.setEnabled(false);
    h.r.setEnabled(true);
    await h.advance(5000);
    eq('off and on again within the spacing: current focus re-sent, no none',
        h.sent.map(s => `${s.at}:${s.p.focus}`), ['0:window', '2000:window']);
    h = harness({enabled: false});
    h.r.updateStatus(rec, true);
    h.r.setEnabled(false);
    await h.advance(5000);
    eq('setting already off: no none', h.sent.length, 0);
    h = harness();
    h.r.updateStatus({...rec, state: 'paused'}, true);
    h.r.setEnabled(false);
    await h.advance(5000);
    eq('setting off while paused: no none', h.sent.length, 0);

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
    eq('error logged once per distinct message', h.logs.length, 2);
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
    eq('failed send retried (backoff, then a change re-sends)', h.at(), ['0:one', '4000:two', '6000:two', '8000:two']);
    h.r.changed();
    await h.advance(5000);
    eq('success is remembered again (dedupe)', h.sent.length, 4);

    // Backoff: 2, 4, 8, 16, 32, 60, 60 s after each failure; reset by success.
    h = harness();
    h.reply = () => Promise.reject(Object.assign(new Error('HTTP 500 failed'), {status: 500, code: 'failed'}));
    h.r.updateStatus(rec, true);
    await h.advance(200000);
    const gapsOf = list => list.slice(1).map((s, i) => s.at - list[i].at);
    eq('backoff doubles from 2 s, capped at 60 s', gapsOf(h.sent),
        [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    eq('retries always carry the current focus', h.sent.every(s => s.title === 'one'), true);
    eq('backoff: one retry timer at most', h.timers.size, 1);
    eq('backoff: logged once', h.logs.length, 1);
    h.reply = () => Promise.resolve({recorded: true});
    await h.advance(60000);
    const n = h.sent.length;
    await h.advance(200000);
    eq('success stops retrying', h.sent.length, n);
    h.reply = () => Promise.reject(new Error('request failed: boom'));
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    await h.advance(1000);
    h.focus = {...h.focus, title: 'three'};
    await h.advance(2000);
    eq('after a success the backoff starts at 2 s again, with the current focus',
        h.sent.slice(n).map(s => s.title), ['two', 'three']);
    eq('... 2 s later', gapsOf(h.sent.slice(n)), [2000]);

    // A focus change cancels the pending retry (settle path instead).
    h = harness();
    h.reply = () => Promise.reject(new Error('request failed: boom'));
    h.r.updateStatus(rec, true);
    await h.advance(1500);
    h.reply = () => Promise.resolve({recorded: true});
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    await h.advance(5000);
    eq('change during backoff: retry replaced by the settled send', h.at(), ['0:one', '2500:two']);

    // Inactive (pause) and destroy clear the retry timer.
    h = harness();
    h.reply = () => Promise.reject(new Error('request failed: boom'));
    h.r.updateStatus(rec, true);
    await h.advance(100);
    h.r.updateStatus({...rec, state: 'paused'}, true);
    await h.advance(10000);
    eq('pause cancels the retry', [h.sent.length, h.timers.size], [1, 0]);
    h = harness();
    h.reply = () => Promise.reject(new Error('request failed: boom'));
    h.r.updateStatus(rec, true);
    await h.advance(100);
    h.r.destroy();
    await h.advance(10000);
    eq('destroy cancels the retry', [h.sent.length, h.timers.size], [1, 0]);

    // 409 is not retried (inactive until the next poll).
    h = harness();
    h.reply = () => Promise.reject(Object.assign(new Error('HTTP 409 unavailable'), {status: 409, code: 'unavailable'}));
    h.r.updateStatus(rec, true);
    await h.advance(10000);
    eq('409: no retry', [h.sent.length, h.timers.size], [1, 0]);

    // Log once: up to LOGGED_MAX distinct messages remembered, oldest evicted.
    h = harness();
    let msgNo = 0;
    h.reply = () => Promise.reject(new Error(`request failed: e${msgNo}`));
    h.r.updateStatus(rec, true);
    const failWith = async i => {
        msgNo = i;
        h.focus = {...h.focus, title: `w${h.sent.length}`};
        h.r.changed();
        await h.advance(3000);
    };
    for (let i = 0; i < LOGGED_MAX; i++)
        await failWith(i);
    const logged = h.logs.length;
    for (let i = 0; i < LOGGED_MAX; i++)
        await failWith(i);
    eq('32 distinct messages each logged once', [logged, h.logs.length], [LOGGED_MAX, LOGGED_MAX]);
    await failWith(LOGGED_MAX);      // evicts e0
    await failWith(0);
    eq('33rd message evicts the oldest', h.logs.length, LOGGED_MAX + 2);

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

    // Window epoch (Amendment 1 item 2): a changed epoch while recording is a
    // transition into recording (pause + resume between two polls).
    const recE = e => ({...rec, window_activity: {...WA, epoch: e}});
    h = harness();
    h.r.updateStatus(recE(0), true);
    await h.advance(3000);
    h.r.updateStatus(recE(0), true);
    await h.advance(3000);
    eq('epoch: unchanged epoch does not re-send', h.at(), ['0:one']);
    h.r.updateStatus(recE(2), true);
    await h.advance(0);
    eq('epoch: changed epoch re-sends the same focus at once', h.at(), ['0:one', '6000:one']);
    h.r.updateStatus(recE(2), true);
    await h.advance(3000);
    eq('epoch: same epoch again does not re-send', h.sent.length, 2);
    h.r.updateStatus(recE(3), true);
    await h.advance(0);
    eq('epoch: each change re-sends', h.at(), ['0:one', '6000:one', '9000:one']);
    h.r.updateStatus(recE(4), true);
    await h.advance(0);
    eq('epoch: re-send respects spacing (deferred)', h.sent.length, 3);
    await h.advance(SPACING_MS);
    eq('epoch: ... then sent', h.at(), ['0:one', '6000:one', '9000:one', '11000:one']);

    // A pending settle is replaced by the immediate re-send.
    h = harness();
    h.r.updateStatus(recE(0), true);
    await h.advance(3000);
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    await h.advance(200);
    h.r.updateStatus(recE(1), true);
    await h.advance(5000);
    eq('epoch: re-send uses current focus, settle cancelled', h.at(), ['0:one', '3200:two']);

    // Missing epoch (older server): exactly the old behaviour.
    h = harness();
    h.r.updateStatus(rec, true);
    await h.advance(3000);
    h.r.updateStatus(rec, true);
    await h.advance(3000);
    h.r.updateStatus(recE(5), true);
    await h.advance(3000);
    h.r.updateStatus(rec, true);
    await h.advance(3000);
    h.r.updateStatus(recE(6), true);
    await h.advance(3000);
    eq('epoch missing/appearing/disappearing: no re-send', h.at(), ['0:one']);
    for (const bad of ['7', -1, 1.5, null, true]) {
        h.r.updateStatus({...rec, window_activity: {...WA, epoch: bad}}, true);
        await h.advance(3000);
    }
    h.r.updateStatus(recE(8), true);
    await h.advance(3000);
    eq('epoch: non-integer/negative values are treated as missing', h.at(), ['0:one']);

    // Epoch change together with a real transition sends once.
    h = harness();
    h.r.updateStatus(recE(0), true);
    await h.advance(3000);
    h.r.updateStatus({...recE(1), state: 'paused'}, true);
    await h.advance(3000);
    h.r.updateStatus(recE(2), true);
    await h.advance(3000);
    eq('epoch: paused -> recording with a new epoch sends once', h.at(), ['0:one', '6000:one']);

    // Epoch changes while inactive (setting off, paused) never send.
    h = harness({enabled: false});
    h.r.updateStatus(recE(0), true);
    h.r.updateStatus(recE(1), true);
    await h.advance(3000);
    eq('epoch: setting off -> nothing sent', h.sent.length, 0);
    h = harness();
    h.r.updateStatus({...recE(0), state: 'paused'}, true);
    h.r.updateStatus({...recE(1), state: 'paused'}, true);
    await h.advance(3000);
    eq('epoch: paused -> nothing sent', h.sent.length, 0);

    // Server restart (not running in between) with a smaller epoch: the
    // not-running transition re-sends once, no double send.
    h = harness();
    h.r.updateStatus(recE(9), true);
    await h.advance(3000);
    h.r.updateStatus(null, false);
    h.r.updateStatus(recE(0), true);
    await h.advance(3000);
    h.r.updateStatus(recE(0), true);
    await h.advance(3000);
    eq('epoch: restart re-sends once', h.at(), ['0:one', '3000:one']);

    // Epoch change while a send is in flight: the stale response must not be
    // remembered, the re-send follows the response (spacing permitting), and
    // there is never more than one request in flight.
    h = harness();
    h.r.updateStatus(recE(0), true);
    await h.advance(3000);
    h.focus = {...h.focus, title: 'two'};
    h.r.changed();
    h.reply = () => new Promise(res => {
        release = () => res({recorded: false});
    });
    await h.advance(1000); // t=4000: POST "two" (epoch 0) in flight
    eq('epoch in flight: request started', h.at(), ['0:one', '4000:two']);
    h.r.updateStatus(recE(1), true);
    await h.advance(500);
    eq('epoch in flight: no second POST while one is in flight', h.sent.length, 2);
    h.reply = () => Promise.resolve({recorded: true});
    release?.();
    await h.advance(0);
    eq('epoch in flight: re-send deferred to spacing end', h.sent.length, 2);
    await h.advance(SPACING_MS);
    eq('epoch in flight: same focus re-sent after the stale response', h.at(), ['0:one', '4000:two', '6000:two']);
    eq('epoch in flight: never two in flight', h.maxInFlight, 1);
    h.r.changed();
    await h.advance(5000);
    eq('epoch in flight: re-send is remembered (dedupe afterwards)', h.sent.length, 3);

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

// --- focused-window signals (window_tracker.js glue) -------------------------
// Fake MetaWindow: connect/disconnect/emit; dispose() makes disconnect throw
// like a GObject that is already gone.
function fakeWindow() {
    const w = {handlers: new Map(), nextId: 1, disposed: false, attempts: 0};
    w.connect = (sig, fn) => {
        w.handlers.set(w.nextId, {sig, fn});
        return w.nextId++;
    };
    w.disconnect = id => {
        w.attempts++;
        if (w.disposed)
            throw new Error('Object has been already disposed');
        w.handlers.delete(id);
    };
    w.emit = sig => {
        for (const h of [...w.handlers.values()].filter(x => x.sig === sig))
            h.fn();
    };
    w.signals = () => [...w.handlers.values()].map(h => h.sig).sort();
    return w;
}

function focusWatchTests() {
    let changes = 0;
    const fw = new FocusWatch(() => changes++);
    const a = fakeWindow(), b = fakeWindow();
    fw.watch(a);
    eq('watch: title, wm-class and unmanaged', a.signals(), ['notify::title', 'notify::wm-class', 'unmanaged']);
    a.emit('notify::title');
    a.emit('notify::wm-class');
    eq('watch: title/wm-class changes reported', changes, 2);
    fw.watch(b);
    eq('watch: switching windows disconnects the old one', [a.signals(), b.signals().length, fw.window === b], [[], 3, true]);
    a.emit('notify::title');
    eq('watch: old window no longer reported', changes, 2);

    b.emit('unmanaged');
    eq('unmanaged: handlers cleared', [b.signals(), fw.window], [[], null]);
    b.emit('notify::title');
    eq('unmanaged: no reports afterwards', changes, 2);
    let threw = null;
    try {
        fw.watch(a);
        fw.clear();
        fw.clear();
    } catch (e) {
        threw = e;
    }
    eq('clear twice is harmless', [threw, a.signals()], [null, []]);

    // The window went away without a usable `unmanaged` (already disposed):
    // every disconnect is attempted, none throws, the watch is reset.
    const c = fakeWindow(), d = fakeWindow();
    fw.watch(c);
    c.disposed = true;
    threw = null;
    try {
        fw.watch(d);
    } catch (e) {
        threw = e;
    }
    eq('disposed window: switching does not throw', String(threw), 'null');
    eq('disposed window: all three disconnects attempted, new window watched', [c.attempts, fw.window === d, d.signals().length], [3, true, 3]);
    d.disposed = true;
    threw = null;
    try {
        fw.clear();
    } catch (e) {
        threw = e;
    }
    eq('disposed window: clear (destroy) does not throw', [String(threw), fw.window], ['null', null]);
    fw.watch(null);
    eq('watch(null): nothing watched', fw.window, null);
}
focusWatchTests();

await schedulerTests().catch(e => {
    failed++;
    print(`FAIL uncaught: ${e}\n${e.stack}`);
});

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
