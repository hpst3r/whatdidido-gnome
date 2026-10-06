import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {micRequest, parseControlFile} from './model.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

// notRunning: no control file, or nothing listening at its base_url.
// status/code: the HTTP status and the API's {"error": code}.
// Messages never contain the token.
export class ControlError extends Error {
    constructor(message, {status = 0, code = null, notRunning = false} = {}) {
        super(message);
        this.name = 'ControlError';
        this.status = status;
        this.code = code;
        this.notRunning = notRunning;
    }
}

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class ControlClient {
    // runtimeDir defaults to $XDG_RUNTIME_DIR; tests pass a scratch dir.
    constructor({runtimeDir = GLib.get_user_runtime_dir()} = {}) {
        this._path = GLib.build_filenamev([runtimeDir, 'whatdidido', 'control.json']);
        // No cookie jar or other features beyond Soup's defaults: the API
        // refuses Cookie/Origin/Sec-Fetch-*, and Soup never adds those itself.
        this._session = new Soup.Session({timeout: 10, user_agent: 'whatdidido-gnome/0.1'});
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    // Read on every request: the server writes a new token on each start and
    // deletes the file on clean shutdown.
    async _readControl(cancellable) {
        let bytes;
        try {
            [bytes] = await Gio.File.new_for_path(this._path).load_contents_async(cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw new ControlError('control file not found', {notRunning: true});
            throw new ControlError(`cannot read control file: ${e.message}`);
        }
        try {
            return parseControlFile(new TextDecoder().decode(bytes));
        } catch (e) {
            throw new ControlError(e.message);
        }
    }

    async _send(ctl, method, path, body, cancellable) {
        const msg = Soup.Message.new(method, ctl.baseUrl + path);
        if (!msg)
            throw new ControlError('invalid control URL');
        msg.request_headers.append('Authorization', `Bearer ${ctl.token}`);
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
            // A control file left behind by a crashed server.
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
                throw new ControlError('connection refused', {notRunning: true});
            throw new ControlError(`request failed: ${e.message}`);
        }

        const status = msg.get_status();
        let data = null;
        try {
            data = JSON.parse(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()));
        } catch {}
        if (status < 200 || status > 299) {
            const code = typeof data?.error === 'string' ? data.error : null;
            throw new ControlError(`HTTP ${status}${code ? ` ${code}` : ''}`, {status, code});
        }
        if (data === null || typeof data !== 'object')
            throw new ControlError('invalid JSON response');
        return data;
    }

    // On 403 the server may have restarted with a new token: re-read the
    // control file and retry once if it changed.
    async _request(method, path, body, cancellable) {
        const ctl = await this._readControl(cancellable);
        try {
            return await this._send(ctl, method, path, body, cancellable);
        } catch (e) {
            if (e.status !== Soup.Status.FORBIDDEN)
                throw e;
            const fresh = await this._readControl(cancellable);
            if (fresh.token === ctl.token && fresh.baseUrl === ctl.baseUrl)
                throw e;
            return this._send(fresh, method, path, body, cancellable);
        }
    }

    // For opening the session page / day view in a browser.
    async baseUrl(cancellable) {
        return (await this._readControl(cancellable)).baseUrl;
    }

    status(cancellable) {
        return this._request('GET', '/control/v1/status', null, cancellable);
    }

    microphones(cancellable) {
        return this._request('GET', '/control/v1/microphones', null, cancellable);
    }

    command(action, cancellable) {
        return this._request('POST', '/control/v1/command', {action}, cancellable);
    }

    setInterval(seconds, cancellable) {
        return this._request('POST', '/control/v1/interval', {seconds}, cancellable);
    }

    // Turning on picks the preferred microphone (else the first) from a fresh
    // inventory; if the inventory changed in between, re-read it and retry once.
    async setMicOn(on, preferredId, cancellable) {
        if (!on)
            return this._request('POST', '/control/v1/mic', {on: false}, cancellable);
        for (let attempt = 0; ; attempt++) {
            const inv = await this.microphones(cancellable);
            const body = micRequest(true, inv.microphones, preferredId, inv.inventory);
            if (!body)
                throw new ControlError('No microphone available');
            try {
                return await this._request('POST', '/control/v1/mic', body, cancellable);
            } catch (e) {
                if (attempt > 0 || e.code !== 'inventory_changed')
                    throw e;
            }
        }
    }
}
