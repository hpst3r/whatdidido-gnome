// The at-rest guard's window geometry over the wire (whatdidido
// AT_REST_GUARD.md section 6, CONTROL_API.md Amendment 4), against the
// loopback fake: an old session (no window_activity.geometry) refuses the new
// keys, so the reporter never sends them there; a new one records monitors
// as compact JSON, never stores changed_at, and dedupes on monitors.
// Run: gjs -m tests/window_geometry_client_test.js [runtime-dir]
import GLib from 'gi://GLib';
import System from 'system';

import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {METADATA_MAX_BYTES, metadataBytes, windowPayload, WindowReporter} from '../whatdidido@wporter.org/lib/window_model.js';
import {FakeControl, writeControlFile, removeControlFile} from './fake_control.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const runtimeDir = ARGV[0] ?? GLib.build_filenamev([here, '..', 'build', 'test-runtime-geometry']);
GLib.mkdir_with_parents(runtimeDir, 0o700);

let failed = 0;
function check(name, ok, detail) {
    if (ok) {
        print(`ok   ${name}`);
    } else {
        failed++;
        print(`FAIL ${name}: ${detail}`);
    }
}
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
async function waitFor(cond, ms = 2000) {
    for (let waited = 0; !cond() && waited < ms; waited += 10)
        await sleep(10);
    return cond();
}

const R = (x, y, width, height) => ({x, y, width, height});
const LAYOUT = [R(0, 0, 1920, 1080), R(1920, 0, 1920, 1080)];
const FOCUS = {appId: 'a.desktop', appName: 'A', wmClass: 'a', title: 'one', frame: R(1800, 100, 300, 300), layout: LAYOUT};
const T0 = Date.UTC(2026, 9, 23, 12, 0, 0, 250);
const bodyOf = req => JSON.parse(req.body);
const windowPosts = fake => fake.requests.filter(r => r.method === 'POST' && r.path === '/control/v1/window');

// A real reporter on GLib timers, fed by the client's status.
function reporter(client, focus) {
    return new WindowReporter({
        now: () => GLib.get_monotonic_time() / 1000,
        wallNow: () => T0,
        setTimer: (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.ceil(ms)), () => {
            fn();
            return GLib.SOURCE_REMOVE;
        }),
        clearTimer: id => GLib.source_remove(id),
        readFocus: () => focus.current,
        send: p => client.postWindow(p, null),
        settleMs: 10,
        spacingMs: 0,
    });
}

async function main() {
    try {
        removeControlFile(runtimeDir);
    } catch {}
    const token = 'tokenGEOM_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const fake = new FakeControl({token});
    fake.windowActivity = true;
    writeControlFile(runtimeDir, fake.listen(), token);
    const client = new ControlClient({runtimeDir});
    const focus = {current: FOCUS};
    let r = null;
    try {
        // --- an old session ------------------------------------------------------
        let status = await client.status(null);
        check('old session: no geometry key', !('geometry' in status.window_activity), JSON.stringify(status.window_activity));
        let err = null;
        try {
            await client.postWindow(windowPayload(FOCUS, [], {geometry: true, changedAt: T0}), null);
        } catch (e) {
            err = e;
        }
        check('old session: the new keys are refused (400 invalid), hence the gate',
            err?.status === 400 && err?.code === 'invalid', JSON.stringify({status: err?.status, code: err?.code}));
        r = reporter(client, focus);
        r.updateStatus(status, true);
        await waitFor(() => fake.windows.length === 1);
        const old = windowPosts(fake).at(-1);
        check('old session: the reporter sends the five keys only and is recorded',
            fake.windows.length === 1 && Object.keys(bodyOf(old)).join() === 'focus,app_id,app_name,wm_class,title',
            `${old?.body} windows=${fake.windows.length}`);

        // --- the session starts advertising geometry -----------------------------
        fake.windowGeometry = true;
        status = await client.status(null);
        check('new session: geometry: true, last key of window_activity',
            Object.keys(status.window_activity).at(-1) === 'geometry' && status.window_activity.geometry === true,
            JSON.stringify(status.window_activity));
        r.updateStatus(status, true);
        await waitFor(() => fake.windows.length === 2);
        const sent = bodyOf(windowPosts(fake).at(-1));
        check('new session: monitors and changed_at sent',
            JSON.stringify(sent.monitors) === '[[0,0,1920,1080],[1920,0,1920,1080]]' &&
            sent.changed_at === '2026-10-23T12:00:00.250Z', JSON.stringify(sent));
        check('new session: monitors stored as compact JSON, changed_at not stored',
            JSON.stringify(fake.windows.at(-1)) === JSON.stringify({focus: 'window', app_id: 'a.desktop', app_name: 'A',
                wm_class: 'a', title: 'one', monitors: '[[0,0,1920,1080],[1920,0,1920,1080]]'}),
            JSON.stringify(fake.windows.at(-1)));

        // The session dedupes on monitors but not on changed_at.
        const same = await client.postWindow({...sent, changed_at: '2026-10-23T12:00:09.000Z'}, null);
        check('session dedupe ignores changed_at', same.recorded === false, JSON.stringify(same));
        const moved = await client.postWindow({...sent, monitors: [[0, 0, 1920, 1080]]}, null);
        check('session dedupe includes monitors', moved.recorded === true, JSON.stringify(moved));
        r.destroy();
        r = null;

        // --- the title gives way to the monitors, identically on both sides ------
        fake.resetWindows();
        const long = windowPayload({...FOCUS, appId: '', appName: '€'.repeat(130), wmClass: '', title: '€'.repeat(1024)},
            [], {geometry: true, changedAt: T0});
        const got = await client.postWindow(long, null);
        const stored = fake.windows.at(-1);
        check('long title with monitors: the fake keeps the client\'s sanitised title unchanged',
            got.recorded === true && stored?.title === long.title && long.title.endsWith('…') &&
            metadataBytes(long) <= METADATA_MAX_BYTES, `${long.title.length} vs ${stored?.title?.length}`);

        // --- the body still fits 8 KiB with 16 extreme monitors and changed_at ---
        const extreme = Array.from({length: 16}, (_, i) => R(-2147483647 + i, -2147483647, 2147483647, 2147483647));
        const worst = windowPayload({appId: 'window:1', appName: '"'.repeat(255), wmClass: '\\'.repeat(255),
            title: '"\\'.repeat(600), frame: R(-2147483647, -2147483647, 2147483647, 2147483647), layout: extreme},
        [], {geometry: true, changedAt: T0});
        const bytes = new TextEncoder().encode(JSON.stringify(worst)).length;
        const w = await client.postWindow(worst, null).catch(e => ({error: `${e.status} ${e.code}`}));
        check('worst geometry body: 16 monitors, within 8192 bytes and accepted',
            worst.monitors.length === 16 && bytes <= 8192 && w.recorded === true, `bytes=${bytes} reply=${JSON.stringify(w)}`);
    } finally {
        r?.destroy();
        client.destroy();
        fake.stop();
        removeControlFile(runtimeDir);
    }
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    failed++;
    print(`FAIL uncaught: ${e}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
print(failed ? `${failed} failed` : 'all passed');
System.exit(failed ? 1 : 0);
