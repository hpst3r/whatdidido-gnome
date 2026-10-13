// Pause reminder: pure logic, no GI imports, so it runs under plain `gjs -m`
// tests. The extension feeds it every status poll and arms one GLib timeout
// for dueAt; it shows/withdraws the notification as the returned effects say.

export const MINUTE_MS = 60000;
export const DEFAULT_MINUTES = 10;
export const MAX_MINUTES = 240;   // the schema's range for pause-reminder-minutes
export const REMINDER_TITLE = 'Recording is paused';

export function wholeMinutes(ms) {
    return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / MINUTE_MS) : 0;
}

// The menu's header detail while paused.
export function pausedForText(ms) {
    const minutes = wholeMinutes(ms);
    return minutes < 1 ? 'Paused for <1 min' : `Paused for ${minutes} min`;
}

export function reminderBody(ms) {
    const minutes = wholeMinutes(ms);
    return `Paused for ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
        "Screenshots, audio and window activity aren't being recorded.";
}

// Milliseconds for the GLib timeout (0 = at once), or null for no timeout.
export function timerDelay(dueAt, now) {
    return dueAt === null ? null : Math.max(0, Math.ceil(dueAt - now));
}

function clampMinutes(n) {
    return Number.isFinite(n) ? Math.min(MAX_MINUTES, Math.max(0, Math.floor(n))) : 0;
}

const NONE = Object.freeze({show: null, withdraw: false});
const WITHDRAW = Object.freeze({show: null, withdraw: true});

// Reminds while the work session stays paused.
//
// - pausedSince is when "paused" was first observed after anything else
//   (another state, not running, or a fresh start). The server reports no
//   paused-since time, so a pause that began before the extension started
//   counts from the first poll that saw it.
// - The first reminder is due at pausedSince + minutes, each later one
//   minutes after the previous reminder (the time it was actually shown).
// - Leaving "paused" (any other state, or not running) cancels everything and
//   withdraws a shown reminder.
// - setMinutes() while paused recomputes from pausedSince / the last
//   reminder; already overdue reminds at once; 0 cancels and withdraws.
// - suppress() ("Stop reminding") stops reminders until "paused" is left.
//
// Times are ms on a monotonic clock passed in by the caller. Every call
// returns an effect: {show: body text or null, withdraw: bool}. show means
// "replace any shown reminder with this one"; withdraw is idempotent.
export class PauseReminder {
    constructor({minutes = DEFAULT_MINUTES} = {}) {
        this._minutes = clampMinutes(minutes);
        this._pausedSince = null;
        this._lastReminder = null;
        this._suppressed = false;
    }

    get minutes() {
        return this._minutes;
    }

    get pausedSince() {
        return this._pausedSince;
    }

    // When the next reminder is due, or null when none is.
    get dueAt() {
        if (this._pausedSince === null || this._minutes === 0 || this._suppressed)
            return null;
        return (this._lastReminder ?? this._pausedSince) + this._minutes * MINUTE_MS;
    }

    pausedFor(now) {
        return this._pausedSince === null ? null : now - this._pausedSince;
    }

    // state: the polled status.state; null when the server is not running.
    observe(state, now) {
        if (state !== 'paused') {
            if (this._pausedSince === null)
                return NONE;
            this._pausedSince = null;
            this._lastReminder = null;
            this._suppressed = false;
            return WITHDRAW;
        }
        if (this._pausedSince === null) {
            this._pausedSince = now;
            return NONE;
        }
        // Normally the timer fires first; this catches a missed one.
        return this.fire(now);
    }

    setMinutes(minutes, now) {
        this._minutes = clampMinutes(minutes);
        if (this._pausedSince === null)
            return NONE;
        if (this._minutes === 0)
            return WITHDRAW;
        return this.fire(now);
    }

    fire(now) {
        const due = this.dueAt;
        if (due === null || now < due)
            return NONE;
        this._lastReminder = now;
        return {show: reminderBody(now - this._pausedSince), withdraw: false};
    }

    suppress() {
        if (this._pausedSince === null)
            return NONE;
        this._suppressed = true;
        return WITHDRAW;
    }
}
