// Tiny loopback fake of whatdidido's control API v1 (Soup.Server), for
// tests/client_test.js. It enforces the request rules of the contract
// (bearer token, no browser headers, no query, JSON POST bodies with exactly
// the documented keys) and records every request it sees.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const BODY_KEYS = {
    '/control/v1/command': [['action']],
    '/control/v1/mic': [['on'], ['on', 'source_id', 'inventory']],
    '/control/v1/interval': [['seconds']],
};
const BROWSER_HEADERS = ['origin', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];

export class FakeControl {
    constructor({token}) {
        this.token = token;
        this.requests = [];
        this.onStaleToken = null;     // (request) => void, called before a 403 for a wrong token
        this.inventoryChanges = 0;    // POST /mic answers inventory_changed this many times
        this.status = {
            state: 'recording', monitors: 1, samples: 4, interval_seconds: 30,
            last_error: null, reason: null,
            mic: {available: true, on: false, source_id: null},
        };
        this.inventory = 'inv1';
        this.mics = [{id: 'm1', label: 'Built-in'}, {id: 'm2', label: 'USB headset'}];
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

    _handle(msg, path, query) {
        const headers = {};
        msg.get_request_headers().foreach((name, value) => {
            headers[name.toLowerCase()] = value;
        });
        const bytes = msg.get_request_body().flatten().get_data();
        const raw = bytes ? new TextDecoder().decode(bytes) : '';
        const method = msg.get_method();
        const req = {method, path, query: query ? Object.keys(query) : null, headers, body: raw};
        this.requests.push(req);

        if (BROWSER_HEADERS.some(h => h in headers) || query)
            return this._reply(msg, 403, {error: 'forbidden'});
        if (headers['authorization'] !== `Bearer ${this.token}`) {
            this.onStaleToken?.(req);
            return this._reply(msg, 403, {error: 'forbidden'});
        }

        let body = null;
        if (method === 'POST') {
            if (headers['content-type'] !== 'application/json' || raw.length > 1024)
                return this._reply(msg, 400, {error: 'invalid'});
            try {
                body = JSON.parse(raw);
            } catch {
                return this._reply(msg, 400, {error: 'invalid'});
            }
            const keys = Object.keys(body ?? {}).sort().join(',');
            if (!(BODY_KEYS[path] ?? []).some(k => k.slice().sort().join(',') === keys))
                return this._reply(msg, 400, {error: 'invalid'});
        }

        const route = `${method} ${path}`;
        switch (route) {
        case 'GET /control/v1/status':
            return this._reply(msg, 200, this.status);
        case 'GET /control/v1/microphones':
            return this._reply(msg, 200, {inventory: this.inventory, microphones: this.mics});
        case 'POST /control/v1/command': {
            const allowed = {start: ['stopped', 'failed'], pause: ['recording'], resume: ['paused'],
                stop: ['starting', 'recording', 'paused', 'recovering']}[body.action];
            if (!allowed)
                return this._reply(msg, 400, {error: 'invalid'});
            if (!allowed.includes(this.status.state))
                return this._reply(msg, 409, {error: 'not_allowed'});
            this.status.state = {start: 'starting', pause: 'paused', resume: 'recording', stop: 'stopping'}[body.action];
            return this._reply(msg, 202, {state: this.status.state});
        }
        case 'POST /control/v1/mic':
            if (body.on) {
                if (this.inventoryChanges > 0) {
                    // A device appeared between the client's GET and POST.
                    this.inventoryChanges--;
                    this.inventory = `inv${Number(this.inventory.slice(3)) + 1}`;
                }
                if (body.inventory !== this.inventory)
                    return this._reply(msg, 409, {error: 'inventory_changed'});
                if (!this.mics.some(m => m.id === body.source_id))
                    return this._reply(msg, 400, {error: 'invalid'});
            }
            this.status.mic = {available: true, on: body.on, source_id: body.on ? body.source_id : null};
            return this._reply(msg, 200, {mic: this.status.mic});
        case 'POST /control/v1/interval':
            if (!Number.isInteger(body.seconds) || body.seconds < 5 || body.seconds > 3600)
                return this._reply(msg, 400, {error: 'invalid'});
            this.status.interval_seconds = body.seconds;
            return this._reply(msg, 200, {interval_seconds: body.seconds});
        default:
            return this._reply(msg, 404, {error: 'not_found'});
        }
    }
}

// Write $runtime/whatdidido/control.json the way the server does (0700 dir, 0600 file).
export function writeControlFile(runtimeDir, baseUrl, token) {
    const dir = GLib.build_filenamev([runtimeDir, 'whatdidido']);
    GLib.mkdir_with_parents(dir, 0o700);
    const path = GLib.build_filenamev([dir, 'control.json']);
    GLib.file_set_contents(path, JSON.stringify({version: 1, base_url: baseUrl, token}));
    GLib.chmod(path, 0o600);
    return path;
}

export function removeControlFile(runtimeDir) {
    GLib.unlink(GLib.build_filenamev([runtimeDir, 'whatdidido', 'control.json']));
}
