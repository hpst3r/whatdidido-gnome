// Pure view-model logic: no GI imports, so it runs under plain `gjs -m` tests.
// Input shapes follow whatdidido's work-session control API (v1):
// GET /control/v1/status is the /session/status object plus `mic`.

export const STATES = ['stopped', 'starting', 'recording', 'paused', 'recovering', 'stopping', 'failed'];
export const INTERVAL_CHOICES = [5, 10, 30, 60];
export const NOT_RUNNING_TEXT = 'whatdidido not running';

// Mirrors the server's own guards (work_session_backend: _start/_pause/_resume/_stop).
const ALLOWED = {
    stopped: ['start'],
    failed: ['start'],
    starting: ['stop'],
    recording: ['pause', 'stop'],
    paused: ['resume', 'stop'],
    recovering: ['stop'],
    stopping: [],
};

export function allowedActions(state) {
    const ok = ALLOWED[state] ?? [];
    return {
        start: ok.includes('start'),
        pause: ok.includes('pause'),
        resume: ok.includes('resume'),
        stop: ok.includes('stop'),
    };
}

const LABELS = {
    stopped: 'Stopped',
    starting: 'Starting…',
    recording: 'Recording',
    paused: 'Paused',
    recovering: 'Reconnecting…',
    stopping: 'Stopping…',
    failed: 'Failed',
};

export function stateLabel(state) {
    return LABELS[state] ?? 'Unknown state';
}

// Icon names ship with Adwaita (symbolic/). Every state gets its own shape;
// the colour class is an extra cue, never the only one.
const ICONS = {
    stopped: ['media-playback-stop-symbolic', 'wdi-stopped'],
    starting: ['content-loading-symbolic', 'wdi-busy'],
    recording: ['media-record-symbolic', 'wdi-recording'],
    paused: ['media-playback-pause-symbolic', 'wdi-paused'],
    recovering: ['view-refresh-symbolic', 'wdi-recovering'],
    stopping: ['content-loading-symbolic', 'wdi-busy'],
    failed: ['dialog-error-symbolic', 'wdi-failed'],
};

export function panelState(state, running) {
    if (!running)
        return {icon: 'network-offline-symbolic', styleClass: 'wdi-offline', label: NOT_RUNNING_TEXT};
    const [icon, styleClass] = ICONS[state] ?? ['dialog-error-symbolic', 'wdi-failed'];
    return {icon, styleClass, label: stateLabel(state)};
}

function isCount(n) {
    return Number.isInteger(n) && n >= 0;
}

export function formatInterval(seconds) {
    if (!isCount(seconds) || seconds === 0)
        return '?';
    if (seconds >= 120 && seconds % 60 === 0)
        return `${seconds / 60} min`;
    return `${seconds}s`;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function headerText(status) {
    const samples = isCount(status?.samples) ? status.samples : 0;
    const monitors = isCount(status?.monitors) ? status.monitors : 0;
    return {
        title: stateLabel(status?.state),
        detail: `${plural(samples, 'screenshot')}, every ${formatInterval(status?.interval_seconds)}, ${plural(monitors, 'monitor')}`,
    };
}

// The fixed choices plus the current value when it was set elsewhere (the
// session page accepts any 5..3600), so the menu always shows what is active.
export function intervalItems(current) {
    const values = [...INTERVAL_CHOICES];
    if (isCount(current) && current > 0 && !values.includes(current)) {
        values.push(current);
        values.sort((a, b) => a - b);
    }
    return values.map(seconds => ({seconds, label: formatInterval(seconds), current: seconds === current}));
}

// The configured microphone if it is still present, else the first one.
export function chooseMicrophone(mics, preferredId) {
    if (!Array.isArray(mics) || !mics.length)
        return null;
    if (preferredId && mics.some(m => m.id === preferredId))
        return preferredId;
    return mics[0].id;
}

export function micSourceItems(mics, preferredId) {
    const chosen = chooseMicrophone(mics, preferredId);
    return (mics ?? []).map(m => ({id: m.id, label: m.label || m.id, checked: m.id === chosen}));
}

// Body for POST /control/v1/mic, or null when there is nothing to turn on.
export function micRequest(on, mics, preferredId, inventory) {
    if (!on)
        return {on: false};
    const id = chooseMicrophone(mics, preferredId);
    return id === null ? null : {on: true, source_id: id, inventory};
}

// The contract defines mic changes for stopped/failed (next Start), recording,
// paused and recovering; starting/stopping are transient, so wait them out.
const MIC_STATES = ['stopped', 'failed', 'recording', 'paused', 'recovering'];

export function micSwitch(status, running) {
    const mic = status?.mic;
    if (!running || !mic)
        return {sensitive: false, on: false};
    return {
        sensitive: mic.available === true && MIC_STATES.includes(status.state),
        on: mic.on === true,
    };
}

const BUSY = ['starting', 'recording', 'recovering', 'stopping'];

export function pollPeriod(state, menuOpen, fast = 2, slow = 10) {
    const p = menuOpen || BUSY.includes(state) ? fast : slow;
    return Math.max(1, p);
}

// control.json: {"version": 1, "base_url": "http://127.0.0.1:<port>", "token": "..."}.
// Only a loopback http origin is accepted so the token can't be sent anywhere
// else. Error messages never echo file contents (they hold the token).
const BASE_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})\/?$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;

export function parseControlFile(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('control file is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('control file is not an object');
    if (data.version !== 1)
        throw new Error('control file has an unsupported version');
    const m = typeof data.base_url === 'string' ? BASE_RE.exec(data.base_url) : null;
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535)
        throw new Error('control file base_url is not a loopback http URL');
    if (typeof data.token !== 'string' || !TOKEN_RE.test(data.token))
        throw new Error('control file token is malformed');
    return {baseUrl: data.base_url.replace(/\/$/, ''), token: data.token};
}

export function pageUrl(baseUrl, path) {
    return baseUrl.replace(/\/+$/, '') + path;
}

export function lastErrorText(status) {
    if (!status)
        return null;
    if (status.last_error)
        return `Last error: ${status.last_error}${status.reason ? ` (${status.reason})` : ''}`;
    if (status.state === 'failed' && status.reason)
        return `Failed: ${status.reason}`;
    return null;
}

const ERROR_CODES = {
    not_allowed: 'Not allowed in the current state',
    inventory_changed: 'Microphones changed; try again',
    unavailable: 'Microphone capture is not enabled on the server',
    forbidden: 'Control token rejected',
    failed: 'The command failed',
    invalid: 'Request rejected as invalid',
};

// err: a client error ({notRunning, status, code, message}) or any Error.
export function errorText(err) {
    if (err?.notRunning)
        return NOT_RUNNING_TEXT;
    if (err?.code && ERROR_CODES[err.code])
        return ERROR_CODES[err.code];
    if (err?.status)
        return `HTTP ${err.status}`;
    return err?.message ?? String(err);
}

// Everything the indicator renders. status is null when the server is not
// running (no control file, connection refused, ...); pollError is shown
// under the header for other failures (e.g. a rejected token).
export function buildView(status, {running = true, showMic = true, pollError = null} = {}) {
    running = running && !!status;
    const state = running ? status.state : null;
    const mic = micSwitch(status, running);
    return {
        running,
        state,
        panel: panelState(state, running),
        micIndicator: running && showMic && status.mic?.on === true,
        header: running ? headerText(status) : {title: NOT_RUNNING_TEXT, detail: pollError ?? ''},
        actions: allowedActions(state),
        mic,
        intervals: intervalItems(running ? status.interval_seconds : null),
        intervalSensitive: running,
        pagesSensitive: running,
        lastError: running ? lastErrorText(status) : null,
    };
}
