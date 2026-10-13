// Active-window reporting (whatdidido TIME_ACCOUNTING.md section 4): pure
// logic, no GI imports, so it runs under plain `gjs -m` tests. The glue in
// window_tracker.js only reads the focused window and wires signals/timers.
//
// Payloads are POST /control/v1/window bodies:
//   {"focus": "none"} or
//   {"focus": "window", "app_id": s, "app_name": s, "wm_class": s, "title": s}

export const SETTLE_MS = 1000;
export const SPACING_MS = 2000;
// Retry of a failed POST (Amendment 2 item 6): 2, 4, 8 ... 60 s.
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 60000;
// Distinct error messages remembered for "log once".
export const LOGGED_MAX = 32;
export const APP_FIELD_MAX_CHARS = 255;
export const TITLE_MAX_CHARS = 1024;
// The server's metadata budget: sum of the UTF-8 bytes of every key and value.
export const METADATA_MAX_BYTES = 3500;

const ELLIPSIS = '…';
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function cpBytes(cp) {
    return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

export function utf8Length(s) {
    let n = 0;
    for (const ch of s)
        n += cpBytes(ch.codePointAt(0));
    return n;
}

export function metadataBytes(payload) {
    let n = 0;
    for (const [k, v] of Object.entries(payload))
        n += utf8Length(k) + utf8Length(v);
    return n;
}

// "Characters" are code points (the server counts Python str length), so an
// astral character is never split. Lone surrogates can't be encoded as UTF-8
// and become U+FFFD.
function clean(value, maxChars) {
    const chars = [...String(value).toWellFormed().replace(CONTROL_RE, ' ')];
    return chars.length > maxChars ? chars.slice(0, maxChars).join('') : chars.join('');
}

// The server's sanitising, applied client-side so what is sent is what gets
// recorded: control characters -> space, clamp each field, then shorten the
// title (ending with '…') until the metadata fits METADATA_MAX_BYTES.
export function sanitizeWindow(payload) {
    if (payload.focus !== 'window')
        return {focus: 'none'};
    const out = {
        focus: 'window',
        app_id: clean(payload.app_id, APP_FIELD_MAX_CHARS),
        app_name: clean(payload.app_name, APP_FIELD_MAX_CHARS),
        wm_class: clean(payload.wm_class, APP_FIELD_MAX_CHARS),
        title: clean(payload.title, TITLE_MAX_CHARS),
    };
    const total = metadataBytes(out);
    if (total > METADATA_MAX_BYTES) {
        let budget = METADATA_MAX_BYTES - (total - utf8Length(out.title)) - utf8Length(ELLIPSIS);
        let prefix = '';
        for (const ch of out.title) {
            budget -= cpBytes(ch.codePointAt(0));
            if (budget < 0)
                break;
            prefix += ch;
        }
        out.title = prefix + ELLIPSIS;
    }
    return out;
}

function bareId(id) {
    return id.trim().replace(/\.desktop$/, '');
}

// Excluded entries match the app id with or without its ".desktop" suffix.
export function isExcluded(appId, excluded) {
    if (!appId)
        return false;
    const id = bareId(appId);
    return (excluded ?? []).some(e => typeof e === 'string' && e.trim() !== '' && bareId(e) === id);
}

// raw: null (no focused window) or what the shell reports:
// {appId, appName, wmClass, title}, any of which may be null/undefined.
export function windowPayload(raw, excluded = []) {
    if (!raw)
        return {focus: 'none'};
    const str = v => (typeof v === 'string' ? v : '');
    let appId = str(raw.appId);
    if (appId.startsWith('window:'))  // Shell's synthetic id for app-less windows
        appId = '';
    return sanitizeWindow({
        focus: 'window',
        app_id: appId,
        app_name: str(raw.appName),
        wm_class: str(raw.wmClass),
        title: isExcluded(appId, excluded) ? '' : str(raw.title),
    });
}

// Payloads are always built with the same key order.
export function samePayload(a, b) {
    return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

export function windowActivityOffered(status, running) {
    return !!running && status?.window_activity?.available === true;
}

export function windowEligible(status, running) {
    return windowActivityOffered(status, running) && status.state === 'recording';
}

// window_activity.epoch (Amendment 1): bumped by the server whenever it
// forgets the last recorded window. null when absent (older server) or invalid.
export function windowEpoch(status, running) {
    const epoch = windowActivityOffered(status, running) ? status.window_activity.epoch : undefined;
    return Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
}

const SWITCH_LABEL = 'Record active window';

// The menu switch. unavailable: the server answered 409 since the last poll.
export function windowSwitchView(status, {running, enabled, unavailable}) {
    const offered = windowActivityOffered(status, running) && !unavailable;
    return {
        sensitive: offered,
        on: !!enabled,
        label: running && !offered ? `${SWITCH_LABEL} (not enabled on the server)` : SWITCH_LABEL,
    };
}

// Prefs entry text <-> settings list (comma/whitespace separated).
export function parseExcludedApps(text) {
    const out = [];
    for (const id of String(text).split(/[\s,]+/)) {
        if (id && !out.includes(id))
            out.push(id);
    }
    return out;
}

export function formatExcludedApps(list) {
    return list.join(', ');
}

// Decides when to POST the focused window.
//
// - Active only while enabled, the last poll showed window_activity.available
//   and state "recording", and no 409 came back since that poll.
// - changed() (re)arms a SETTLE_MS timer; on fire the payload is built from
//   the *current* focus and skipped if equal to the last one sent.
// - At most one POST per SPACING_MS, one in flight at a time; a send inside
//   the spacing waits for its end and then uses the focus at that moment.
// - Becoming active (transition into recording, from unavailable, setting
//   turned on) forgets the last payload and sends at once (spacing permitting).
//   So does a changed window_activity.epoch between two polls while active
//   (a pause and resume, or a recovery, the polls did not see).
// - Becoming inactive cancels every pending timer. Turning the setting off
//   while active sends {"focus": "none"} once (after any request in flight,
//   spacing permitting; never retried), unless recording/availability ends
//   first.
// - A failed POST (any error except 409 unavailable) forgets the last payload
//   and retries the *current* focus with backoff RETRY_MIN_MS, doubling up
//   to RETRY_MAX_MS, until a POST succeeds or the focus changes (a change
//   goes through the settle timer instead).
// - Errors are logged once per distinct message (the last LOGGED_MAX kept).
//
// deps: now() -> ms (monotonic); setTimer(ms, fn) -> id; clearTimer(id);
// readFocus() -> raw focus for windowPayload(); send(payload) -> Promise
// (rejects with {status, code, message}); log(message); onUnavailable()
// after a 409 turned reporting off until the next poll.
export class WindowReporter {
    constructor({now, setTimer, clearTimer, readFocus, send, log = () => {}, onUnavailable = () => {},
        enabled = true, excluded = [], settleMs = SETTLE_MS, spacingMs = SPACING_MS,
        retryMinMs = RETRY_MIN_MS, retryMaxMs = RETRY_MAX_MS}) {
        Object.assign(this, {_now: now, _setTimer: setTimer, _clearTimer: clearTimer,
            _readFocus: readFocus, _send: send, _log: log, _onUnavailable: onUnavailable, _settleMs: settleMs, _spacingMs: spacingMs,
            _retryMinMs: retryMinMs, _retryMaxMs: retryMaxMs});
        this._enabled = !!enabled;
        this._excluded = excluded;
        this._eligible = false;
        this._unavailable = false;
        this._destroyed = false;
        this._last = null;          // last payload the server accepted (202)
        this._generation = 0;       // bumped whenever _last is forgotten
        this._epoch = null;         // window_activity.epoch of the last poll
        this._lastSendAt = -Infinity;
        this._settleTimer = null;
        this._spacingTimer = null;
        this._retryTimer = null;
        this._failures = 0;         // consecutive failed POSTs (backoff step)
        this._offPending = false;   // {"focus": "none"} owed after switching off
        this._inFlight = false;
        this._pending = false;
        this._logged = new Set();   // insertion order: oldest first
    }

    get active() {
        return !this._destroyed && this._enabled && this._eligible && !this._unavailable;
    }

    get unavailable() {
        return this._unavailable;
    }

    setEnabled(on) {
        const switchedOff = this.active && !on;
        this._update(() => {
            this._enabled = !!on;
        });
        if (switchedOff) {
            this._offPending = true;
            this._flush();
        }
    }

    setExcluded(list) {
        this._excluded = list;
        this.changed();
    }

    // After every status poll; status is null when the server is not running.
    updateStatus(status, running) {
        const epoch = windowEpoch(status, running);
        const epochChanged = epoch !== null && this._epoch !== null && epoch !== this._epoch;
        this._epoch = epoch;
        this._update(() => {
            this._eligible = windowEligible(status, running);
            this._unavailable = false;
        }, epochChanged);
        // Not recording (or not offered) any more: the server no longer
        // attributes time to the last window, so "none" is not needed.
        if (!this._eligible)
            this._offPending = false;
    }

    // Focus, title or wm-class changed.
    changed() {
        if (!this.active)
            return;
        this._clear('_settleTimer');
        this._clear('_retryTimer');
        this._settleTimer = this._setTimer(this._settleMs, () => {
            this._settleTimer = null;
            this._flush();
        });
    }

    destroy() {
        this._destroyed = true;
        this._offPending = false;
        this._clear('_settleTimer');
        this._clear('_spacingTimer');
        this._clear('_retryTimer');
    }

    _clear(name) {
        if (this[name] !== null) {
            this._clearTimer(this[name]);
            this[name] = null;
        }
    }

    // restart: treat staying active like becoming active.
    _update(mutate, restart = false) {
        const was = this.active;
        mutate();
        const is = this.active;
        if (is && (!was || restart)) {
            this._forget();
            this._offPending = false;
            if (!was)
                this._failures = 0;
            this._clear('_settleTimer');
            this._clear('_retryTimer');
            this._flush();
        } else if (was && !is) {
            this._clear('_settleTimer');
            this._clear('_spacingTimer');
            this._clear('_retryTimer');
        }
    }

    _forget() {
        this._last = null;
        this._generation++;
    }

    _flush() {
        const off = this._offPending && !this.active;
        if (!this.active && !off)
            return;
        if (this._inFlight) {
            this._pending = true;
            return;
        }
        const wait = this._lastSendAt + this._spacingMs - this._now();
        if (wait > 0) {
            if (this._spacingTimer === null) {
                this._spacingTimer = this._setTimer(wait, () => {
                    this._spacingTimer = null;
                    this._flush();
                });
            }
            return;
        }
        if (off) {
            this._offPending = false;
            this._post({focus: 'none'});
            return;
        }
        const payload = windowPayload(this._readFocus(), this._excluded);
        if (samePayload(payload, this._last))
            return;
        this._post(payload);
    }

    _logOnce(msg) {
        if (this._logged.has(msg))
            return;
        this._log(msg);
        this._logged.add(msg);
        if (this._logged.size > LOGGED_MAX)
            this._logged.delete(this._logged.values().next().value);
    }

    _scheduleRetry() {
        const delay = Math.min(this._retryMinMs * 2 ** (this._failures - 1), this._retryMaxMs);
        this._clear('_retryTimer');
        this._retryTimer = this._setTimer(delay, () => {
            this._retryTimer = null;
            this._flush();
        });
    }

    async _post(payload) {
        const generation = this._generation;
        this._clear('_retryTimer');
        this._inFlight = true;
        this._lastSendAt = this._now();
        try {
            await this._send(payload);
            if (generation === this._generation)
                this._last = payload;
            this._failures = 0;
        } catch (e) {
            if (this._destroyed)
                return;
            // Messages come from the client (HTTP status/code, transport
            // errors): never the payload, never the token.
            this._logOnce(`whatdidido: active window report failed: ${e?.message ?? e}`);
            // The server may or may not have recorded it: dedupe against
            // nothing until a POST succeeds.
            this._forget();
            if (e?.code === 'unavailable') {
                this._update(() => {
                    this._unavailable = true;
                });
                this._onUnavailable();
            } else if (this.active) {
                this._failures++;
                this._scheduleRetry();
            }
        } finally {
            this._inFlight = false;
            if (this._pending && !this._destroyed) {
                this._pending = false;
                this._flush();
            }
        }
    }
}

// Signal bookkeeping for the focused window (window_tracker.js): follows one
// window at a time and calls onChange() on its title/wm-class changes. Its
// `unmanaged` signal drops the handlers (Amendment 2 item 6); disconnecting
// tolerates a window that is already disposed.
export class FocusWatch {
    constructor(onChange) {
        this._onChange = onChange;
        this._window = null;
        this._ids = [];
    }

    get window() {
        return this._window;
    }

    watch(win) {
        this.clear();
        if (!win)
            return;
        this._window = win;
        this._ids = [
            win.connect('notify::title', () => this._onChange()),
            win.connect('notify::wm-class', () => this._onChange()),
            win.connect('unmanaged', () => this.clear()),
        ];
    }

    clear() {
        const win = this._window, ids = this._ids;
        this._window = null;
        this._ids = [];
        for (const id of ids) {
            try {
                win.disconnect(id);
            } catch {
                // The window is already gone; so are its handlers.
            }
        }
    }
}
