// Output monitor capture (whatdidido CONTROL_API.md Amendment 5): pure logic
// (no GI imports), unit-tested with plain `gjs -m`. The output role works like
// the microphone (mic_model.js): an output item from GET /control/v1/outputs
// is {id, label, stable_id}, the saved choice is found again by its stable id,
// and the extension never records an output the user did not choose.
//
// What differs is consent: every user action that turns output capture on
// from off first asks "Everyone has agreed" in a modal dialog (the session
// page's consent box), and only then is `consent: true` sent. Switching a live
// output to another one does not ask again, and polling or a remembered
// output (--remember-output) never asks and never sends anything.

import {
    STATE_TEXT, activeMicLabel, chooseMicrophone, hasMicChoice, liveSwitchNeeded, micSourceItems, migrateStableId,
    preferredMic,
} from './mic_model.js';
import {errorText} from './model.js';

export const OUTPUT_KEYS = {stableId: 'output-stable-id', id: 'output-id', label: 'output-label'};
export const OUTPUT_CHOOSE_TEXT = 'Choose an output';

// The consent dialog; the body is the session page's warning, word for word.
export const CONSENT_TITLE = 'Record the output?';
export const CONSENT_BODY = 'Output capture records everything this computer plays through the selected output, ' +
    "including other people's voices in calls and meetings. Enable it only when everyone being recorded has agreed.";
export const CONSENT_CANCEL = 'Cancel';
export const CONSENT_CONFIRM = 'Everyone has agreed — record';

// Feature detection: every output control exists only while the session
// reports `output.available === true`. An older server has no `output` key
// (and a server without --allow-audio-capture none either).
export function outputOffered(status, running) {
    return !!running && status?.output?.available === true;
}

// The saved choice resolves exactly like a microphone's: by stable id, else
// (no stable id known) by the legacy id with its label; never another output.
export const chooseOutput = chooseMicrophone;
export const outputSourceItems = micSourceItems;
export const activeOutputLabel = activeMicLabel;

// Body for POST /control/v1/output, or null when the saved choice is not in
// the inventory. `consent: true` only ever goes with on.
export function outputRequest(on, outputs, preferred, inventory) {
    if (!on)
        return {on: false};
    const output = chooseOutput(outputs, preferred);
    return output ? {on: true, source_id: output.id, inventory, consent: true} : null;
}

export function outputMissingText(preferred) {
    return `${preferredMic(preferred).label || 'The chosen output'} is not connected`;
}

// "(waiting for device)" and the like, after the output's label.
export function outputTrouble(output) {
    const text = STATE_TEXT[output?.state];
    return text ? ` (${text})` : '';
}

// The notice while the output is off: why it cannot be turned on.
export function outputHint(status, {running = true, outputs = null, preferred = {}, prompt = false, missing = false} = {}) {
    if (!outputOffered(status, running) || status.output.on === true)
        return null;
    if (!hasMicChoice(preferred))
        return prompt ? OUTPUT_CHOOSE_TEXT : null;
    if (missing || (Array.isArray(outputs) && !chooseOutput(outputs, preferred)))
        return outputMissingText(preferred);
    return null;
}

// Session states in which a pick only saves the choice (model.js MIC_STATES).
const TRANSIENT_STATES = ['starting', 'stopping'];

// What picking an output in the list does, from a fresh status:
//   'ask'    it turns the output on from off (the tile asked to choose): the
//            consent dialog first;
//   'switch' the output is on and this is another one: switch, no dialog;
//   'save'   only save the choice (off and not asked, the live one again,
//            starting or stopping, or no output offered).
export function chooseAction(status, prompt, item) {
    const output = status?.output;
    if (output?.available !== true || TRANSIENT_STATES.includes(status?.state))
        return 'save';
    if (output.on === true)
        return liveSwitchNeeded(output, true, item) ? 'switch' : 'save';
    return prompt ? 'ask' : 'save';
}

const ERROR_CODES = {
    unavailable: 'Output capture is not enabled on the server',
    inventory_changed: 'Outputs changed; try again',
    output_unset: OUTPUT_CHOOSE_TEXT,
};

// The notice for a failed output request; the server's codes are the
// microphone's, so name the output where errorText names the microphone.
export function outputErrorText(err) {
    if (err?.code === 'output_missing' && err.message)
        return err.message;
    if (err?.code && ERROR_CODES[err.code])
        return ERROR_CODES[err.code];
    return errorText(err);
}

// The menu's output decisions, like MicController. Only toggle() and choose()
// (user actions) ever call setOutputOn; status updates and inventory reads
// never do, and never ask. Requests run one after another and the last
// intent wins.
//   settings: {get(key) -> string, set(key, value)} over OUTPUT_KEYS
//   setOutputOn(on, preferred, cancellable): ControlClient.setOutputOn
//   readStatus(cancellable): ControlClient.status, read before a pick decides
//   confirm(): the consent dialog; resolves true only for "Everyone has agreed"
//   openSources(): show the output list; changed(): re-render
export class OutputController {
    constructor({settings, setOutputOn, readStatus, confirm, openSources = () => {}, changed = () => {}}) {
        this._settings = settings;
        this._setOutputOn = setOutputOn;
        this._readStatus = readStatus;
        this._confirm = confirm;
        this._openSources = openSources;
        this._changed = changed;
        this._queue = Promise.resolve();
        this._seq = 0;          // numbers each toggle/choose
        this._lastOff = 0;      // the latest toggle(false)
        this.outputs = null;    // last inventory, or null when unknown
        this.status = null;
        this.running = false;
        this.prompt = false;    // "Choose an output" until a pick or the menu closes
        this.missing = false;   // the client refused the saved choice as not connected
    }

    get preferred() {
        return preferredMic({
            stableId: this._settings.get(OUTPUT_KEYS.stableId),
            id: this._settings.get(OUTPUT_KEYS.id),
            label: this._settings.get(OUTPUT_KEYS.label),
        });
    }

    setInventory(outputs) {
        this.outputs = Array.isArray(outputs) ? outputs : null;
        const stableId = migrateStableId(this.outputs, this.preferred);
        if (stableId)
            this._settings.set(OUTPUT_KEYS.stableId, stableId);
        if (this.outputs && chooseOutput(this.outputs, this.preferred))
            this.missing = false;
        this._changed();
    }

    updateStatus(status, running) {
        this.status = status;
        this.running = running;
        if (running && status?.output?.on === true)
            this.prompt = this.missing = false;
    }

    menuClosed() {
        this.prompt = false;
    }

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

    // The consent dialog for one turn-on. False when a later off came first
    // (not asked), on Cancel, or when the dialog went away unanswered.
    async _agreed(seq) {
        if (this._lastOff > seq)
            return false;
        try {
            return await this._confirm() === true;
        } catch {
            return false;
        }
    }

    _refused(seq) {
        return this._lastOff > seq ? 'superseded' : 'cancelled';
    }

    // The tile. Resolves to 'choose' (no saved choice: nothing asked or
    // sent), 'cancelled' (the dialog was not confirmed: nothing sent),
    // 'missing', 'superseded', 'on' or 'off'. Other failures reject.
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
        return this._serial(async () => {
            if (on && !await this._agreed(seq))
                return this._refused(seq);
            return this._send(on, seq, cancellable);
        });
    }

    async _send(on, seq, cancellable) {
        if (on && this._lastOff > seq)
            return 'superseded';
        try {
            await this._setOutputOn(on, this.preferred, cancellable);
        } catch (e) {
            if (e?.code !== 'output_missing')
                throw e;
            if (Array.isArray(e.outputs))
                this.outputs = e.outputs;
            this.missing = true;
            this._changed();
            return 'missing';
        }
        return on ? 'on' : 'off';
    }

    // An output picked in the list: save it (stable id first, like the
    // microphone), then do what chooseAction decides from a fresh status.
    async choose(item, cancellable) {
        const seq = this._intent(true);
        const prompt = this.prompt;
        this._settings.set(OUTPUT_KEYS.stableId, typeof item.stableId === 'string' ? item.stableId : '');
        this._settings.set(OUTPUT_KEYS.label, typeof item.label === 'string' ? item.label : '');
        this._settings.set(OUTPUT_KEYS.id, typeof item.id === 'string' ? item.id : '');
        this.prompt = this.missing = false;
        this._changed();
        return this._serial(async () => {
            if (this._lastOff > seq)
                return 'saved';
            const status = await this._readStatus(cancellable);
            this.updateStatus(status, true);
            const action = chooseAction(status, prompt, item);
            if (action === 'save')
                return 'saved';
            if (action === 'ask' && !await this._agreed(seq))
                return this._refused(seq);
            return this._send(true, seq, cancellable);
        });
    }

    view() {
        const preferred = this.preferred;
        return {
            hint: outputHint(this.status, {running: this.running, outputs: this.outputs, preferred, prompt: this.prompt, missing: this.missing}),
            sources: outputSourceItems(this.outputs, preferred),
        };
    }
}
