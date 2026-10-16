// Microphone reminder: pure logic, no GI imports, so it runs under plain
// `gjs -m` tests. The extension feeds it every status poll and arms one GLib
// timeout for dueAt; it shows/withdraws the notification as the returned
// effects say. A wrong or dead microphone shows up as transcripts that keep
// arriving but are all empty: transcription_with_text stops going up.

import {DEFAULT_MINUTES, MAX_MINUTES, MINUTE_MS, wholeMinutes} from './pause_reminder.js';

export const MIC_REMINDER_TITLE = 'Check your microphone';

export function micReminderBody(label, ms) {
    const minutes = wholeMinutes(ms);
    const name = typeof label === 'string' && label ? label : 'the microphone';
    return `No speech transcribed from ${name} for ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

// Whether quiet time counts: recording with the microphone on and a server
// that reports transcriptions with text. Old servers and transcription off
// omit the counter. A microphone that is on but waiting for its device,
// retrying or pending still counts: that is a microphone problem too. Audio
// limit_reached or failed does not: those stop audio for the whole session
// and no microphone choice fixes them. Nor does a captured output monitor:
// the counter counts its transcripts too, so speech from a call or video
// would hide a dead microphone (inert is better than wrong).
// status: the polled status; null when the server is not running.
const SESSION_AUDIO_TROUBLE = new Set(['limit_reached', 'failed']);

export function micArmed(status, minutes) {
    return minutes > 0 &&
        status?.state === 'recording' &&
        status.waiting_for_unlock !== true &&
        status.mic?.on === true &&
        !SESSION_AUDIO_TROUBLE.has(status.mic.state) &&
        status.audio_output_monitor !== true &&
        status.transcription_enabled === true &&
        Number.isInteger(status.transcription_with_text);
}

function micIdentity(mic) {
    return mic.stable_id ?? mic.source_id ?? null;
}

function clampMinutes(n) {
    return Number.isFinite(n) ? Math.min(MAX_MINUTES, Math.max(0, Math.floor(n))) : 0;
}

const NONE = Object.freeze({show: null, withdraw: false});
const WITHDRAW = Object.freeze({show: null, withdraw: true});

// Reminds while the microphone is on and nothing it heard was transcribed
// to text.
//
// - quietSince is the first armed observation (see micArmed). It starts over
//   at the poll that sees transcription_with_text go up (speech), go down
//   (the server restarted: the new value is the baseline) or another
//   microphone (stable_id, else source_id); that withdraws a shown reminder
//   and ends "Stop reminding".
// - The first reminder is due at quietSince + minutes, each later one
//   minutes after the previous reminder (the time it was actually shown).
// - Not armed (another state, microphone off, audio limit reached or failed,
//   output monitor captured, not running, older server, transcription off,
//   minutes 0) cancels everything and withdraws.
// - setMinutes() while armed recomputes from quietSince / the last reminder;
//   already overdue reminds at once; 0 cancels and withdraws, and turning it
//   back on counts from the next poll.
// - suppress() ("Stop reminding") stops reminders until quietSince starts
//   over or the reminder disarms.
//
// Times are ms on a monotonic clock passed in by the caller. Every call
// returns an effect: {show: body text or null, withdraw: bool}. show means
// "replace any shown reminder with this one"; withdraw is idempotent.
export class MicReminder {
    constructor({minutes = DEFAULT_MINUTES} = {}) {
        this._minutes = clampMinutes(minutes);
        this._clear();
    }

    _clear() {
        this._quietSince = null;
        this._withText = null;
        this._micId = null;
        this._label = null;
        this._lastReminder = null;
        this._shown = false;
        this._suppressed = false;
    }

    get minutes() {
        return this._minutes;
    }

    get quietSince() {
        return this._quietSince;
    }

    // When the next reminder is due, or null when none is.
    get dueAt() {
        if (this._quietSince === null || this._minutes === 0 || this._suppressed)
            return null;
        return (this._lastReminder ?? this._quietSince) + this._minutes * MINUTE_MS;
    }

    // status: the polled status; null when the server is not running.
    observe(status, now) {
        if (!micArmed(status, this._minutes)) {
            if (this._quietSince === null)
                return NONE;
            this._clear();
            return WITHDRAW;
        }
        const withText = status.transcription_with_text;
        const micId = micIdentity(status.mic);
        this._label = status.mic.label;
        if (this._quietSince === null || withText !== this._withText || micId !== this._micId) {
            const shown = this._shown;
            this._quietSince = now;
            this._withText = withText;
            this._micId = micId;
            this._lastReminder = null;
            this._shown = false;
            this._suppressed = false;
            return shown ? WITHDRAW : NONE;
        }
        // Normally the timer fires first; this catches a missed one.
        return this.fire(now);
    }

    setMinutes(minutes, now) {
        this._minutes = clampMinutes(minutes);
        if (this._quietSince === null)
            return NONE;
        if (this._minutes === 0) {
            this._clear();
            return WITHDRAW;
        }
        return this.fire(now);
    }

    fire(now) {
        const due = this.dueAt;
        if (due === null || now < due)
            return NONE;
        this._lastReminder = now;
        this._shown = true;
        return {show: micReminderBody(this._label, now - this._quietSince), withdraw: false};
    }

    suppress() {
        if (this._quietSince === null)
            return NONE;
        this._suppressed = true;
        this._shown = false;
        return WITHDRAW;
    }
}
