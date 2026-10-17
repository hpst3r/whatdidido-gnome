// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loopback fakes for the screenshot harness (scripts/shots.sh): the work
// session's control API (whatdidido docs/CONTROL_API.md) and the app server's
// two timesheet routes (GET /api/v1/timesheet/day, POST
// /api/v1/timesheet/assignments), serving one scenario at a time. A third
// "admin" server is for the driver only: it loads a scenario and reports the
// requests and assignments seen. All three bind 127.0.0.1 on ports the OS
// picks.
//
//   gjs -m tests/shots/fakes.js <runtime-dir> <ports-file>
//
// <runtime-dir> stands in for $XDG_RUNTIME_DIR: control.json is written to
// <runtime-dir>/whatdidido/ (dir 0700, file 0600) while the loaded scenario
// has a control server, and removed when it has none ("not running").
// <ports-file> receives {"admin", "control", "app"} once all three listen.
//
// Day fixtures use local wall-clock times ("17:00") and are rebased onto
// whatever date the extension asks for, in the zone of $TZ (scripts/shots.sh
// pins it), so the shots look the same on any run date.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const [runtimeDir, portsFile] = ARGV;
if (!runtimeDir || !portsFile) {
    printerr('usage: fakes.js <runtime-dir> <ports-file>');
    imports.system.exit(2);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const STATES = ['active', 'idle', 'locked', 'paused', 'recovering', 'untracked'];
const BODY_KEYS = {
    '/control/v1/command': [['action']],
    '/control/v1/mic': [['on'], ['inventory', 'on', 'source_id']],
    '/control/v1/interval': [['seconds']],
    '/control/v1/window': [['focus'], ['app_id', 'app_name', 'focus', 'title', 'wm_class']],
};
const ASSIGN_KEYS = ['billable', 'category', 'client', 'end', 'note', 'start', 'ticket'];
const ALLOWED = {start: ['stopped', 'failed'], pause: ['recording'], resume: ['paused'],
    stop: ['starting', 'recording', 'paused', 'recovering']};
const AFTER = {start: 'recording', pause: 'paused', resume: 'recording', stop: 'stopped'};
const BROWSER_HEADERS = ['origin', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];

const zone = GLib.TimeZone.new_local();
const zoneId = zone.get_identifier();

function token() {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = GLib.random_int_range(0, 256);
    return GLib.base64_encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function iso(ms) {
    return new Date(ms).toISOString();
}

function localDate(ms) {
    return GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000)).to_timezone(zone).format('%Y-%m-%d');
}

// "HH:MM" on date "YYYY-MM-DD" in the local zone -> epoch ms.
function at(date, hhmm) {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    return GLib.DateTime.new(zone, y, mo, d, h, mi, 0).to_unix() * 1000;
}

function stateMs(init = 0) {
    return Object.fromEntries(STATES.map(s => [s, init]));
}

function clone(o) {
    return JSON.parse(JSON.stringify(o));
}

class Fakes {
    constructor() {
        this.scenario = null;
        this.status = null;
        this.token = null;
        this.requests = [];
        this.lastRequestUs = 0;
        this.assignments = [];   // POST bodies, in order
        this.added = [];         // entries created by assignments: {date, start, end, ticket, ...}
        this.windows = 0;
        this.control = this._server((msg, path, query) => this._control(msg, path, query));
        this.app = this._server((msg, path, query) => this._app(msg, path, query));
        this.admin = this._server((msg, path) => this._admin(msg, path));
    }

    _server(handler) {
        const server = new Soup.Server({});
        server.add_handler(null, (_srv, msg, path, query) => {
            try {
                handler(msg, path, query);
            } catch (e) {
                printerr(`fakes: ${path}: ${e.message}\n${e.stack}`);
                this._reply(msg, 500, {error: 'failed'});
            }
        });
        server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
        server.port = server.get_uris()[0].get_port();
        return server;
    }

    _reply(msg, code, obj) {
        msg.set_status(code, null);
        const headers = msg.get_response_headers();
        headers.append('Cache-Control', 'no-store');
        headers.append('X-Content-Type-Options', 'nosniff');
        msg.set_response('application/json', Soup.MemoryUse.COPY, enc.encode(JSON.stringify(obj)));
    }

    _record(msg, server, path, query) {
        const headers = {};
        msg.get_request_headers().foreach((name, value) => {
            headers[name.toLowerCase()] = value;
        });
        const bytes = msg.get_request_body().flatten().get_data();
        const raw = bytes ? dec.decode(bytes) : '';
        const req = {server, method: msg.get_method(), path, query: query ?? null, headers, raw};
        this.requests.push({server, method: req.method, path});
        this.lastRequestUs = GLib.get_monotonic_time();
        return req;
    }

    _body(msg, req) {
        if (req.headers['content-type'] !== 'application/json')
            return null;
        try {
            const body = JSON.parse(req.raw);
            return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
        } catch {
            return null;
        }
    }

    // ---- scenario

    load(scenario) {
        this.scenario = scenario;
        this.status = scenario.control ? clone(scenario.control.status) : null;
        this.requests = [];
        this.assignments = [];
        this.added = [];
        this.windows = 0;
        const dir = GLib.build_filenamev([runtimeDir, 'whatdidido']);
        const path = GLib.build_filenamev([dir, 'control.json']);
        if (this.status) {
            GLib.mkdir_with_parents(dir, 0o700);
            GLib.chmod(dir, 0o700);
            // A new token per load, like a server restart.
            this.token = token();
            const text = JSON.stringify({version: 1, base_url: `http://127.0.0.1:${this.control.port}`, token: this.token});
            GLib.file_set_contents_full(path, text, GLib.FileSetContentsFlags.CONSISTENT, 0o600);
        } else {
            this.token = null;
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                GLib.unlink(path);
        }
    }

    _admin(msg, path) {
        const method = msg.get_method();
        if (method === 'POST' && path === '/scenario') {
            const bytes = msg.get_request_body().flatten().get_data();
            this.load(JSON.parse(dec.decode(bytes)));
            return this._reply(msg, 200, {ok: true});
        }
        if (method === 'GET' && path === '/state') {
            const quietMs = this.lastRequestUs ? Math.round((GLib.get_monotonic_time() - this.lastRequestUs) / 1000) : null;
            return this._reply(msg, 200, {
                requests: this.requests, quietMs, assignments: this.assignments,
                status: this.status, windows: this.windows,
            });
        }
        if (method === 'POST' && path === '/quit') {
            this._reply(msg, 200, {ok: true});
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                loop.quit();
                return GLib.SOURCE_REMOVE;
            });
            return undefined;
        }
        return this._reply(msg, 404, {error: 'not_found'});
    }

    // ---- control API

    _control(msg, path, query) {
        const req = this._record(msg, 'control', path, query);
        if (!this.status)
            return this._reply(msg, 503, {error: 'not_running'});
        // The day view is a page route: no token, redirects to the app.
        if (req.method === 'GET' && path === '/day') {
            msg.set_status(307, null);
            msg.get_response_headers().append('Location', `http://127.0.0.1:${this.app.port}/app/#/today`);
            return undefined;
        }
        if (BROWSER_HEADERS.some(h => h in req.headers) || query)
            return this._reply(msg, 403, {error: 'forbidden'});
        if (req.headers['authorization'] !== `Bearer ${this.token}`)
            return this._reply(msg, 403, {error: 'forbidden'});
        if (req.headers['host'] !== `127.0.0.1:${this.control.port}`)
            return this._reply(msg, 403, {error: 'forbidden'});

        let body = null;
        if (req.method === 'POST') {
            body = this._body(msg, req);
            const limit = path === '/control/v1/window' ? 8192 : 1024;
            const keys = Object.keys(body ?? {}).sort().join(',');
            if (!body || req.raw.length > limit || !(BODY_KEYS[path] ?? []).some(k => k.join(',') === keys))
                return this._reply(msg, 400, {error: 'invalid'});
        }

        const st = this.status;
        switch (`${req.method} ${path}`) {
        case 'GET /control/v1/status':
            return this._reply(msg, 200, st);
        case 'GET /control/v1/microphones':
            if (!st.mic?.available)
                return this._reply(msg, 409, {error: 'unavailable'});
            return this._reply(msg, 200, {inventory: 'inv1', microphones: this.scenario.microphones ?? []});
        case 'POST /control/v1/command': {
            if (!ALLOWED[body.action])
                return this._reply(msg, 400, {error: 'invalid'});
            if (!ALLOWED[body.action].includes(st.state))
                return this._reply(msg, 409, {error: 'not_allowed'});
            st.state = AFTER[body.action];
            st.last_error = null;
            st.waiting_for_unlock = false;
            if (st.mic?.on)
                st.mic.state = st.state === 'recording' ? 'capturing' : 'pending';
            return this._reply(msg, 202, {state: st.state});
        }
        case 'POST /control/v1/mic': {
            if (!st.mic?.available)
                return this._reply(msg, 409, {error: 'unavailable'});
            let mic = null;
            if (body.on) {
                if (body.inventory !== 'inv1')
                    return this._reply(msg, 409, {error: 'inventory_changed'});
                mic = (this.scenario.microphones ?? []).find(m => m.id === body.source_id);
                if (!mic)
                    return this._reply(msg, 400, {error: 'invalid'});
            }
            st.mic = {
                available: true, on: Boolean(mic), source_id: mic?.id ?? null,
                stable_id: mic?.stable_id ?? null, label: mic?.label ?? null,
                state: !mic ? 'off' : st.state === 'recording' ? 'capturing' : 'pending',
                remembered: false,
            };
            if ('audio_state' in st)
                st.audio_state = st.mic.state;
            return this._reply(msg, 200, {mic: st.mic});
        }
        case 'POST /control/v1/interval':
            if (!Number.isInteger(body.seconds) || body.seconds < 5 || body.seconds > 3600)
                return this._reply(msg, 400, {error: 'invalid'});
            st.interval_seconds = body.seconds;
            return this._reply(msg, 200, {interval_seconds: body.seconds});
        case 'POST /control/v1/window':
            if (!st.window_activity)
                return this._reply(msg, 409, {error: 'unavailable'});
            this.windows++;
            st.window_activity.recorded++;
            return this._reply(msg, 202, {recorded: st.state === 'recording'});
        default:
            return this._reply(msg, 404, {error: 'not_found'});
        }
    }

    // ---- app server

    _app(msg, path, query) {
        const req = this._record(msg, 'app', path, query);
        const fixture = this.scenario?.app ?? null;
        if (req.method === 'GET' && path.startsWith('/app')) {
            msg.set_status(200, null);
            msg.set_response('text/html', Soup.MemoryUse.COPY, enc.encode('<!doctype html><title>whatdidido</title>'));
            return undefined;
        }
        // No --timesheet: the timesheet routes do not exist.
        if (!fixture || fixture.timesheet === false)
            return this._reply(msg, 404, {error: {code: 'not_found', message: 'Not found'}});
        if (req.method === 'GET' && path === '/api/v1/timesheet/day') {
            const date = query?.date ?? localDate(Date.now());
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
                return this._reply(msg, 422, {error: {code: 'invalid', message: 'bad date'}});
            return this._reply(msg, 200, this.day(fixture, date));
        }
        if (req.method === 'POST' && path === '/api/v1/timesheet/assignments') {
            const body = this._body(msg, req);
            if (!body || Object.keys(body).sort().join(',') !== ASSIGN_KEYS.join(','))
                return this._reply(msg, 422, {error: {code: 'invalid', message: 'bad body'}});
            this.assignments.push(body);
            const start = Date.parse(body.start), end = Date.parse(body.end);
            const date = localDate(start);
            const added = {date, start, end, ticket: body.ticket, client: body.client,
                category: body.category, note: body.note, billable: body.billable};
            this.added.push(added);
            return this._reply(msg, 201, this._assignment(added, this.added.length + 100));
        }
        return this._reply(msg, 404, {error: {code: 'not_found', message: 'Not found'}});
    }

    _assignment(e, n) {
        const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        return {
            id, start: iso(e.start), end: iso(e.end), ticket: e.ticket, client: e.client ?? '',
            category: e.category ?? '', note: e.note ?? '', billable: e.billable ?? true,
            source: 'manual', revision: 1, created_at: iso(e.start), updated_at: iso(e.end),
        };
    }

    // The fixture as a TimesheetDay on `date` (frontend api/types.ts).
    day(fx, date) {
        const t = s => at(date, s);
        const windows = fx.windows ?? {};
        const now = t(fx.now);
        const segments = (fx.segments ?? []).map(([start, end, state, win]) => ({
            start: t(start), end: Math.min(t(end), now), state, window: win ? windows[win] : null,
        })).filter(s => s.end > s.start);
        const entries = [
            ...(fx.entries ?? []).map(e => ({...e, start: t(e.start), end: t(e.end)})),
            ...this.added.filter(e => e.date === date),
        ].sort((a, b) => a.start - b.start);

        // Runs: consecutive pieces of one state. apps/titles only when active.
        const runsOf = pieces => {
            const runs = [];
            for (const p of pieces) {
                const last = runs[runs.length - 1];
                if (last && last.state === p.state && last.end === p.start) {
                    last.end = p.end;
                    last.pieces.push(p);
                } else {
                    runs.push({start: p.start, end: p.end, state: p.state, pieces: [p]});
                }
            }
            return runs.map(r => {
                const apps = new Map(), titles = new Map();
                if (r.state === 'active') {
                    for (const p of r.pieces) {
                        if (!p.window)
                            continue;
                        const d = p.end - p.start;
                        const ak = JSON.stringify([p.window.app_id, p.window.app_name]);
                        apps.set(ak, (apps.get(ak) ?? 0) + d);
                        const tk = JSON.stringify([p.window.app_name, p.window.title]);
                        titles.set(tk, (titles.get(tk) ?? 0) + d);
                    }
                }
                return {
                    start: iso(r.start), end: iso(r.end), state: r.state, duration_ms: r.end - r.start,
                    apps: [...apps].map(([k, ms]) => {
                        const [app_id, app_name] = JSON.parse(k);
                        return {app_id, app_name, ms};
                    }).sort((a, b) => b.ms - a.ms),
                    titles: [...titles].map(([k, ms]) => {
                        const [app_name, title] = JSON.parse(k);
                        return {app_name, title, ms};
                    }).sort((a, b) => b.ms - a.ms),
                };
            });
        };

        // Segment pieces outside every entry are unassigned.
        const uncovered = [];
        for (const s of segments) {
            let cuts = [[s.start, s.end]];
            for (const e of entries) {
                cuts = cuts.flatMap(([a, b]) => {
                    if (e.end <= a || e.start >= b)
                        return [[a, b]];
                    return [[a, e.start], [e.end, b]].filter(([x, y]) => y > x);
                });
            }
            for (const [a, b] of cuts)
                uncovered.push({...s, start: a, end: b});
        }

        const totals = {states: stateMs(), unassigned: stateMs()};
        for (const s of segments)
            totals.states[s.state] += s.end - s.start;
        for (const s of uncovered)
            totals.unassigned[s.state] += s.end - s.start;
        const groups = new Map();
        let assigned = 0, billable = 0;
        const timesheetEntries = entries.map((e, i) => {
            const evidence = stateMs();
            for (const s of segments) {
                const o = Math.min(s.end, e.end) - Math.max(s.start, e.start);
                if (o > 0)
                    evidence[s.state] += o;
            }
            const duration = e.end - e.start;
            assigned += duration;
            if (e.billable ?? true)
                billable += duration;
            const key = JSON.stringify([e.client ?? '', e.ticket, e.category ?? '', e.billable ?? true]);
            groups.set(key, (groups.get(key) ?? 0) + duration);
            return {
                assignment: this._assignment(e, i + 1),
                clip_start: iso(e.start), clip_end: iso(e.end), duration_ms: duration,
                evidence, overlap_ms: 0, overlaps_with: [],
            };
        });

        const [y, mo, d] = date.split('-').map(Number);
        const dayStart = GLib.DateTime.new(zone, y, mo, d, 0, 0, 0);
        const first = segments.length ? segments[0].start : null;
        return {
            date,
            zone: zoneId,
            day_start: iso(dayStart.to_unix() * 1000),
            day_end: iso(dayStart.add_days(1).to_unix() * 1000),
            now: iso(now),
            away_after_s: 300,
            span: first === null ? null : {start: iso(first), end: iso(now)},
            segments: segments.map(s => ({start: iso(s.start), end: iso(s.end), state: s.state, window: s.window})),
            segments_truncated: false,
            intervals: runsOf(segments),
            entries: timesheetEntries,
            unassigned: runsOf(uncovered),
            totals: {
                states: totals.states,
                assigned_ms: assigned,
                booked_ms: assigned,
                double_booked_ms: 0,
                unassigned: totals.unassigned,
                billable_ms: billable,
                non_billable_ms: assigned - billable,
                groups: [...groups].map(([k, ms]) => {
                    const [client, ticket, category, isBillable] = JSON.parse(k);
                    return {client, ticket, category, billable: isBillable, exact_ms: ms};
                }),
            },
            suggestions: {
                clients: fx.clients ?? [...new Set((fx.ticket_defaults ?? []).map(td => td.client))],
                tickets: fx.tickets ?? [],
                categories: fx.categories ?? [...new Set((fx.ticket_defaults ?? []).map(td => td.category))],
                ticket_defaults: fx.ticket_defaults ?? [],
            },
            rounding: {increment_min: 6, mode: 'nearest'},
        };
    }
}

const fakes = new Fakes();
const loop = new GLib.MainLoop(null, false);
const ports = {admin: fakes.admin.port, control: fakes.control.port, app: fakes.app.port};
GLib.file_set_contents(portsFile, JSON.stringify(ports));
print(`fakes listening: ${JSON.stringify(ports)} zone ${zoneId}`);
loop.run();
const path = GLib.build_filenamev([runtimeDir, 'whatdidido', 'control.json']);
if (GLib.file_test(path, GLib.FileTest.EXISTS))
    GLib.unlink(path);
