// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Screenshot driver, run by scripts/shots.sh inside the isolated session
// (private session bus, private XDG dirs). It talks to the helper extension
// (org.wporter.WdiShots) and to the fakes' admin server, and for every
// scenario and variant writes <out>/<scenario>-<variant>.png.
//
//   gjs -m tests/shots/driver.js <ports-file> <out-dir> [scenario...]
//
// Environment: SHOTS_VARIANTS (default "dark light"), SHOTS_ANIMATIONS=1
// (keep animations), SHOTS_SHELL_PID (hang watchdog), SHOTS_RUN (run dir),
// SHOTS_SCALE (the monitor scale scripts/shots.sh set up; checked here).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const TARGET = 'whatdidido@wporter.org';
const BUS_NAME = 'org.wporter.WdiShots';
const OBJECT_PATH = '/org/wporter/WdiShots';
const IFACE = 'org.wporter.WdiShots';
// Logical pixels; times ctx.scale (stage pixels per logical pixel).
const MARGIN = 16;
const CALL_TIMEOUT_MS = 15000;
const ACTIVE = 1, INACTIVE = 2;  // ExtensionState
// The parked pointer: away from the panel (no hover, no menu switch) and
// from the hot corner.
const PARK = [640, 780];
// The user session mode is 'prefer-dark' on GNOME 50 (main.js
// getStyleVariant): only 'prefer-light' gives the light shell style, so
// 'default' would shoot the dark style twice.
const VARIANTS = {dark: 'prefer-dark', light: 'prefer-light'};
// X keysyms for `key` steps by name; any other key by number.
const KEYVALS = {Escape: 0xff1b, Return: 0xff0d, Tab: 0xff09, space: 0x20,
    Up: 0xff52, Down: 0xff54, Left: 0xff51, Right: 0xff53};

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const SCENARIO_DIR = GLib.build_filenamev([HERE, 'scenarios']);
const enc = new TextEncoder();
const dec = new TextDecoder();

class Failure extends Error {}
class Skip extends Error {}
class Hung extends Error {}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

function readJson(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return JSON.parse(dec.decode(bytes));
}

// ---- scenarios

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
    const out = {...base};
    for (const [k, v] of Object.entries(over))
        out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
    return out;
}

// `extends` inherits everything but description, tags, steps and expectations.
const OWN_KEYS = ['description', 'tags', 'steps', 'expect_labels', 'expect_requests', 'expect_status', 'paused_minutes'];

function loadScenario(name, seen = []) {
    if (seen.includes(name))
        throw new Error(`scenario ${name}: extends loop`);
    const raw = readJson(GLib.build_filenamev([SCENARIO_DIR, `${name}.json`]));
    if (!raw.extends)
        return {steps: [], tags: [], settings: {}, ...raw, name};
    const base = loadScenario(raw.extends, [...seen, name]);
    for (const k of OWN_KEYS)
        delete base[k];
    const {extends: _, ...own} = raw;
    return {steps: [], tags: [], ...merge(base, own), name};
}

function allScenarios() {
    const names = [];
    const dir = Gio.File.new_for_path(SCENARIO_DIR);
    const it = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = it.next_file(null));) {
        const n = info.get_name();
        if (n.endsWith('.json'))
            names.push(n.slice(0, -5));
    }
    return names.sort();
}

// JSON setting value -> GVariant text (the helper parses it with the key's type).
function variantText(v) {
    if (typeof v === 'string')
        return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (Array.isArray(v))
        return `[${v.map(variantText).join(', ')}]`;
    if (typeof v === 'boolean' || typeof v === 'number')
        return String(v);
    throw new Error(`unsupported setting value ${JSON.stringify(v)}`);
}

// ---- helper extension over D-Bus

class Shell {
    constructor() {
        this._conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    }

    async call(method, sig = null, args = [], timeout = CALL_TIMEOUT_MS) {
        const params = sig ? new GLib.Variant(sig, args) : null;
        let res;
        try {
            res = await this._conn.call(BUS_NAME, OBJECT_PATH, IFACE, method, params, null,
                Gio.DBusCallFlags.NONE, timeout, null);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
                throw new Hung(`${method}: no answer within ${timeout} ms`);
            // Errors raised by the helper itself are scenario failures.
            if (Gio.DBusError.get_remote_error(e) === 'org.wporter.WdiShots.Error') {
                Gio.DBusError.strip_remote_error(e);  // in place
                throw new Failure(`${method}: ${e.message}`);
            }
            throw e;
        }
        const values = res ? res.deepUnpack() : [];
        return values.length ? values[0] : null;
    }

    async json(method, sig = null, args = [], timeout) {
        return JSON.parse(await this.call(method, sig, args, timeout));
    }
}

// ---- fakes admin

class Admin {
    constructor(port) {
        this._base = `http://127.0.0.1:${port}`;
        this._session = new Soup.Session({timeout: 10});
    }

    async _send(method, path, body) {
        const msg = Soup.Message.new(method, this._base + path);
        if (body !== undefined)
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(enc.encode(JSON.stringify(body))));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        if (msg.get_status() !== 200)
            throw new Error(`fakes ${path}: HTTP ${msg.get_status()}`);
        return JSON.parse(dec.decode(bytes.get_data()));
    }

    load(scenario) {
        return this._send('POST', '/scenario', scenario);
    }

    setApp(fixture) {
        return this._send('POST', '/app', fixture);
    }

    state() {
        return this._send('GET', '/state');
    }

    quit() {
        return this._send('POST', '/quit', {});
    }
}

async function waitFor(desc, timeoutMs, pred, intervalMs = 50) {
    const end = nowMs() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const v = await pred();
        if (v)
            return v;
        if (nowMs() > end)
            throw new Failure(`timed out after ${timeoutMs} ms waiting for ${desc}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(intervalMs);
    }
}

// The extension's requests to the fakes have stopped for quietMs (polls on
// menu open, the day fetch, a command and its refresh). Best effort: the
// extension polls every 2 s while the menu is open.
async function fakesQuiet(admin, quietMs = 300, maxMs = 3000) {
    const end = nowMs() + maxMs;
    while (nowMs() < end) {
        // eslint-disable-next-line no-await-in-loop
        const st = await admin.state();
        if (st.quietMs === null || st.quietMs >= quietMs)
            return st;
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
    }
    return admin.state();
}

async function setTargetEnabled(shell, enabled) {
    await shell.call('SetEnabled', '(sb)', [TARGET, enabled]);
    await waitFor(`${TARGET} ${enabled ? 'enabled' : 'disabled'}`, 5000, async () => {
        const st = await shell.json('Status');
        const ext = st.extensions[TARGET];
        if (ext?.error)
            throw new Failure(`${TARGET}: ${ext.error}`);
        return enabled ? ext?.state === ACTIVE && st.indicator : ext?.state === INACTIVE && !st.indicator;
    });
}

function cropRect(mb, scale) {
    const m = mb.monitor;
    const rs = [mb.menu];
    // The panel button above the menu, when the union still fits.
    if (mb.button)
        rs.push(mb.button);
    const margin = MARGIN * scale;
    let x0 = Math.min(...rs.map(r => r.x)) - margin;
    let y0 = Math.min(...rs.map(r => r.y)) - margin;
    let x1 = Math.max(...rs.map(r => r.x + r.width)) + margin;
    let y1 = Math.max(...rs.map(r => r.y + r.height)) + margin;
    x0 = Math.max(m.x, x0);
    y0 = Math.max(m.y, y0);
    x1 = Math.min(m.x + m.width, x1);
    y1 = Math.min(m.y + m.height, y1);
    return {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
}

// Mean luma of the menu's inside (inset so the rounded border and shadow
// stay out), for the light/dark check.
function menuLuma(path, crop, menu, scale) {
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const sx = pb.get_width() / crop.width, sy = pb.get_height() / crop.height;
    const inset = 24 * scale;
    const x0 = Math.max(0, Math.round((menu.x - crop.x + inset) * sx));
    const y0 = Math.max(0, Math.round((menu.y - crop.y + inset) * sy));
    const x1 = Math.min(pb.get_width(), Math.round((menu.x - crop.x + menu.width - inset) * sx));
    const y1 = Math.min(pb.get_height(), Math.round((menu.y - crop.y + menu.height - inset) * sy));
    const px = pb.get_pixels(), stride = pb.get_rowstride(), n = pb.get_n_channels();
    let sum = 0, count = 0;
    for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
            const i = y * stride + x * n;
            sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
            count++;
        }
    }
    return count ? sum / count : null;
}

async function runScenario(ctx, sc, variant) {
    const {shell, admin} = ctx;
    const notes = [];
    const park = ctx.park;
    await shell.call('CloseMenu');
    await shell.call('PointerMove', '(dd)', park);

    // Fresh extension state per shot: fakes first (control.json present or
    // not), then settings reset and set while the extension is disabled.
    await admin.load(sc);
    await setTargetEnabled(shell, false);
    await shell.call('ResetSettings');
    for (const [key, value] of Object.entries(sc.settings ?? {}))
        await shell.call('SetSetting', '(ss)', [key, variantText(value)]);
    await setTargetEnabled(shell, true);

    if (sc.control) {
        await waitFor('the first status poll', 5000, async () =>
            (await admin.state()).requests.some(r => r.path === '/control/v1/status'));
    }
    await fakesQuiet(admin);
    if (sc.paused_minutes) {
        const ok = await shell.call('BackdatePause', '(u)', [sc.paused_minutes * 60000]);
        if (!ok)
            notes.push('BackdatePause: no pause start found in the extension (paused-for text may be missing)');
    }

    await shell.call('OpenMenu', '(s)', [TARGET]);
    if (sc.tags.includes('needs-popover')) {
        const roots = await shell.json('FindActors', '(s)', ['wdi-pop']);
        if (!roots.some(a => a.name === 'wdi-pop'))
            throw new Skip('the installed extension has no wdi-pop actor');
    }
    await fakesQuiet(admin);

    let hovering = false;
    for (const step of sc.steps ?? []) {
        hovering = false;
        if ('click' in step) {
            await shell.call('Click', '(s)', [step.click]);
        } else if ('clickLabel' in step) {
            await shell.call('ClickLabel', '(s)', [step.clickLabel]);
        } else if ('hover' in step) {
            await shell.call('Hover', '(s)', [step.hover]);
            hovering = true;
        } else if ('key' in step) {
            const keyval = typeof step.key === 'number' ? step.key : ctx.keyval(step.key);
            await shell.call('Key', '(u)', [keyval]);
        } else if ('wait_ms' in step) {
            await sleep(step.wait_ms);
        } else if ('focus' in step) {
            await shell.call('Focus', '(s)', [step.focus]);
        } else if ('expect_focus' in step) {
            const f = await shell.json('KeyFocus');
            if (f.name !== step.expect_focus || !f.inMenu)
                throw new Failure(`keyboard focus is on ${f.name || f.describe}${f.inMenu ? '' : ' (outside the menu)'}, expected ${step.expect_focus}`);
            if (!f.focusStyle)
                throw new Failure(`${f.name} has keyboard focus but no :focus style`);
        } else if ('app' in step) {
            // A new day while the menu stays open, fetched at once.
            await admin.setApp(step.app);
            if (!await shell.call('RefreshDay'))
                throw new Failure('RefreshDay: the extension has no day loader');
            await sleep(200);
        } else {
            throw new Failure(`unknown step ${JSON.stringify(step)}`);
        }
        await sleep(100);
        await fakesQuiet(admin);
    }

    // A menu item's activation closes the menu (today's menu): show the
    // result by opening it again.
    let mb = await shell.json('MenuBounds');
    if (!mb.open) {
        notes.push('menu closed by a step; reopened');
        await shell.call('OpenMenu', '(s)', [TARGET]);
        await fakesQuiet(admin);
        mb = await shell.json('MenuBounds');
    }
    if (!hovering)
        await shell.call('PointerMove', '(dd)', park);
    await shell.json('Settle');
    mb = await shell.json('MenuBounds');
    const crop = cropRect(mb, ctx.scale);
    const path = GLib.build_filenamev([ctx.out, `${sc.name}-${variant}.png`]);
    const settle = await shell.json('Screenshot', '(siiii)', [path, crop.x, crop.y, crop.width, crop.height], 30000);
    if (!settle.settled)
        notes.push(`menu still moving after ${settle.ms} ms`);
    // Physical pixels: a scale-2 monitor gives a 2x PNG of the crop.
    const png = GdkPixbuf.Pixbuf.get_file_info(path);
    const want = [Math.round(crop.width * ctx.pixels), Math.round(crop.height * ctx.pixels)];
    if (png[1] !== want[0] || png[2] !== want[1])
        throw new Failure(`PNG is ${png[1]}x${png[2]}, expected ${want[0]}x${want[1]} (crop ${crop.width}x${crop.height})`);

    const labels = await shell.json('MenuLabels');
    for (const want of sc.expect_labels ?? []) {
        if (!labels.includes(want))
            throw new Failure(`label "${want}" not in the menu (labels: ${JSON.stringify(labels)})`);
    }
    const st = await admin.state();
    for (const want of sc.expect_requests ?? []) {
        if (!st.requests.some(r => r.method === want.method && r.path === want.path))
            throw new Failure(`the extension never sent ${want.method} ${want.path}`);
    }
    for (const [k, v] of Object.entries(sc.expect_status ?? {})) {
        if (st.status?.[k] !== v)
            throw new Failure(`fake status ${k} is ${JSON.stringify(st.status?.[k])}, expected ${JSON.stringify(v)}`);
    }
    await shell.call('CloseMenu');
    return {path, crop, menu: mb.menu, notes};
}

async function main() {
    const [portsFile, out, ...wanted] = ARGV;
    const ports = readJson(portsFile);
    const shell = new Shell();
    const admin = new Admin(ports.admin);
    GLib.mkdir_with_parents(out, 0o755);
    const variants = (GLib.getenv('SHOTS_VARIANTS') || 'dark light').split(/\s+/).filter(Boolean);
    for (const v of variants) {
        if (!(v in VARIANTS))
            throw new Error(`unknown variant ${v} (dark, light)`);
    }

    const names = wanted.length ? wanted : allScenarios();
    const scenarios = names.map(n => loadScenario(n));

    const t0 = nowMs();
    const shellPid = GLib.getenv('SHOTS_SHELL_PID');
    await waitFor(`the helper's bus name ${BUS_NAME}`, 60000, async () => {
        if (shellPid && !GLib.file_test(`/proc/${shellPid}`, GLib.FileTest.EXISTS))
            throw new Error('gnome-shell exited during startup (see gnome-shell.log)');
        try {
            return await shell.call('Ping', null, [], 2000) === 'pong';
        } catch {
            return false;
        }
    }, 100);
    await waitFor('the shell to finish starting up', 30000, async () =>
        !(await shell.json('Status')).startingUp, 100);
    await waitFor('the overview to hide', 5000, async () => {
        await shell.call('HideOverview');
        return !(await shell.json('Status')).overviewVisible;
    }, 100);
    const animations = GLib.getenv('SHOTS_ANIMATIONS') === '1';
    await shell.call('SetInterface', '(ss)', ['enable-animations', String(animations)]);
    await shell.call('SetInterface', '(ss)', ['enable-hot-corners', 'false']);
    await shell.call('SetInterface', '(ss)', ['clock-format', "'12h'"]);
    // The monitor scripts/shots.sh asked for must be the one the shell uses.
    // `scale` (St's) is stage pixels per logical pixel: 1 in GNOME 50's
    // logical layout, where the framebuffer scales instead; `pixels` is PNG
    // pixels per stage pixel. Both hold in a physical layout too.
    const {scale, stage, monitorScale} = await shell.json('Status');
    const wantScale = Number(GLib.getenv('SHOTS_SCALE') || 1);
    if (monitorScale !== wantScale || stage.width * monitorScale !== 1280 * wantScale * scale) {
        throw new Error(`SHOTS_SCALE=${wantScale}: got monitor scale ${monitorScale}, St scale ${scale}, ` +
            `stage ${stage.width}x${stage.height}`);
    }
    const pixels = monitorScale / scale;
    const park = PARK.map(v => v * scale);
    // Warm-up: the first virtual pointer events after startup can be lost.
    for (const [x, y] of [[100 * scale, 400 * scale], [640 * scale, 400 * scale], park])
        await shell.call('PointerMove', '(dd)', [x, y]);
    await sleep(200);
    print(`shell ready in ${Math.round(nowMs() - t0)} ms (animations ${animations ? 'on' : 'off'}, ` +
        `monitor scale ${monitorScale}, St scale ${scale}, ` +
        `stage ${stage.width}x${stage.height})`);

    const ctx = {shell, admin, out, scale, pixels, park, keyval: name => {
        if (!(name in KEYVALS))
            throw new Failure(`unknown key ${name} (use a keyval number or one of ${Object.keys(KEYVALS).join(', ')})`);
        return KEYVALS[name];
    }};
    const results = [];
    for (const variant of variants) {
        await shell.call('SetInterface', '(ss)', ['color-scheme', `'${VARIANTS[variant]}'`]);
        await waitFor(`the shell's ${variant} style`, 5000, async () =>
            (await shell.json('Status')).styleVariant === variant);
        await sleep(300);  // the stylesheet reload
        for (const sc of scenarios) {
            const start = nowMs();
            const r = {name: sc.name, variant, status: 'PASS', error: '', notes: []};
            try {
                Object.assign(r, await runScenario(ctx, sc, variant));
            } catch (e) {
                if (e instanceof Hung)
                    throw e;
                r.status = e instanceof Skip ? 'SKIP' : 'FAIL';
                r.error = e instanceof Failure || e instanceof Skip ? e.message : `${e.message}\n${e.stack}`;
                try {
                    await shell.call('CloseMenu');
                } catch {}
            }
            r.ms = Math.round(nowMs() - start);
            results.push(r);
            print(`${r.status.padEnd(4)} ${sc.name}-${variant} ${(r.ms / 1000).toFixed(1)} s` +
                `${r.error ? ` — ${r.error}` : ''}${r.notes?.length ? ` (${r.notes.join('; ')})` : ''}`);
        }
    }

    // Light and dark must really differ (the shell swaps its stylesheet).
    if (variants.includes('dark') && variants.includes('light')) {
        for (const sc of scenarios) {
            const d = results.find(r => r.name === sc.name && r.variant === 'dark');
            const l = results.find(r => r.name === sc.name && r.variant === 'light');
            if (d.status !== 'PASS' || l.status !== 'PASS')
                continue;
            const ld = menuLuma(d.path, d.crop, d.menu, scale), ll = menuLuma(l.path, l.crop, l.menu, scale);
            const line = `luma ${sc.name}: dark ${ld.toFixed(0)} light ${ll.toFixed(0)}`;
            if (!(ll - ld > 40)) {
                for (const r of [d, l]) {
                    r.status = 'FAIL';
                    r.error = `light and dark menus look alike (${line})`;
                }
                print(`FAIL ${line}`);
            } else {
                print(line);
            }
        }
    }

    const summary = results.map(({name, variant, status, error, notes, ms}) => ({name, variant, status, error, notes, ms}));
    GLib.file_set_contents(GLib.build_filenamev([out, 'results.json']), JSON.stringify(summary, null, 2));
    const count = s => results.filter(r => r.status === s).length;
    print(`shots: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped in ${((nowMs() - t0) / 1000).toFixed(1)} s; PNGs in ${out}`);
    return count('FAIL') ? 1 : 0;
}

// A shell that stops answering: SIGABRT makes gnome-shell print its JS
// stack to the log before it exits.
function abortShell() {
    const pid = GLib.getenv('SHOTS_SHELL_PID');
    if (!pid)
        return;
    try {
        Gio.Subprocess.new(['kill', '-ABRT', pid], Gio.SubprocessFlags.NONE).wait(null);
        printerr(`sent SIGABRT to the hung shell ${pid} (JS stack in its log)`);
    } catch (e) {
        printerr(`could not signal the shell: ${e.message}`);
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 1;
main().then(code => {
    exitCode = code;
}).catch(e => {
    if (e instanceof Hung) {
        printerr(`HUNG: ${e.message}`);
        abortShell();
    } else {
        printerr(`driver error: ${e.message}\n${e.stack}`);
    }
    exitCode = 1;
}).finally(() => loop.quit());
loop.run();
imports.system.exit(exitCode);
