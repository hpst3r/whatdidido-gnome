// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Self-test of tests/shots/fakes.js (no shell needed):
//
//   gjs -m tests/shots/fakes_test.js <scratch-dir>
//
// Starts the fakes with <scratch-dir> as the runtime dir, loads scenarios and
// checks control.json, the control rules, the /day redirect, the rebased
// timesheet day, 404 without a timesheet and Assign.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const [scratch] = ARGV;
if (!scratch) {
    printerr('usage: fakes_test.js <scratch-dir>');
    imports.system.exit(2);
}
const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const enc = new TextEncoder();
const dec = new TextDecoder();
let failures = 0;

function check(cond, what) {
    print(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
    if (!cond)
        failures++;
}

function scenario(name) {
    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([HERE, 'scenarios', `${name}.json`]));
    return JSON.parse(dec.decode(bytes));
}

function mode(path) {
    return Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        .get_attribute_uint32('unix::mode') & 0o777;
}

const session = new Soup.Session({timeout: 5});

async function request(method, url, {body, headers = {}} = {}) {
    const msg = Soup.Message.new(method, url);
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.append(k, v);
    if (body !== undefined)
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(enc.encode(JSON.stringify(body))));
    // Redirects are the subject of a check, not followed.
    msg.add_flags(Soup.MessageFlags.NO_REDIRECT);
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const text = dec.decode(bytes.get_data() ?? new Uint8Array());
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {}
    return {status: msg.get_status(), json, location: msg.get_response_headers().get_one('Location')};
}

function sleep(ms) {
    return new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));
}

async function main() {
    const runtime = GLib.build_filenamev([scratch, 'runtime']);
    const portsFile = GLib.build_filenamev([scratch, 'ports.json']);
    GLib.mkdir_with_parents(runtime, 0o700);
    GLib.unlink(portsFile);
    const proc = Gio.Subprocess.new(['gjs', '-m', GLib.build_filenamev([HERE, 'fakes.js']), runtime, portsFile],
        Gio.SubprocessFlags.NONE);
    try {
        for (let i = 0; i < 50 && !GLib.file_test(portsFile, GLib.FileTest.EXISTS); i++)
            await sleep(100);
        const ports = JSON.parse(dec.decode(GLib.file_get_contents(portsFile)[1]));
        const admin = `http://127.0.0.1:${ports.admin}`;
        const app = `http://127.0.0.1:${ports.app}`;
        const ctlPath = GLib.build_filenamev([runtime, 'whatdidido', 'control.json']);

        // recording-full (the driver resolves `extends`; this one has none).
        const full = scenario('recording-full');
        await request('POST', `${admin}/scenario`, {body: {...full, name: 'recording-full'}});
        const ctl = JSON.parse(dec.decode(GLib.file_get_contents(ctlPath)[1]));
        check(ctl.version === 1 && /^http:\/\/127\.0\.0\.1:\d+$/.test(ctl.base_url) && /^[A-Za-z0-9_-]{43}$/.test(ctl.token),
            'control.json: version 1, loopback base_url, 43-char token');
        check(mode(ctlPath) === 0o600 && mode(GLib.path_get_dirname(ctlPath)) === 0o700, 'control.json 0600 in a 0700 dir');
        const auth = {Authorization: `Bearer ${ctl.token}`};
        check((await request('GET', `${ctl.base_url}/control/v1/status`)).status === 403, 'status without token: 403');
        const st = await request('GET', `${ctl.base_url}/control/v1/status`, {headers: auth});
        check(st.status === 200 && st.json.state === 'recording' && st.json.describe_withheld === 3, 'status served');
        check((await request('GET', `${ctl.base_url}/control/v1/status?x=1`, {headers: auth})).status === 403, 'query string: 403');
        const mics = await request('GET', `${ctl.base_url}/control/v1/microphones`, {headers: auth});
        check(mics.json.microphones.length === 2 && mics.json.inventory === 'inv1', 'microphones served');
        const pause = await request('POST', `${ctl.base_url}/control/v1/command`, {headers: auth, body: {action: 'pause'}});
        check(pause.status === 202 && pause.json.state === 'paused', 'pause -> 202 paused');
        const again = await request('POST', `${ctl.base_url}/control/v1/command`, {headers: auth, body: {action: 'pause'}});
        check(again.status === 409 && again.json.error === 'not_allowed', 'pause while paused -> 409');
        const iv = await request('POST', `${ctl.base_url}/control/v1/interval`, {headers: auth, body: {seconds: 60}});
        check(iv.status === 200 && iv.json.interval_seconds === 60, 'interval -> 200');
        const off = await request('POST', `${ctl.base_url}/control/v1/mic`, {headers: auth, body: {on: false}});
        check(off.status === 200 && off.json.mic.on === false, 'mic off -> 200');
        const day = await request('GET', `${ctl.base_url}/day`);
        check(day.status === 307 && day.location === `${app}/app/#/today`, '/day -> 307 to the app');

        const d = (await request('GET', `${app}/api/v1/timesheet/day?date=2031-03-09`)).json;
        const tz = GLib.TimeZone.new_local();
        const local = iso => GLib.DateTime.new_from_unix_utc(Date.parse(iso) / 1000).to_timezone(tz).format('%Y-%m-%d %H:%M');
        check(d.date === '2031-03-09' && d.zone === tz.get_identifier(), 'day rebased onto the requested date, local zone');
        check(local(d.now) === '2031-03-09 17:42' && local(d.span.start) === '2031-03-09 08:00', 'now 17:42, span from 08:00 local');
        const last = d.unassigned[d.unassigned.length - 1];
        check(last.state === 'active' && local(last.start) === '2031-03-09 17:00' && last.end === d.now,
            'unassigned stretch 17:00 -> now');
        check(d.entries.length === 4 && d.suggestions.tickets.join(' ') === '#4101 #4102 #4107', '4 entries, 3 suggested tickets');
        check(d.segments[d.segments.length - 1].window.app_name === 'Service Desk', 'last focus: Service Desk');
        check(d.unassigned.some(r => r.state === 'paused') && d.unassigned.some(r => r.state === 'idle'), 'paused and idle stretches');

        const body = {start: last.start, end: last.end, ticket: '#4101', client: 'Contoso', category: 'Network', note: '', billable: true};
        const bad = await request('POST', `${app}/api/v1/timesheet/assignments`, {body: {...body, extra: 1}});
        check(bad.status === 422, 'assign with an extra key -> 422');
        const ok = await request('POST', `${app}/api/v1/timesheet/assignments`, {body});
        check(ok.status === 201 && ok.json.ticket === '#4101', 'assign -> 201');
        const d2 = (await request('GET', `${app}/api/v1/timesheet/day?date=2031-03-09`)).json;
        check(d2.entries.length === 5 && !d2.unassigned.some(r => r.start === last.start), 'the stretch became an entry');
        const st2 = (await request('GET', `${admin}/state`)).json;
        check(st2.assignments.length === 1 && st2.assignments[0].ticket === '#4101', 'admin records the assignment');

        const shorter = {...full.app, now: '17:00', segments: full.app.segments.slice(0, -1)};
        const swapped = await request('POST', `${admin}/app`, {body: shorter});
        const d3 = (await request('GET', `${app}/api/v1/timesheet/day?date=2031-03-09`)).json;
        const st3 = (await request('GET', `${admin}/state`)).json;
        check(swapped.status === 200 && local(d3.now) === '2031-03-09 17:00' && st3.status.interval_seconds === 60 &&
            st3.assignments.length === 1, 'admin /app swaps only the day fixture');

        await request('POST', `${admin}/scenario`, {body: {...full, app: {timesheet: false}}});
        check((await request('GET', `${app}/api/v1/timesheet/day?date=2031-03-09`)).status === 404, 'no timesheet -> 404');

        await request('POST', `${admin}/scenario`, {body: scenario('not-running')});
        check(!GLib.file_test(ctlPath, GLib.FileTest.EXISTS), 'not running: no control.json');

        await request('POST', `${admin}/quit`, {body: {}});
        await proc.wait_async(null);
    } finally {
        proc.force_exit();
    }
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    printerr(`${e.message}\n${e.stack}`);
    failures++;
}).finally(() => loop.quit());
loop.run();
print(failures ? `${failures} failed` : 'all passed');
imports.system.exit(failures ? 1 : 0);
