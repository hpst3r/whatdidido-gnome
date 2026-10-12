// Client tests against a loopback fake of the control API.
// Run: gjs -m tests/client_test.js [runtime-dir]
// runtime-dir stands in for $XDG_RUNTIME_DIR (default: build/test-runtime).
import GLib from 'gi://GLib';
import System from 'system';

import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {sanitizeWindow, windowPayload} from '../whatdidido@wporter.org/lib/window_model.js';
import {FakeControl, writeControlFile, removeControlFile} from './fake_control.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const runtimeDir = ARGV[0] ?? GLib.build_filenamev([here, '..', 'build', 'test-runtime']);
GLib.mkdir_with_parents(runtimeDir, 0o700);
try {
    removeControlFile(runtimeDir);
} catch {}

const T1 = 'tokenONE_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = 'tokenTWO_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
async function rejects(name, promise, check) {
    try {
        const v = await promise;
        failed++;
        print(`FAIL ${name}: resolved ${JSON.stringify(v)}`);
    } catch (e) {
        if (check(e)) {
            print(`ok   ${name}`);
        } else {
            failed++;
            print(`FAIL ${name}: wrong error ${JSON.stringify({message: e.message, status: e.status, code: e.code, notRunning: e.notRunning})}`);
        }
    }
}
const noBrowserHeaders = r => !['origin', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].some(h => h in r.headers);
const summary = reqs => reqs.map(r => `${r.method} ${r.path} ${r.headers.authorization === `Bearer ${T1}` ? 'T1' : r.headers.authorization === `Bearer ${T2}` ? 'T2' : r.headers.authorization ?? '-'} ${r.body}`);

async function main() {
    const client = new ControlClient({runtimeDir});

    // --- no control file: server not running --------------------------------
    await rejects('missing control file -> not running', client.status(null), e => e.notRunning === true);

    const fake = new FakeControl({token: T1});
    const base = fake.listen();
    writeControlFile(runtimeDir, base, T1);

    // --- status ----------------------------------------------------------------
    const s = await client.status(null);
    eq('status body', [s?.state, s?.samples, s?.mic?.available], ['recording', 4, true]);
    const r0 = fake.requests[0];
    eq('status request', r0 && [r0.method, r0.path, r0.query, r0.body], ['GET', '/control/v1/status', null, '']);
    eq('bearer header', r0?.headers.authorization, `Bearer ${T1}`);
    eq('no browser headers on GET', r0 && noBrowserHeaders(r0), true);
    eq('host is loopback', r0?.headers.host, `127.0.0.1:${fake.port}`);

    eq('baseUrl from control file', await client.baseUrl?.(null), base);

    // --- commands --------------------------------------------------------------
    fake.requests = [];
    eq('pause -> 202 state', await client.command('pause', null), {state: 'paused'});
    const r1 = fake.requests[0];
    eq('command body', r1 && JSON.parse(r1.body), {action: 'pause'});
    eq('command content-type', r1?.headers['content-type'], 'application/json');
    eq('no browser headers on POST', r1 && noBrowserHeaders(r1), true);
    await rejects('pause again -> 409 not_allowed', client.command('pause', null),
        e => e.status === 409 && e.code === 'not_allowed' && !e.notRunning);

    fake.requests = [];
    eq('interval', await client.setInterval(10, null), {interval_seconds: 10});
    eq('interval body', fake.requests[0] && JSON.parse(fake.requests[0].body), {seconds: 10});

    // --- microphone --------------------------------------------------------------
    fake.requests = [];
    const m = await client.setMicOn(true, 'm2', null);
    eq('mic on preferred', m, {mic: {available: true, on: true, source_id: 'm2'}});
    eq('mic on sequence', summary(fake.requests), [
        'GET /control/v1/microphones T1 ',
        'POST /control/v1/mic T1 {"on":true,"source_id":"m2","inventory":"inv1"}']);

    fake.requests = [];
    await client.setMicOn(true, 'unplugged', null);
    eq('mic on falls back to first', JSON.parse(fake.requests[1]?.body ?? 'null')?.source_id, 'm1');

    fake.requests = [];
    eq('mic off', await client.setMicOn(false, 'm2', null), {mic: {available: true, on: false, source_id: null}});
    eq('mic off sends only {on:false}', summary(fake.requests), ['POST /control/v1/mic T1 {"on":false}']);

    fake.requests = [];
    fake.inventoryChanges = 1;
    eq('inventory_changed retried once', (await client.setMicOn(true, '', null))?.mic?.on, true);
    eq('inventory retry sequence', summary(fake.requests), [
        'GET /control/v1/microphones T1 ',
        'POST /control/v1/mic T1 {"on":true,"source_id":"m1","inventory":"inv1"}',
        'GET /control/v1/microphones T1 ',
        'POST /control/v1/mic T1 {"on":true,"source_id":"m1","inventory":"inv2"}']);

    fake.requests = [];
    fake.inventoryChanges = 2;
    await rejects('inventory_changed twice -> error', client.setMicOn(true, '', null),
        e => e.status === 409 && e.code === 'inventory_changed');
    eq('only one retry', fake.requests.length, 4);
    fake.inventoryChanges = 0;

    fake.mics = [];
    await rejects('no microphones -> error', client.setMicOn(true, '', null), e => /microphone/i.test(e.message));
    fake.mics = [{id: 'm1', label: 'Built-in'}];

    // --- active window (POST /control/v1/window) -----------------------------------
    const W = {focus: 'window', app_id: 'org.gnome.Ptyxis.desktop', app_name: 'Terminal', wm_class: 'org.gnome.Ptyxis', title: 'vim'};
    fake.status.state = 'recording';
    fake.requests = [];
    await rejects('window without --window-activity -> 409 unavailable', client.postWindow(W, null),
        e => e.status === 409 && e.code === 'unavailable' && !e.notRunning);
    const rw = fake.requests[0];
    eq('window request', rw && [rw.method, rw.path, rw.headers['content-type'], JSON.parse(rw.body)],
        ['POST', '/control/v1/window', 'application/json', W]);
    eq('window: bearer, no browser headers', rw && [rw.headers.authorization === `Bearer ${T1}`, noBrowserHeaders(rw)], [true, true]);
    eq('status without window_activity when not offered', 'window_activity' in (await client.status(null)), false);

    fake.windowActivity = true;
    eq('status window_activity when offered', (await client.status(null)).window_activity,
        {available: true, recorded: 0, dropped: 0});
    eq('window -> 202 recorded', await client.postWindow(W, null), {recorded: true});
    eq('same window -> recorded false', await client.postWindow(W, null), {recorded: false});
    eq('focus none -> recorded', await client.postWindow({focus: 'none'}, null), {recorded: true});
    eq('recorded windows', fake.windows, [W, {focus: 'none'}]);

    await client.command('pause', null);
    eq('while paused -> recorded false', await client.postWindow(W, null), {recorded: false});
    await client.command('resume', null);
    eq('resume forgets the last window', await client.postWindow({focus: 'none'}, null), {recorded: true});

    for (const [name, bad] of [
        ['missing keys', {focus: 'window', title: 'x'}],
        ['extra key on none', {focus: 'none', title: ''}],
        ['non-string value', {...W, title: 5}],
        ['unknown focus', {focus: 'bogus'}],
    ])
        await rejects(`window ${name} -> 400 invalid`, client.postWindow(bad, null), e => e.status === 400 && e.code === 'invalid');

    // The server sanitises too; the client-side sanitiser must agree with it.
    eq('server replaces control characters', [await client.postWindow({...W, title: 'a\nb\u0085c'}, null), fake.windows.at(-1)?.title],
        [{recorded: true}, 'a b c']);
    const huge = {focus: 'window', app_id: '€'.repeat(255), app_name: 'é'.repeat(255), wm_class: 'a'.repeat(255), title: '😀'.repeat(1100)};
    await rejects('raw oversized body (> 4 KiB) -> 400', client.postWindow(huge, null), e => e.status === 400 && e.code === 'invalid');
    const clean = sanitizeWindow(huge);
    eq('client-sanitised payload accepted and stored unchanged', [await client.postWindow(clean, null), fake.windows.at(-1)],
        [{recorded: true}, clean]);
    const escapes = sanitizeWindow({focus: 'window', app_id: '\\'.repeat(300), app_name: '"'.repeat(300), wm_class: '\\'.repeat(300), title: '"'.repeat(2000)});
    eq('worst-case JSON escaping still fits 4 KiB', [await client.postWindow(escapes, null), fake.windows.at(-1)],
        [{recorded: true}, escapes]);
    const multi = windowPayload({appId: 'org.gnome.TextEditor.desktop', appName: 'Text Editor', wmClass: 'gnome-text-editor', title: 'Überprüfung — 日本語 😀.txt'});
    eq('multi-byte title round-trips', [await client.postWindow(multi, null), fake.windows.at(-1)], [{recorded: true}, multi]);

    // Safety cap: 60 recorded per rolling 60 s, excess counted as dropped.
    fake.resetWindows();
    const results = [];
    for (let i = 0; i < 61; i++)
        results.push((await client.postWindow({...W, title: `cap ${i}`}, null))?.recorded);
    eq('cap: 60 recorded then dropped', [results.filter(r => r).length, results.at(-1)], [60, false]);
    eq('status counts recorded/dropped', (await client.status(null)).window_activity, {available: true, recorded: 60, dropped: 1});
    fake.status.state = 'paused';

    // --- 403: re-read control file (server restarted with a new token) -----------
    fake.requests = [];
    fake.token = T2;
    fake.onStaleToken = () => {
        writeControlFile(runtimeDir, base, T2);
        fake.onStaleToken = null;
    };
    eq('403 -> re-read and retry', (await client.status(null))?.state, 'paused');
    eq('403 retry sequence', summary(fake.requests), ['GET /control/v1/status T1 ', 'GET /control/v1/status T2 ']);

    // --- 403 with an unchanged file: no retry, no token in the error -------------
    fake.requests = [];
    fake.token = 'someoneElse_cccccccccccccccccccccccccccccccc';
    await rejects('403 unchanged -> forbidden', client.status(null),
        e => e.status === 403 && e.code === 'forbidden' && !e.message.includes(T2) && !e.notRunning);
    eq('403 unchanged: no retry', fake.requests.length, 1);
    fake.token = T2;

    // --- 403 on a window report: same re-read path ---------------------------------
    const T3 = 'tokenTHREE_dddddddddddddddddddddddddddddddddd';
    fake.requests = [];
    fake.token = T3;
    fake.onStaleToken = () => {
        writeControlFile(runtimeDir, base, T3);
        fake.onStaleToken = null;
    };
    eq('window 403 -> re-read and retry', await client.postWindow({focus: 'none'}, null), {recorded: false});
    eq('window 403 retry sequence', fake.requests.map(r => [r.path, r.headers.authorization === `Bearer ${T3}`]),
        [['/control/v1/window', false], ['/control/v1/window', true]]);

    // --- malformed control file -----------------------------------------------------
    const path = GLib.build_filenamev([runtimeDir, 'whatdidido', 'control.json']);
    GLib.file_set_contents(path, JSON.stringify({version: 1, base_url: 'http://example.com:80', token: T2}));
    fake.requests = [];
    await rejects('non-loopback base_url refused', client.status(null),
        e => !e.notRunning && !e.message.includes(T2) && /loopback/.test(e.message));
    eq('nothing sent for a bad control file', fake.requests.length, 0);

    // --- stale control file, server gone: not running -------------------------------
    writeControlFile(runtimeDir, base, T2);
    fake.stop();
    await rejects('connection refused -> not running', client.status(null), e => e.notRunning === true);

    removeControlFile(runtimeDir);
    await rejects('file removed -> not running', client.status(null), e => e.notRunning === true);
    client.destroy();
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    failed++;
    print(`FAIL uncaught: ${e}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
