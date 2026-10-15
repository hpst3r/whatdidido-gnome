// Tiny loopback fake of whatdidido's control API v1 (Soup.Server), for
// tests/client_test.js. It enforces the request rules of the contract
// (bearer token, no browser headers, no query, JSON POST bodies with exactly
// the documented keys) and records every request it sees.
//
// POST /control/v1/window follows whatdidido TIME_ACCOUNTING.md section 3
// and Amendment 2 (8 KiB body limit; offered only when `windowActivity` is
// set). Its sanitiser is written independently of lib/window_model.js on
// purpose, so the client tests cross-check the two.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const BODY_KEYS = {
    '/control/v1/command': [['action']],
    '/control/v1/mic': [['on'], ['on', 'source_id', 'inventory']],
    '/control/v1/interval': [['seconds']],
    '/control/v1/window': [['focus'], ['focus', 'app_id', 'app_name', 'wm_class', 'title']],
};
const BODY_LIMIT = {'/control/v1/window': 8192};  // bytes (Amendment 2 item 1); everything else 1 KiB
const WINDOW_FIELDS = ['app_id', 'app_name', 'wm_class', 'title'];

// Server-side sanitising (section 3), byte-counted with TextEncoder.
function sanitizeWindowBody(body) {
    if (body.focus === 'none')
        return {focus: 'none'};
    const enc = new TextEncoder();
    const out = {focus: 'window'};
    for (const k of WINDOW_FIELDS) {
        const chars = Array.from(body[k].replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
        out[k] = chars.slice(0, k === 'title' ? 1024 : 255).join('');
    }
    const size = o => Object.entries(o).reduce((n, [k, v]) => n + enc.encode(k).length + enc.encode(v).length, 0);
    if (size(out) > 3500) {
        const chars = Array.from(out.title);
        do
            chars.pop();
        while (chars.length && size({...out, title: `${chars.join('')}…`}) > 3500);
        out.title = `${chars.join('')}…`;
    }
    return out;
}
const BROWSER_HEADERS = ['origin', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];

export class FakeControl {
    constructor({token}) {
        this.token = token;
        this.requests = [];
        this.onStaleToken = null;     // (request) => void, called before a 403 for a wrong token
        this.inventoryChanges = 0;    // POST /mic answers inventory_changed this many times
        this.beforeMicPost = null;    // (body) => void, e.g. re-enumerate devices between GET and POST
        // whatdidido RELIABILITY.md section 7: microphones carry `stable_id`;
        // the status mic object adds stable_id, label, state, remembered.
        // false mimics an older server without them (stable_id is stripped).
        this.micDetails = false;
        this.status = {
            state: 'recording', monitors: 1, samples: 4, interval_seconds: 30,
            last_error: null, reason: null,
            mic: {available: true, on: false, source_id: null},
        };
        this.inventory = 'inv1';
        this.mics = [{id: 'm1', label: 'Built-in'}, {id: 'm2', label: 'USB headset'}];
        // Window activity (--window-activity): off by default, like the server.
        this.windowActivity = false;
        this.windows = [];          // recorded active_window metadata, in order
        this.windowDropped = 0;
        this.windowCap = 60;        // recorded windows per rolling 60 s
        this._windowTimes = [];
        this._lastWindow = null;
        // Amendment 1: incremented whenever the last window is forgotten.
        // windowEpochReported = false mimics an older server without it.
        this.windowEpoch = 0;
        this.windowEpochReported = true;
        // Hold POST /window replies (already processed) until releaseWindowReplies().
        this.holdWindowReplies = false;
        this._held = [];
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
            const tooLarge = path in BODY_LIMIT ? (bytes?.length ?? 0) > BODY_LIMIT[path] : raw.length > 1024;
            if (headers['content-type'] !== 'application/json' || tooLarge)
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
            return this._reply(msg, 200, this.windowActivity ? {...this.status, window_activity: this._windowStatus()} : this.status);
        case 'GET /control/v1/microphones':
            return this._reply(msg, 200, {inventory: this.inventory, microphones: this._micList()});
        case 'POST /control/v1/command': {
            const allowed = {start: ['stopped', 'failed'], pause: ['recording'], resume: ['paused'],
                stop: ['starting', 'recording', 'paused', 'recovering']}[body.action];
            if (!allowed)
                return this._reply(msg, 400, {error: 'invalid'});
            if (!allowed.includes(this.status.state))
                return this._reply(msg, 409, {error: 'not_allowed'});
            this.status.state = {start: 'starting', pause: 'paused', resume: 'recording', stop: 'stopping'}[body.action];
            if (body.action !== 'stop')
                this.forgetWindow();  // pause, resume and start forget the last window
            return this._reply(msg, 202, {state: this.status.state});
        }
        case 'POST /control/v1/mic': {
            if (body.on) {
                this.beforeMicPost?.(body);
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
            const mic = body.on ? this.mics.find(m => m.id === body.source_id) : null;
            this.status.mic = {available: true, on: body.on, source_id: mic ? mic.id : null};
            if (this.micDetails) {
                Object.assign(this.status.mic, {
                    stable_id: mic?.stable_id ?? null,
                    label: mic?.label ?? null,
                    state: !mic ? 'off' : this.status.state === 'recording' ? 'capturing' : 'pending',
                    remembered: false,
                });
            }
            return this._reply(msg, 200, {mic: this.status.mic});
        }
        case 'POST /control/v1/interval':
            if (!Number.isInteger(body.seconds) || body.seconds < 5 || body.seconds > 3600)
                return this._reply(msg, 400, {error: 'invalid'});
            this.status.interval_seconds = body.seconds;
            return this._reply(msg, 200, {interval_seconds: body.seconds});
        case 'POST /control/v1/window':
            this._window(msg, body);
            if (this.holdWindowReplies) {
                msg.pause();
                this._held.push(msg);
            }
            return undefined;
        default:
            return this._reply(msg, 404, {error: 'not_found'});
        }
    }

    _micList() {
        if (this.micDetails)
            return this.mics.map(m => ({stable_id: null, ...m}));
        return this.mics.map(({stable_id: _, ...m}) => m);
    }

    _windowStatus() {
        const wa = {available: true, recorded: this.windows.length, dropped: this.windowDropped};
        return this.windowEpochReported ? {...wa, epoch: this.windowEpoch} : wa;
    }

    // Start, pause, resume and recovery forget the last window and bump the
    // epoch. Also for tests that simulate a recovery "from outside".
    forgetWindow() {
        this._lastWindow = null;
        this.windowEpoch++;
    }

    get heldWindowReplies() {
        return this._held.length;
    }

    releaseWindowReplies() {
        this.holdWindowReplies = false;
        for (const msg of this._held.splice(0))
            msg.unpause();
    }

    resetWindows() {
        this.windows = [];
        this.windowDropped = 0;
        this._windowTimes = [];
        this._lastWindow = null;
    }

    _window(msg, body) {
        const shapeOk = body.focus === 'none'
            ? Object.keys(body).length === 1
            : body.focus === 'window' && WINDOW_FIELDS.every(k => typeof body[k] === 'string');
        if (!shapeOk)
            return this._reply(msg, 400, {error: 'invalid'});
        if (!this.windowActivity)
            return this._reply(msg, 409, {error: 'unavailable'});
        const meta = sanitizeWindowBody(body);
        if (this.status.state !== 'recording' || JSON.stringify(meta) === JSON.stringify(this._lastWindow))
            return this._reply(msg, 202, {recorded: false});
        const now = GLib.get_monotonic_time();
        this._windowTimes = this._windowTimes.filter(t => now - t < 60 * 1000000);
        if (this._windowTimes.length >= this.windowCap) {
            this.windowDropped++;
            return this._reply(msg, 202, {recorded: false});
        }
        this._windowTimes.push(now);
        this._lastWindow = meta;
        this.windows.push(meta);
        return this._reply(msg, 202, {recorded: true});
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
