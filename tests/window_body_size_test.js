// POST /control/v1/window body size (TIME_ACCOUNTING.md Amendment 2 item 1).
// A window that fits the 3500-byte metadata budget can exceed 4 KiB once JSON
// escapes '"' and '\', so the server accepts window bodies up to 8192 bytes.
// Checks that such a window is accepted and recorded by the loopback fake,
// and that no sanitised payload can produce a body over 8192 bytes.
// Run: gjs -m tests/window_body_size_test.js [runtime-dir]
import GLib from 'gi://GLib';
import System from 'system';

import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {METADATA_MAX_BYTES, metadataBytes, sanitizeWindow, windowPayload} from '../whatdidido@wporter.org/lib/window_model.js';
import {FakeControl, writeControlFile, removeControlFile} from './fake_control.js';

const WINDOW_BODY_MAX_BYTES = 8192;

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const runtimeDir = ARGV[0] ?? GLib.build_filenamev([here, '..', 'build', 'test-runtime-body-size']);
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
const bodyBytes = p => new TextEncoder().encode(JSON.stringify(p)).length;

// The bound: after sanitising there are no control characters (-> space) and
// no lone surrogates (-> U+FFFD), so JSON.stringify escapes only '"' and '\',
// each one byte that becomes two; every other character is copied verbatim.
// Hence body <= skeleton + 2 * (value bytes) with value bytes <= 3500 minus
// the key bytes and "window". The worst case is every value byte a '"' or
// '\' (not even reachable: the 255/1024-character clamps come first).
const skeleton = bodyBytes({focus: 'window', app_id: '', app_name: '', wm_class: '', title: ''});
const fixedBytes = metadataBytes({focus: 'window', app_id: '', app_name: '', wm_class: '', title: ''});
const maxBody = skeleton + 2 * (METADATA_MAX_BYTES - fixedBytes);

async function main() {
    // --- the arithmetic worst case ------------------------------------------------
    const valueBytes = METADATA_MAX_BYTES - fixedBytes;
    const worst = {focus: 'window', app_id: '"'.repeat(255), app_name: '\\'.repeat(255), wm_class: '"'.repeat(255),
        title: '\\'.repeat(valueBytes - 765)};
    check('worst case: 3500 metadata bytes, every value byte escaped', metadataBytes(worst) === METADATA_MAX_BYTES,
        `metadata=${metadataBytes(worst)}`);
    check('worst case body equals the bound and fits 8192', bodyBytes(worst) === maxBody && maxBody <= WINDOW_BODY_MAX_BYTES,
        `body=${bodyBytes(worst)} bound=${maxBody}`);

    // --- every sanitised payload stays within the bound (bounded fuzz) ------------
    const alphabet = ['"', '\\', 'a', 'é', '€', '😀', '\n', '\u0085', '\ud800', '\udfff', ' ', '\u007f', ' '];
    let seed = 0x5eed;
    const rand = n => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
    };
    const str = max => {
        let s = '';
        for (let i = rand(max + 1); i > 0; i--)
            s += alphabet[rand(alphabet.length)];
        return s;
    };
    let worstSeen = 0, bad = null;
    for (let i = 0; i < 400 && !bad; i++) {
        const raw = {focus: 'window', app_id: str(400), app_name: str(400), wm_class: str(400), title: str(1500)};
        if (i % 4 === 0)    // escape-heavy
            raw.title = '"\\'.repeat(rand(1200));
        const p = sanitizeWindow(raw);
        const b = bodyBytes(p);
        worstSeen = Math.max(worstSeen, b);
        if (metadataBytes(p) > METADATA_MAX_BYTES || b > skeleton + 2 * (metadataBytes(p) - fixedBytes) || b > maxBody)
            bad = {b, meta: metadataBytes(p)};
    }
    check('fuzz: sanitised metadata <= 3500 and body within the escape bound', bad === null,
        `${JSON.stringify(bad)} (worst seen ${worstSeen})`);

    // --- a hostile window whose body is over 4 KiB is accepted and recorded -------
    // An app-less X11 window: Shell's app name is the WM_CLASS, which the
    // client controls. 255 quotes each, title of backslashes + emoji.
    const hostile = windowPayload({appId: 'window:42', appName: '"'.repeat(255), wmClass: '"'.repeat(255),
        title: '\\'.repeat(382) + '😀'.repeat(700)});
    const hostileBody = bodyBytes(hostile);
    check('hostile body is over 4096 and within 8192', hostileBody > 4096 && hostileBody <= WINDOW_BODY_MAX_BYTES,
        `body=${hostileBody}`);

    try {
        removeControlFile(runtimeDir);
    } catch {}
    const token = 'tokenBODY_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const fake = new FakeControl({token});
    fake.windowActivity = true;
    writeControlFile(runtimeDir, fake.listen(), token);
    const client = new ControlClient({runtimeDir});
    const post = p => client.postWindow(p, null).catch(e => ({error: `${e.status} ${e.code}`}));
    try {
        const got = await post(hostile);
        check('hostile window accepted and recorded unchanged',
            got.recorded === true && JSON.stringify(fake.windows.at(-1)) === JSON.stringify(hostile),
            `reply=${JSON.stringify(got)} stored=${JSON.stringify(fake.windows.at(-1))?.slice(0, 80)}`);
        const r = await post(worst);
        check('worst-case body accepted by the 8 KiB limit', r.recorded === true, JSON.stringify(r));
        let err = null;
        try {
            await client.postWindow({...worst, title: '"'.repeat(WINDOW_BODY_MAX_BYTES)}, null);
        } catch (e) {
            err = e;
        }
        check('a body over 8192 bytes is refused (400 invalid)', err?.status === 400 && err?.code === 'invalid',
            JSON.stringify({status: err?.status, code: err?.code}));
    } finally {
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
