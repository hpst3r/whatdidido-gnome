import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {appBaseFromLocation, appRoute, parseAppUrlSetting} from './day_model.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export const APP_URL_KEY = 'app-url';
const ASSIGN_KEYS = ['start', 'end', 'ticket', 'client', 'category', 'note', 'billable'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// status/code: the HTTP status and the API's error code (the v1 envelope
// {"error": {"code": ...}}, or a flat {"error": "<code>"}); unreachable:
// nothing answered at the app server's address (it is discovered again on the
// next call). Client-side refusals carry a code and status 0: 'no_app_server',
// 'busy' (an Assign is already in flight), 'invalid' (a malformed argument or
// response).
export class AppError extends Error {
    constructor(message, {status = 0, code = null, unreachable = false} = {}) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.unreachable = unreachable;
    }
}

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

const UNREACHABLE = ['CONNECTION_REFUSED', 'HOST_UNREACHABLE', 'NETWORK_UNREACHABLE', 'CONNECTION_CLOSED'];

function isUnreachable(e) {
    return UNREACHABLE.some(name => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum[name]));
}

function errorCode(data) {
    const err = data?.error;
    if (typeof err === 'string')
        return err;
    return typeof err?.code === 'string' ? err.code : null;
}

// The arrays and strings lib/day_model.js reads without further checks.
function isDay(d) {
    return !!d && typeof d === 'object' && typeof d.date === 'string' && typeof d.now === 'string' &&
        typeof d.zone === 'string' && ['segments', 'entries', 'unassigned'].every(k => Array.isArray(d[k])) &&
        (d.span === null || (typeof d.span?.start === 'string' && typeof d.span?.end === 'string'));
}

// The app server (the read server that serves /app/), POPOVER.md section 3.
//   control: the ControlClient (its baseUrl() names the control server)
//   settings: {get(key) -> string}, for 'app-url'
// Requests are plain loopback requests: no Authorization (the control token
// never leaves the control client), Origin, Cookie or Sec-Fetch-*, so the
// server treats them as the local principal.
export class AppClient {
    constructor({control, settings}) {
        this._control = control;
        this._settings = settings;
        // No cookie jar or other features beyond Soup's defaults.
        this._session = new Soup.Session({timeout: 10, user_agent: 'whatdidido-gnome/0.1'});
        this._discovered = null;    // {controlBase, origin}: the last discovery
        this._lastOrigin = null;    // the last discovered origin, kept while the session is not running
        this._assigning = false;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    // parseAppUrlSetting() of the current setting: {auto, origin, invalid}.
    setting() {
        return parseAppUrlSetting(this._settings.get(APP_URL_KEY));
    }

    // True when app-url is set but not a loopback http origin (the popover's notice).
    get invalidSetting() {
        return this.setting().invalid;
    }

    // The app server origin ('http://127.0.0.1:<port>') or null: the setting
    // when set (null when invalid), else discovered from the control server's
    // GET /day redirect. Discovery runs again when the control base_url
    // changes or after an app request found nothing listening; while the
    // session is not running the last discovered origin is used.
    async base(cancellable = null) {
        const setting = this.setting();
        if (!setting.auto)
            return setting.origin;
        let controlBase;
        try {
            controlBase = await this._control.baseUrl(cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return this._lastOrigin;
        }
        if (this._discovered?.controlBase === controlBase)
            return this._discovered.origin;
        let origin;
        try {
            origin = await this._discover(controlBase, cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            // A control file left behind, or a failed probe: not running.
            return this._lastOrigin;
        }
        this._discovered = {controlBase, origin};
        if (origin)
            this._lastOrigin = origin;
        return origin;
    }

    // GET <control>/day without following redirects and without the control
    // token; the Location names the app server.
    async _discover(controlBase, cancellable) {
        const msg = Soup.Message.new('GET', `${controlBase}/day`);
        if (!msg)
            return null;
        msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
        await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        return appBaseFromLocation(controlBase, msg.get_status(), msg.get_response_headers().get_one('Location'));
    }

    _forget() {
        this._discovered = null;
    }

    async _send(base, method, path, body, cancellable) {
        const msg = Soup.Message.new(method, base + path);
        if (!msg)
            throw new AppError('invalid app server URL', {code: 'invalid'});
        // A 3xx is an ordinary failure: nothing leaves 127.0.0.1 (Amendment 2.1).
        msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
        if (body !== null) {
            const data = new TextEncoder().encode(JSON.stringify(body));
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(data));
        }
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            if (isUnreachable(e)) {
                this._forget();
                throw new AppError('app server not reachable', {unreachable: true});
            }
            throw new AppError(`request failed: ${e.message}`);
        }
        const status = msg.get_status();
        let data = null;
        try {
            data = JSON.parse(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()));
        } catch {}
        if (status < 200 || status > 299) {
            const code = errorCode(data);
            throw new AppError(`HTTP ${status}${code ? ` ${code}` : ''}`, {status, code});
        }
        if (data === null || typeof data !== 'object')
            throw new AppError('invalid JSON response', {status, code: 'invalid'});
        return data;
    }

    // The TimesheetDay for a local date (YYYY-MM-DD), or null when there is
    // no app server or it runs without --timesheet (404). Other failures
    // reject with an AppError (unreachable for nothing listening).
    async day(date, cancellable = null) {
        if (typeof date !== 'string' || !DATE_RE.test(date))
            throw new AppError('invalid date', {code: 'invalid'});
        const base = await this.base(cancellable);
        if (!base)
            return null;
        let data;
        try {
            data = await this._send(base, 'GET', `/api/v1/timesheet/day?date=${date}`, null, cancellable);
        } catch (e) {
            if (e.status === Soup.Status.NOT_FOUND)
                return null;
            throw e;
        }
        if (!isDay(data))
            throw new AppError('invalid timesheet day', {code: 'invalid'});
        return data;
    }

    // POST /api/v1/timesheet/assignments with exactly start, end, ticket,
    // client, category, note, billable (popover_model.assignmentBody). One at
    // a time: a second call while one is in flight rejects with code 'busy'.
    // Resolves to the created assignment.
    async assign(body, cancellable = null) {
        if (!body || typeof body !== 'object')
            throw new AppError('invalid assignment', {code: 'invalid'});
        if (this._assigning)
            throw new AppError('an assignment is already being saved', {code: 'busy'});
        this._assigning = true;
        try {
            const base = await this.base(cancellable);
            if (!base)
                throw new AppError('no app server', {code: 'no_app_server'});
            const exact = Object.fromEntries(ASSIGN_KEYS.map(k => [k, body[k]]));
            const data = await this._send(base, 'POST', '/api/v1/timesheet/assignments', exact, cancellable);
            return data.assignment ?? null;
        } finally {
            this._assigning = false;
        }
    }

    // '<app>/app/#/<view>?<params>' for the browser, or null without a known
    // app server. Synchronous: the setting, else the last discovered origin
    // (base() discovers it; the popover calls base() when it opens).
    url(view, params = {}) {
        const setting = this.setting();
        let origin = setting.origin;
        if (setting.auto)
            origin = this._discovered ? this._discovered.origin : this._lastOrigin;
        return origin ? `${origin}/app/${appRoute(view, params)}` : null;
    }
}
