// Explicit microphone selection: pure logic (no GI imports), unit-tested with
// plain `gjs -m`. whatdidido RELIABILITY.md section 10 (issue #1): the
// extension never picks a microphone the user did not choose.
//
// A microphone item from GET /control/v1/microphones is {id, label} plus,
// on newer servers, `stable_id` (PipeWire node.name, or null). The id is a
// PipeWire serial that changes whenever the device re-enumerates (dock
// reconnect, suspend); the stable id does not.

export const MIC_KEYS = {stableId: 'microphone-stable-id', id: 'microphone-id', label: 'microphone-label'};
export const CHOOSE_TEXT = 'Choose a microphone';

// mic.state (RELIABILITY.md section 4) that the menu spells out.
const STATE_TEXT = {
    waiting_for_device: 'waiting for device',
    retrying: 'restarting',
    limit_reached: 'limit reached',
    failed: 'failed',
};

const str = v => typeof v === 'string' ? v : '';

// The saved choice: {stableId, id (legacy serial), label}, all strings.
export function preferredMic(p) {
    return {stableId: str(p?.stableId), id: str(p?.id), label: str(p?.label)};
}

export function hasMicChoice(preferred) {
    const p = preferredMic(preferred);
    return !!(p.stableId || p.id);
}

function stableIdOf(m) {
    return typeof m?.stable_id === 'string' && m.stable_id ? m.stable_id : '';
}

// The microphone item matching the saved stable id; else (only when no stable
// id is saved, or the server reports none) the one matching the legacy id;
// else null. Never any other microphone. Several items with the saved stable
// id are ambiguous: null. A legacy id must also keep its saved label, since
// serials restart with PipeWire and may then name another device.
export function chooseMicrophone(mics, preferred) {
    if (!Array.isArray(mics))
        return null;
    const p = preferredMic(preferred);
    const valid = mics.filter(m => m && typeof m.id === 'string' && m.id);
    if (p.stableId && valid.some(m => 'stable_id' in m)) {
        const same = valid.filter(m => stableIdOf(m) === p.stableId);
        return same.length === 1 ? same[0] : null;
    }
    if (!p.id)
        return null;
    return valid.find(m => m.id === p.id && (!p.label || !m.label || m.label === p.label)) ?? null;
}

// Migration on an inventory read: only microphone-id and its label are saved
// and that microphone is present with a stable id -> the stable id to store,
// else null. A half-cleared choice (prefs' Forget writes one key at a time)
// never adopts a stable id again.
export function migrateStableId(mics, preferred) {
    const p = preferredMic(preferred);
    if (p.stableId || !p.id || !p.label)
        return null;
    return stableIdOf(chooseMicrophone(mics, p)) || null;
}

// The source submenu: the checked item is the saved preference, if connected.
export function micSourceItems(mics, preferred) {
    const chosen = chooseMicrophone(mics, preferred);
    return (Array.isArray(mics) ? mics : []).filter(m => m && typeof m.id === 'string' && m.id)
        .map(m => ({id: m.id, stableId: stableIdOf(m), label: m.label || m.id, checked: m === chosen}));
}

// Body for POST /control/v1/mic, or null when the saved choice is not in the inventory.
export function micRequest(on, mics, preferred, inventory) {
    if (!on)
        return {on: false};
    const mic = chooseMicrophone(mics, preferred);
    return mic ? {on: true, source_id: mic.id, inventory} : null;
}

export function missingText(preferred) {
    return `${preferredMic(preferred).label || 'The chosen microphone'} is not connected`;
}

// The microphone the session actually uses: mic.label (newer servers), else
// the inventory item with mic.source_id.
export function activeMicLabel(mic, mics) {
    if (typeof mic?.label === 'string' && mic.label)
        return mic.label;
    if (!mic?.source_id || !Array.isArray(mics))
        return null;
    const m = mics.find(x => x?.id === mic.source_id);
    return m ? m.label || m.id : null;
}

// The switch's label: "Microphone", or the active one and its trouble, e.g.
// "Microphone: USB headset (waiting for device)".
export function micSwitchLabel(status, running, mics) {
    const mic = running ? status?.mic : null;
    if (!mic)
        return 'Microphone';
    const label = mic.on === true ? activeMicLabel(mic, mics) : null;
    const text = label ? `Microphone: ${label}` : 'Microphone';
    const state = STATE_TEXT[mic.state];
    return state ? `${text} (${state})` : text;
}

// The line under the switch while the mic is off: why it cannot be turned
// on. prompt: the user turned it on without a saved choice; missing: the
// client refused the saved choice as not connected.
export function micHint(status, {running = true, mics = null, preferred = {}, prompt = false, missing = false} = {}) {
    const mic = running ? status?.mic : null;
    if (!mic || mic.available !== true || mic.on === true)
        return null;
    if (!hasMicChoice(preferred))
        return prompt ? CHOOSE_TEXT : null;
    if (missing || (Array.isArray(mics) && !chooseMicrophone(mics, preferred)))
        return missingText(preferred);
    return null;
}

// Choosing a source while the session's microphone is on switches it over,
// unless it is the same device (same stable id, else same id).
export function liveSwitchNeeded(liveMic, running, item) {
    if (!running || liveMic?.on !== true)
        return false;
    const live = stableIdOf(liveMic);
    if (live && item.stableId)
        return live !== item.stableId;
    return liveMic.source_id !== item.id;
}

// Session states in which a pick only saves the choice (the switch is
// insensitive then too; model.js MIC_STATES).
const TRANSIENT_STATES = ['starting', 'stopping'];

// The menu's microphone decisions. Only toggle() and choose() (user actions)
// ever call setMicOn; status updates and inventory reads never do. Their
// requests run one after another, and the last intent wins: an on that a
// later off superseded is not sent.
//   settings: {get(key) -> string, set(key, value)} over MIC_KEYS
//   setMicOn(on, preferred, cancellable): ControlClient.setMicOn
//   readStatus(cancellable): ControlClient.status, read before a pick decides
//   openSources(): show the source submenu; changed(): re-render
export class MicController {
    constructor({settings, setMicOn, readStatus, openSources = () => {}, changed = () => {}}) {
        this._settings = settings;
        this._setMicOn = setMicOn;
        this._readStatus = readStatus;
        this._openSources = openSources;
        this._changed = changed;
        this._queue = Promise.resolve();
        this._seq = 0;          // numbers each toggle/choose
        this._lastOff = 0;      // the latest toggle(false)
        this.mics = null;       // last inventory, or null when unknown
        this.status = null;
        this.running = false;
        this.prompt = false;    // "Choose a microphone" until a pick or the menu closes
        this.missing = false;   // the client refused the saved choice as not connected
    }

    get preferred() {
        return preferredMic({
            stableId: this._settings.get(MIC_KEYS.stableId),
            id: this._settings.get(MIC_KEYS.id),
            label: this._settings.get(MIC_KEYS.label),
        });
    }

    setInventory(mics) {
        this.mics = Array.isArray(mics) ? mics : null;
        const stableId = migrateStableId(this.mics, this.preferred);
        if (stableId)
            this._settings.set(MIC_KEYS.stableId, stableId);
        if (this.mics && chooseMicrophone(this.mics, this.preferred))
            this.missing = false;
        this._changed();
    }

    updateStatus(status, running) {
        this.status = status;
        this.running = running;
        if (running && status?.mic?.on === true)
            this.prompt = this.missing = false;
    }

    menuClosed() {
        this.prompt = false;
    }

    // Runs fn once every earlier request has finished.
    _serial(fn) {
        const run = this._queue.then(fn);
        this._queue = run.catch(() => {});
        return run;
    }

    _intent(on) {
        const seq = ++this._seq;
        if (!on)
            this._lastOff = seq;
        return seq;
    }

    // The switch. Resolves to 'choose' (no saved choice: nothing sent),
    // 'missing' (saved choice not connected: nothing sent), 'superseded' (a
    // later off came first: nothing sent), 'on' or 'off'. Other failures
    // reject (shown as the menu's notice).
    async toggle(on, cancellable) {
        const seq = this._intent(on);
        this.missing = false;
        if (on && !hasMicChoice(this.preferred)) {
            this.prompt = true;
            this._changed();
            this._openSources();
            return 'choose';
        }
        this.prompt = false;
        return this._serial(() => this._send(on, seq, cancellable));
    }

    async _send(on, seq, cancellable) {
        if (on && this._lastOff > seq)
            return 'superseded';
        try {
            await this._setMicOn(on, this.preferred, cancellable);
        } catch (e) {
            if (e?.code !== 'microphone_missing')
                throw e;
            if (Array.isArray(e.microphones))
                this.mics = e.microphones;
            this.missing = true;
            this._changed();
            return 'missing';
        }
        return on ? 'on' : 'off';
    }

    // A source picked in the submenu: save it; turn the mic on when the user
    // was asked to choose, or switch a live microphone to another device.
    // Decided from a fresh status (the last poll may predate a change on the
    // session page); while starting or stopping it only saves.
    async choose(item, cancellable) {
        const seq = this._intent(true);
        const prompt = this.prompt;
        this._settings.set(MIC_KEYS.stableId, str(item.stableId));
        this._settings.set(MIC_KEYS.label, str(item.label));
        this._settings.set(MIC_KEYS.id, str(item.id));
        this.prompt = this.missing = false;
        this._changed();
        return this._serial(async () => {
            if (this._lastOff > seq)
                return 'saved';
            const status = await this._readStatus(cancellable);
            this.updateStatus(status, true);
            if (TRANSIENT_STATES.includes(status?.state))
                return 'saved';
            if (!prompt && !liveSwitchNeeded(status?.mic, true, item))
                return 'saved';
            return this._send(true, seq, cancellable);
        });
    }

    view() {
        const preferred = this.preferred;
        return {
            switchLabel: micSwitchLabel(this.status, this.running, this.mics),
            hint: micHint(this.status, {running: this.running, mics: this.mics, preferred, prompt: this.prompt, missing: this.missing}),
            sources: micSourceItems(this.mics, preferred),
        };
    }
}
