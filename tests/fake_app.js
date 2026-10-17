// Tiny loopback fake of the whatdidido app server's two timesheet routes
// (Soup.Server), for tests/app_client_test.js. It records every request with
// its headers and answers like the read server: the v1 error envelope
// {"error": {"code", "message", "details"}}, 404 without --timesheet, a
// create body of exactly the seven documented keys.
//
// sampleDay() is a synthetic TimesheetDay (fictional tickets and apps) that
// the pure model tests use too; it imports nothing from GI.
import Soup from 'gi://Soup?version=3.0';

const CREATE_KEYS = ['billable', 'category', 'client', 'end', 'note', 'start', 'ticket'];

export class FakeApp {
    constructor() {
        this.requests = [];
        this.timesheet = true;      // false: 404 not_found for both routes (no --timesheet)
        this.day = sampleDay();
        this.assignStatus = 201;    // e.g. 409 for a conflict
        this.assignError = null;    // the code for a non-2xx assign answer
        this.flatErrors = false;    // true: a flat {"error": "<code>"} instead of the envelope
        this.hold = false;          // true: never answer (the request stays open)
        this.server = new Soup.Server({});
        this.server.add_handler(null, (_srv, msg, path, query) => this._handle(msg, path, query));
    }

    listen() {
        this.server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
        this.port = this.server.get_uris()[0].get_port();
        return `http://127.0.0.1:${this.port}`;
    }

    stop() {
        this.server.disconnect();
    }

    _reply(msg, code, obj) {
        msg.set_status(code, null);
        msg.get_response_headers().append('Cache-Control', 'no-store');
        msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(JSON.stringify(obj)));
    }

    _error(msg, status, code) {
        const body = this.flatErrors ? {error: code} : {error: {code, message: `fake ${code}`, details: []}};
        this._reply(msg, status, body);
    }

    _handle(msg, path, query) {
        const headers = {};
        msg.get_request_headers().foreach((name, value) => {
            headers[name.toLowerCase()] = value;
        });
        const bytes = msg.get_request_body().flatten().get_data();
        const raw = bytes ? new TextDecoder().decode(bytes) : '';
        const method = msg.get_method();
        this.requests.push({method, path, query: query ?? null, headers, body: raw});
        if (this.hold) {
            msg.pause();
            return undefined;
        }

        const route = `${method} ${path}`;
        if (route === 'GET /api/v1/timesheet/day') {
            if (!this.timesheet)
                return this._error(msg, 404, 'not_found');
            if (!query || Object.keys(query).join() !== 'date' || !/^\d{4}-\d{2}-\d{2}$/.test(query.date))
                return this._error(msg, 422, 'request_validation_error');
            return this._reply(msg, 200, {...this.day, date: query.date});
        }
        if (route === 'POST /api/v1/timesheet/assignments') {
            if (!this.timesheet)
                return this._error(msg, 404, 'not_found');
            let body;
            try {
                body = JSON.parse(raw);
            } catch {
                return this._error(msg, 400, 'invalid');
            }
            if (headers['content-type'] !== 'application/json' || Object.keys(body ?? {}).sort().join() !== CREATE_KEYS.join())
                return this._error(msg, 400, 'invalid');
            if (this.assignStatus !== 201)
                return this._error(msg, this.assignStatus, this.assignError ?? 'invalid');
            return this._reply(msg, 201, {assignment: {id: '00000000-0000-4000-8000-000000000001', ...body}});
        }
        return this._error(msg, 404, 'not_found');
    }
}

const at = hm => `2026-10-15T${hm}:00.000Z`;

// A day in America/New_York (UTC-4 in October): 13:00Z = 9:00 AM.
// 13:00-14:00 active on #4101, 14:00-14:20 paused, 14:20-14:40 locked,
// 14:40-15:10 active unassigned, now 15:10. The last focus is a terminal.
export function sampleDay() {
    const win = (app_id, app_name, title) => ({app_id, app_name, title});
    return {
        date: '2026-10-15',
        zone: 'America/New_York',
        day_start: '2026-10-15T04:00:00.000Z',
        day_end: '2026-10-16T04:00:00.000Z',
        now: at('15:10'),
        away_after_s: 300,
        span: {start: at('13:00'), end: at('15:10')},
        segments: [
            {start: at('13:00'), end: at('13:40'), state: 'active', window: win('org.mozilla.firefox', 'Firefox', 'Northwind ticket #4101')},
            {start: at('13:40'), end: at('14:00'), state: 'active', window: win('org.gnome.TextEditor', 'Text Editor', 'notes.txt')},
            {start: at('14:00'), end: at('14:20'), state: 'paused', window: null},
            {start: at('14:20'), end: at('14:40'), state: 'locked', window: null},
            {start: at('14:40'), end: at('15:10'), state: 'active', window: win('org.gnome.Ptyxis', 'Ptyxis Terminal', 'build — Contoso deploy')},
        ],
        segments_truncated: false,
        intervals: [],
        entries: [{
            assignment: {
                id: '00000000-0000-4000-8000-0000000000aa', start: at('13:00'), end: at('14:00'),
                ticket: '#4101', client: 'Northwind Traders', category: 'Support', note: '', billable: true,
                source: 'manual', revision: 1, created_at: at('14:00'), updated_at: at('14:00'),
            },
            clip_start: at('13:00'),
            clip_end: at('14:00'),
            duration_ms: 3600000,
            evidence: {},
            overlap_ms: 0,
            overlaps_with: [],
        }],
        unassigned: [
            {start: at('14:00'), end: at('14:20'), state: 'paused', duration_ms: 1200000, apps: [], titles: []},
            {start: at('14:20'), end: at('14:40'), state: 'locked', duration_ms: 1200000, apps: [], titles: []},
            {start: at('14:40'), end: at('15:10'), state: 'active', duration_ms: 1800000, apps: [], titles: []},
        ],
        totals: {},
        suggestions: {
            clients: ['Northwind Traders', 'Contoso'],
            tickets: ['#4101', '#4102', '#4207'],
            categories: ['Support'],
            ticket_defaults: [
                {ticket: '#4101', client: 'Northwind Traders', category: 'Support', billable: true},
                {ticket: '#4207', client: 'Contoso', category: 'Internal', billable: false},
            ],
        },
        rounding: {increment_min: 15, mode: 'nearest'},
    };
}
