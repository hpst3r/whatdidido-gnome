// AppClient tests against loopback fakes of the control server's GET /day
// redirect and the app server's timesheet routes (POPOVER.md 7.2).
// Run: gjs -m tests/app_client_test.js [runtime-dir]
// runtime-dir stands in for $XDG_RUNTIME_DIR (default: build/test-runtime/app-client).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {AppClient, AppError} from '../whatdidido@wporter.org/lib/app_client.js';
import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {currentStretch} from '../whatdidido@wporter.org/lib/day_model.js';
import {assignmentBody} from '../whatdidido@wporter.org/lib/popover_model.js';
import {FakeApp, sampleDay} from './fake_app.js';
import {FakeControl, writeControlFile, removeControlFile} from './fake_control.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const runtimeDir = ARGV[0] ?? GLib.build_filenamev([here, '..', 'build', 'test-runtime', 'app-client']);
GLib.mkdir_with_parents(runtimeDir, 0o700);
try {
    removeControlFile(runtimeDir);
} catch {}

const TOKEN = 'tokenAPP_cccccccccccccccccccccccccccccccccccc';
const FORBIDDEN = ['authorization', 'origin', 'cookie'];

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
            print(`FAIL ${name}: wrong error ${e} ${JSON.stringify(e)}`);
        }
    }
}

// Header names that must never reach the app server or the /day probe.
function badHeaders(requests) {
    const bad = [];
    for (const r of requests) {
        for (const h of Object.keys(r.headers)) {
            if (FORBIDDEN.includes(h) || h.startsWith('sec-fetch-'))
                bad.push(`${r.method} ${r.path}: ${h}`);
        }
    }
    return bad;
}

const probes = ctl => ctl.requests.filter(r => r.path === '/day');

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function settingsOf(values) {
    return {get: key => values[key] ?? ''};
}

async function main() {
    const ctl = new FakeControl({token: TOKEN});
    const ctlBase = ctl.listen();
    writeControlFile(runtimeDir, ctlBase, TOKEN);
    const app = new FakeApp();
    const appBase = app.listen();
    const control = new ControlClient({runtimeDir});
    const values = {'app-url': ''};
    let client = new AppClient({control, settings: settingsOf(values)});

    // --- discovery: absolute loopback Location -------------------------------------
    ctl.dayRedirect = {status: 307, location: `${appBase}/app/#/today`};
    eq('url before discovery', client.url('today'), null);
    eq('absolute loopback Location -> its origin', await client.base(null), appBase);
    eq('one probe', probes(ctl).length, 1);
    const probe = probes(ctl)[0];
    eq('probe is a GET without query', [probe.method, probe.query], ['GET', null]);
    eq('probe sends no control token or browser headers', badHeaders([probe]), []);
    eq('nothing followed the redirect to the app server', app.requests.length, 0);
    const day = await client.day('2026-10-15', null);
    eq('day fetched', [day?.date, day?.zone, day?.segments.length], ['2026-10-15', 'America/New_York', 5]);
    eq('day request path and query', [app.requests[0].method, app.requests[0].path, app.requests[0].query], ['GET', '/api/v1/timesheet/day', {date: '2026-10-15'}]);
    eq('day request host is the loopback origin', app.requests[0].headers.host, `127.0.0.1:${app.port}`);
    eq('discovery cached', probes(ctl).length, 1);
    eq('url', client.url('timeline', {date: '2026-10-15', t: '10:45'}), `${appBase}/app/#/timeline?date=2026-10-15&t=10%3A45`);
    eq('url today', client.url('today'), `${appBase}/app/#/today`);

    // --- 404: no --timesheet ---------------------------------------------------------
    app.timesheet = false;
    eq('day 404 -> null', await client.day('2026-10-15', null), null);
    app.timesheet = true;

    // --- assign ----------------------------------------------------------------------
    const stretch = currentStretch(day);
    const body = assignmentBody(day, stretch, '#4207');
    app.requests = [];
    const created = await client.assign({...body, extra: 'dropped'}, null);
    const post = app.requests[0];
    eq('assign posted', [post.method, post.path, post.headers['content-type']], ['POST', '/api/v1/timesheet/assignments', 'application/json']);
    eq('assign body keys exactly', Object.keys(JSON.parse(post.body)), ['start', 'end', 'ticket', 'client', 'category', 'note', 'billable']);
    eq('assign body with ticket_defaults', JSON.parse(post.body), {
        start: stretch.start, end: stretch.end, ticket: '#4207', client: 'Contoso', category: 'Internal', note: '', billable: false,
    });
    eq('assign resolves to the assignment', created?.ticket, '#4207');
    const plain = assignmentBody(day, stretch, '#4102');
    await client.assign(plain, null);
    eq('assign defaults when the ticket has none', JSON.parse(app.requests[1].body),
        {start: stretch.start, end: stretch.end, ticket: '#4102', client: '', category: '', note: '', billable: true});

    app.assignStatus = 409;
    app.assignError = 'conflict';
    await rejects('409 conflict (v1 envelope) -> AppError code', client.assign(body, null),
        e => e instanceof AppError && e.code === 'conflict' && e.status === 409 && !e.unreachable);
    app.flatErrors = true;
    await rejects('409 conflict (flat) -> AppError code', client.assign(body, null), e => e.code === 'conflict' && e.status === 409);
    app.flatErrors = false;
    app.assignStatus = 400;
    app.assignError = 'invalid';
    await rejects('other failure -> its code', client.assign(body, null), e => e.code === 'invalid' && e.status === 400);
    app.assignStatus = 201;

    const first = client.assign(body, null);
    await rejects('one assign at a time', client.assign(body, null), e => e.code === 'busy');
    eq('the first still succeeds', (await first)?.ticket, '#4207');
    eq('the refused call sent nothing', app.requests.filter(r => r.method === 'POST').length, 1 + 1 + 3 + 1);

    eq('no forbidden headers on any app request', badHeaders(app.requests), []);
    eq('no forbidden headers on any probe', badHeaders(probes(ctl)), []);

    // --- connection refused -> re-discovery on the next call ---------------------
    app.stop();
    await rejects('nothing listening -> unreachable', client.day('2026-10-15', null),
        e => e instanceof AppError && e.unreachable === true && e.status === 0);
    const app2 = new FakeApp();
    const app2Base = app2.listen();
    ctl.dayRedirect = {status: 307, location: `${app2Base}/app/`};
    const before = probes(ctl).length;
    eq('next call discovers again', (await client.day('2026-10-15', null))?.date, '2026-10-15');
    eq('one more probe', probes(ctl).length, before + 1);
    eq('the new app server answered', app2.requests.length, 1);
    await client.day('2026-10-15', null);
    eq('then cached again', probes(ctl).length, before + 1);

    // --- session not running: the last discovered origin is still used ----------
    removeControlFile(runtimeDir);
    eq('no control file -> last origin', await client.base(null), app2Base);
    eq('day still read from it', (await client.day('2026-10-16', null))?.date, '2026-10-16');
    eq('url still works', client.url('today'), `${app2Base}/app/#/today`);

    // --- base_url change -> discovered again ---------------------------------------
    const ctl2 = new FakeControl({token: TOKEN});
    const ctl2Base = ctl2.listen();
    writeControlFile(runtimeDir, ctl2Base, TOKEN);
    ctl2.dayRedirect = {status: 302, location: '/app/#/today'};
    eq('relative /app/ -> the control origin', await client.base(null), ctl2Base);
    eq('probed the new control server', probes(ctl2).length, 1);
    eq('no forbidden headers on the new probe', badHeaders(probes(ctl2)), []);

    // --- discovery cases, each with a fresh client ---------------------------------
    const fresh = async (redirect, name) => {
        client.destroy();
        client = new AppClient({control, settings: settingsOf(values)});
        ctl2.dayRedirect = redirect;
        ctl2.requests = [];
        app2.requests = [];
        const base = await client.base(null);
        eq(`${name}: probed once`, probes(ctl2).length, 1);
        return base;
    };
    eq('303 absolute', await fresh({status: 303, location: `${app2Base}/app/`}, '303'), app2Base);
    eq('non-loopback Location refused', await fresh({status: 307, location: 'http://example.com:18851/app/'}, 'non-loopback'), null);
    eq('https Location refused', await fresh({status: 307, location: `https://127.0.0.1:${app2.port}/app/`}, 'https'), null);
    eq('relative non-/app/ Location refused', await fresh({status: 307, location: '/session'}, 'relative'), null);
    eq('404 -> no app server', await fresh({status: 404, location: null}, '404'), null);
    eq('no Location -> no app server', await fresh({status: 307, location: null}, 'no Location'), null);
    eq('200 -> no app server', await fresh({status: 200, location: `${app2Base}/app/`}, '200'), null);
    eq('no app server: day is null', await client.day('2026-10-15', null), null);
    eq('no app server: nothing sent to the app', app2.requests.length, 0);
    eq('no app server: url null', client.url('today'), null);
    await rejects('no app server: assign refused', client.assign(plain, null), e => e.code === 'no_app_server');
    eq('a refusal is cached until base_url changes', [await client.base(null), probes(ctl2).length], [null, 1]);
    // Without NO_REDIRECT Soup would follow this one to the app server.
    eq('a redirect is never followed', [await fresh({status: 307, location: `${app2Base}/app/`}, 'not followed'), app2.requests.length], [app2Base, 0]);
    // A /day without a configured redirect: the fake answers 403 (no token).
    eq('403 -> no app server', await fresh(null, '403'), null);

    // --- override ------------------------------------------------------------------
    ctl2.requests = [];
    ctl2.dayRedirect = {status: 307, location: `${app2Base}/app/`};
    values['app-url'] = `http://127.0.0.1:${app.port}/`;
    client.destroy();
    client = new AppClient({control, settings: settingsOf(values)});
    eq('valid override, trailing slash', [await client.base(null), client.invalidSetting], [appBase, false]);
    eq('override: no probe', probes(ctl2).length, 0);
    eq('override: url', client.url('today'), `${appBase}/app/#/today`);
    values['app-url'] = app2Base;
    eq('override read live', (await client.day('2026-10-15', null))?.date, '2026-10-15');
    eq('override: day from it', app2.requests.length, 1);
    for (const bad of ['http://example.com:18851', 'https://127.0.0.1:18851', 'http://127.0.0.1:18851/app/', 'http://u@127.0.0.1:18851', 'localhost:18851']) {
        values['app-url'] = bad;
        eq(`invalid override ${bad}`, [await client.base(null), client.invalidSetting, client.url('today'), await client.day('2026-10-15', null)],
            [null, true, null, null]);
    }
    eq('invalid override: no probe', probes(ctl2).length, 0);
    eq('invalid override: nothing sent', app2.requests.length, 1);
    values['app-url'] = '';
    eq('back to automatic', await client.base(null), app2Base);
    eq('no forbidden headers anywhere', [...badHeaders(app2.requests), ...badHeaders(probes(ctl2))], []);

    // --- malformed answers ------------------------------------------------------------
    await rejects('bad date refused locally', client.day('15.10.2026', null), e => e.code === 'invalid');
    app2.day = {date: 'x'};
    await rejects('a malformed day is refused', client.day('2026-10-15', null), e => e.code === 'invalid');

    // --- destroy aborts --------------------------------------------------------------
    app2.day = sampleDay();
    app2.hold = true;
    const sent = app2.requests.length;
    const pending = client.day('2026-10-15', null);
    while (app2.requests.length === sent)
        await sleep(20);
    client.destroy();
    // Cancelled at once, not the session's 10 s timeout.
    await rejects('destroy aborts a request in flight', pending, e => e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    control.destroy();
    ctl.stop();
    ctl2.stop();
    app2.stop();
    removeControlFile(runtimeDir);
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
