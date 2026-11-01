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

        // Output monitor (CONTROL_API.md Amendment 5): recording-full is an
        // older server without it; output-on offers it.
        await request('POST', `${admin}/scenario`, {body: {...full, name: 'recording-full'}});
        const oldCtl = JSON.parse(dec.decode(GLib.file_get_contents(ctlPath)[1]));
        const oldAuth = {Authorization: `Bearer ${oldCtl.token}`};
        const oldSt = (await request('GET', `${oldCtl.base_url}/control/v1/status`, {headers: oldAuth})).json;
        check(!('output' in oldSt), 'older server: no output key');
        const oldOuts = await request('GET', `${oldCtl.base_url}/control/v1/outputs`, {headers: oldAuth});
        check(oldOuts.status === 403 && oldOuts.json?.error === 'forbidden', 'older server: /outputs 403 forbidden (real catch-all)');
        const oldOff = await request('POST', `${oldCtl.base_url}/control/v1/output`, {headers: oldAuth, body: {on: false}});
        check(oldOff.status === 403 && oldOff.json?.error === 'forbidden', 'older server: POST /output 403 forbidden');
        const nonesuch = await request('GET', `${oldCtl.base_url}/control/v1/nonesuch`, {headers: oldAuth});
        check(nonesuch.status === 403 && nonesuch.json?.error === 'forbidden', 'unknown /control/ route: 403 forbidden');
        await request('POST', `${admin}/scenario`, {body: {...full, name: 'recording-full', output_routes: true}});
        const ungCtl = JSON.parse(dec.decode(GLib.file_get_contents(ctlPath)[1]));
        const ungAuth = {Authorization: `Bearer ${ungCtl.token}`};
        check(!('output' in (await request('GET', `${ungCtl.base_url}/control/v1/status`, {headers: ungAuth})).json), 'ungated: no output key');
        const ungOuts = await request('GET', `${ungCtl.base_url}/control/v1/outputs`, {headers: ungAuth});
        check(ungOuts.status === 409 && ungOuts.json?.error === 'unavailable', 'ungated: /outputs 409 unavailable');
        const ungOff = await request('POST', `${ungCtl.base_url}/control/v1/output`, {headers: ungAuth, body: {on: false}});
        check(ungOff.status === 409 && ungOff.json?.error === 'unavailable', 'ungated: POST /output 409 unavailable');
        const outOn = scenario('output-on');
        const outBase = scenario(outOn.extends);
        await request('POST', `${admin}/scenario`, {body: {...outBase, ...outOn, control: {status: {...outBase.control.status, ...outOn.control.status}}, name: 'output-on'}});
        const oc = JSON.parse(dec.decode(GLib.file_get_contents(ctlPath)[1]));
        const oa = {Authorization: `Bearer ${oc.token}`};
        const os = (await request('GET', `${oc.base_url}/control/v1/status`, {headers: oa})).json;
        check(os.output?.available === true && os.output.on === true, 'output-on: status output on');
        const outs = await request('GET', `${oc.base_url}/control/v1/outputs`, {headers: oa});
        check(outs.status === 200 && outs.json.inventory === 'inv1' && outs.json.outputs.length === 2, 'outputs served');
        check(JSON.stringify(Object.keys(outs.json.outputs[0])) === '["id","label","stable_id"]', 'outputs items: id, label, stable_id');
        const noConsent = await request('POST', `${oc.base_url}/control/v1/output`,
            {headers: oa, body: {on: true, source_id: outs.json.outputs[0].id, inventory: 'inv1'}});
        check(noConsent.status === 400, 'output on without consent -> 400');
        const falseConsent = await request('POST', `${oc.base_url}/control/v1/output`,
            {headers: oa, body: {on: true, source_id: outs.json.outputs[0].id, inventory: 'inv1', consent: false}});
        check(falseConsent.status === 400, 'output on with consent false -> 400');
        const offConsent = await request('POST', `${oc.base_url}/control/v1/output`, {headers: oa, body: {on: false, consent: true}});
        check(offConsent.status === 400, 'output off with a consent key -> 400');
        const outOff = await request('POST', `${oc.base_url}/control/v1/output`, {headers: oa, body: {on: false}});
        check(outOff.status === 200 && outOff.json.output.on === false && outOff.json.output.state === 'off', 'output off -> 200');
        const outOn2 = await request('POST', `${oc.base_url}/control/v1/output`,
            {headers: oa, body: {on: true, source_id: outs.json.outputs[0].id, inventory: 'inv1', consent: true}});
        check(outOn2.status === 200 && outOn2.json.output.source_id === outs.json.outputs[0].id &&
            outOn2.json.output.state === 'capturing', 'output on with consent -> 200 capturing');
        const unknown = await request('POST', `${oc.base_url}/control/v1/output`,
            {headers: oa, body: {on: true, source_id: 'nope', inventory: 'inv1', consent: true}});
        check(unknown.status === 400, 'unknown output -> 400');
        const stale = await request('POST', `${oc.base_url}/control/v1/output`,
            {headers: oa, body: {on: true, source_id: outs.json.outputs[0].id, inventory: 'inv0', consent: true}});
        check(stale.status === 409 && stale.json.error === 'inventory_changed', 'stale inventory -> 409');

        // output.available false (an unreadable inventory): no list, no on, off works.
        await request('POST', `${admin}/scenario`, {body: {...outBase, ...outOn, name: 'output-unavailable', control: {status: {
            ...outBase.control.status, output: {...outOn.control.status.output, available: false}}}}});
        const uc = JSON.parse(dec.decode(GLib.file_get_contents(ctlPath)[1]));
        const ua = {Authorization: `Bearer ${uc.token}`};
        const uOuts = await request('GET', `${uc.base_url}/control/v1/outputs`, {headers: ua});
        check(uOuts.status === 409 && uOuts.json?.error === 'unavailable', 'available false: /outputs 409 unavailable');
        const uOn = await request('POST', `${uc.base_url}/control/v1/output`,
            {headers: ua, body: {on: true, source_id: outs.json.outputs[0].id, inventory: 'inv1', consent: true}});
        check(uOn.status === 409 && uOn.json?.error === 'unavailable', 'available false: on -> 409 unavailable');
        const uOff = await request('POST', `${uc.base_url}/control/v1/output`, {headers: ua, body: {on: false}});
        check(uOff.status === 200 && uOff.json.output.on === false && uOff.json.output.available === false,
            'available false: off -> 200, still unavailable');

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
