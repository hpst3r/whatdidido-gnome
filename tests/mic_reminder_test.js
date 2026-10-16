// Run: gjs -m tests/mic_reminder_test.js
// Microphone reminder: when it is armed, when the first reminder is due,
// repeats, resets on speech / server restart / another microphone, disarming,
// "Stop reminding", changes of the delay, and the texts.
// Driven by a fake monotonic clock (plain numbers, ms).
import {MINUTE_MS, DEFAULT_MINUTES, MAX_MINUTES} from '../whatdidido@wporter.org/lib/pause_reminder.js';
import {
    MIC_REMINDER_TITLE, micArmed, micReminderBody, MicReminder,
} from '../whatdidido@wporter.org/lib/mic_reminder.js';

let failed = 0;
function eq(name, got, want) {
    const g = String(JSON.stringify(got)), w = String(JSON.stringify(want));
    if (g !== w) {
        failed++;
        print(`FAIL ${name}: got ${g} want ${w}`);
    } else {
        print(`ok   ${name}`);
    }
}

const M = MINUTE_MS;
const NONE = {show: null, withdraw: false};
const WITHDRAW = {show: null, withdraw: true};
const body = (label, minutes) => `No speech transcribed from ${label} for ${minutes} minute${minutes === 1 ? '' : 's'}.`;
const shows = (minutes, label = 'USB headset') => ({show: body(label, minutes), withdraw: false});
// Arbitrary monotonic origin: the clock never starts at 0 in the shell.
const T0 = 7_654_321;

// A recording status with the microphone on and transcription enabled.
function st(withText = 0, {mic = {}, ...rest} = {}) {
    return {
        state: 'recording', waiting_for_unlock: false,
        transcription_enabled: true, transcription_completed: withText + 3, transcription_with_text: withText,
        mic: {available: true, on: true, source_id: 'm2', stable_id: 'alsa_input.usb', label: 'USB headset',
            state: 'capturing', remembered: true, ...mic},
        ...rest,
    };
}
// Drop keys from a status (older servers, transcription off).
function without(status, ...keys) {
    const out = {...status};
    for (const k of keys)
        delete out[k];
    return out;
}

// --- constants and texts ---------------------------------------------------
eq('title', MIC_REMINDER_TITLE, 'Check your microphone');
eq('body singular', micReminderBody('USB headset', M), 'No speech transcribed from USB headset for 1 minute.');
eq('body 119999 ms is still 1 minute', micReminderBody('USB headset', 2 * M - 1), 'No speech transcribed from USB headset for 1 minute.');
eq('body plural', micReminderBody('USB headset', 10 * M + 59999), 'No speech transcribed from USB headset for 10 minutes.');
eq('body without label', [null, undefined, ''].map(l => micReminderBody(l, 3 * M)),
    Array(3).fill('No speech transcribed from the microphone for 3 minutes.'));
eq('body of junk ms is 0 minutes', micReminderBody('X', NaN), 'No speech transcribed from X for 0 minutes.');

// --- armed ------------------------------------------------------------------
eq('armed: recording, mic on, transcription on, counter present', micArmed(st(), 10), true);
eq('armed: counter 0 counts', micArmed(st(0), 10), true);
eq('armed: mic trouble while on still counts',
    ['waiting_for_device', 'retrying', 'pending', undefined].map(s => micArmed(st(0, {mic: {state: s}}), 10)),
    [true, true, true, true]);
eq('not armed: session-wide audio trouble no microphone choice fixes',
    ['limit_reached', 'failed'].map(s => micArmed(st(0, {mic: {state: s}}), 10)), [false, false]);
eq('armed: output monitor off or unknown (older server)',
    [false, undefined].map(o => micArmed(st(0, {audio_output_monitor: o}), 10)), [true, true]);
eq('not armed: output monitor captured (its transcripts count too)',
    micArmed(st(0, {audio_output_monitor: true}), 10), false);
eq('armed: old server mic without stable_id/label/state', micArmed(st(0, {mic: {stable_id: undefined, label: undefined, state: undefined}}), 10), true);
eq('not armed: not running', micArmed(null, 10), false);
eq('not armed: minutes 0', micArmed(st(), 0), false);
eq('not armed: old server (no transcription_with_text)', micArmed(without(st(), 'transcription_with_text'), 10), false);
eq('not armed: transcription disabled (key absent)',
    micArmed(without(st(), 'transcription_with_text', 'transcription_enabled'), 10), false);
eq('not armed: transcription_enabled false even with a counter', micArmed(st(0, {transcription_enabled: false}), 10), false);
eq('not armed: transcription_enabled missing', micArmed(without(st(), 'transcription_enabled'), 10), false);
eq('not armed: counter not an integer', [null, '3', 2.5, NaN].map(n => micArmed(st(0, {transcription_with_text: n}), 10)),
    [false, false, false, false]);
eq('not armed: other states',
    ['paused', 'recovering', 'stopped', 'stopping', 'starting', 'failed', undefined].map(s => micArmed(st(0, {state: s}), 10)),
    [false, false, false, false, false, false, false]);
eq('not armed: waiting for unlock', micArmed(st(0, {waiting_for_unlock: true}), 10), false);
eq('not armed: mic off / unknown', [false, undefined, 'yes'].map(on => micArmed(st(0, {mic: {on}}), 10)), [false, false, false]);
eq('not armed: no mic object', micArmed(without(st(), 'mic'), 10), false);

// --- inert: old server, transcription disabled ---------------------------------
for (const [name, status] of [
    ['old server', without(st(), 'transcription_with_text')],
    ['transcription disabled', without(st(0, {transcription_enabled: false}), 'transcription_with_text')],
]) {
    const r = new MicReminder({minutes: 10});
    const effects = [];
    for (let t = 0; t <= 60; t += 1)
        effects.push(r.observe(status, T0 + t * M));
    effects.push(r.fire(T0 + 61 * M));
    eq(`${name}: never reminds`, effects.every(e => e.show === null && e.withdraw === false), true);
    eq(`${name}: nothing due`, [r.quietSince, r.dueAt], [null, null]);
}

// --- first reminder and repeats -----------------------------------------------
let r = new MicReminder({minutes: 10});
eq('default minutes', new MicReminder().minutes, DEFAULT_MINUTES);
eq('fresh: nothing due', [r.quietSince, r.dueAt, r.fire(T0 + 99 * M)], [null, null, NONE]);
eq('armed observed: no immediate reminder', r.observe(st(4), T0 + 5), NONE);
eq('quietSince = first armed observation', r.quietSince, T0 + 5);
eq('first reminder due after N min', r.dueAt, T0 + 5 + 10 * M);
eq('later polls with the same counter keep quietSince', [r.observe(st(4), T0 + 4 * M), r.quietSince, r.dueAt],
    [NONE, T0 + 5, T0 + 5 + 10 * M]);
eq('fire 1 ms early does nothing', r.fire(T0 + 5 + 10 * M - 1), NONE);
eq('first reminder at quietSince + N', r.fire(T0 + 5 + 10 * M), shows(10));
eq('second due N min after the first reminder', r.dueAt, T0 + 5 + 20 * M);
eq('fire again at the same time does nothing', r.fire(T0 + 5 + 10 * M), NONE);
eq('late second reminder', r.fire(T0 + 5 + 21 * M), shows(21));
eq('third due N min after the late one', r.dueAt, T0 + 5 + 31 * M);
eq('poll when overdue reminds (backup for a missed timer)', r.observe(st(4), T0 + 5 + 45 * M), shows(45));
eq('poll reminder counts as the previous reminder', r.dueAt, T0 + 5 + 55 * M);
// transcription_completed rising alone (empty transcripts) is no speech.
eq('empty transcripts keep counting', [r.observe(st(4, {transcription_completed: 99}), T0 + 5 + 46 * M), r.quietSince],
    [NONE, T0 + 5]);
eq('body uses the latest label', [r.observe(st(4, {mic: {label: 'Renamed'}}), T0 + 5 + 55 * M)], [shows(55, 'Renamed')]);
eq('label disappearing falls back', r.observe(st(4, {mic: {label: null}}), T0 + 5 + 65 * M), shows(65, 'the microphone'));

// --- speech arrives -------------------------------------------------------------
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
eq('speech before any reminder: nothing to withdraw', r.observe(st(5), T0 + 3 * M), NONE);
eq('speech resets quietSince', [r.quietSince, r.dueAt], [T0 + 3 * M, T0 + 13 * M]);
eq('no reminder at the old due time', r.fire(T0 + 10 * M), NONE);
eq('reminder N min after the speech', r.fire(T0 + 13 * M), shows(10));
eq('speech after a reminder withdraws it', r.observe(st(7), T0 + 15 * M), WITHDRAW);
eq('speech after a reminder: counts from the speech', [r.quietSince, r.dueAt], [T0 + 15 * M, T0 + 25 * M]);
eq('next reminder from the speech, not the old reminder', [r.fire(T0 + 23 * M), r.fire(T0 + 25 * M)], [NONE, shows(10)]);

// --- server restarted: the counter went down -------------------------------------
r = new MicReminder({minutes: 10});
r.observe(st(40), T0);
r.fire(T0 + 10 * M);
eq('counter lower withdraws', r.observe(st(0), T0 + 12 * M), WITHDRAW);
eq('counter lower rebaselines', [r.quietSince, r.dueAt], [T0 + 12 * M, T0 + 22 * M]);
eq('the new baseline holds', r.observe(st(0), T0 + 13 * M), NONE);
eq('above the new baseline is speech', [r.observe(st(1), T0 + 14 * M), r.quietSince], [NONE, T0 + 14 * M]);
eq('still below the old value is not speech', [r.observe(st(1), T0 + 15 * M), r.quietSince], [NONE, T0 + 14 * M]);

// --- another microphone -------------------------------------------------------------
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
r.fire(T0 + 10 * M);
eq('other stable_id withdraws', r.observe(st(4, {mic: {stable_id: 'alsa_input.pci', source_id: 'm1', label: 'Built-in'}}), T0 + 11 * M), WITHDRAW);
eq('other stable_id resets', [r.quietSince, r.dueAt], [T0 + 11 * M, T0 + 21 * M]);
eq('reminder names the new microphone', r.fire(T0 + 21 * M), shows(10, 'Built-in'));
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
eq('same stable_id, new source_id (reconnect) keeps counting',
    [r.observe(st(4, {mic: {source_id: 'm9'}}), T0 + 2 * M), r.quietSince], [NONE, T0]);
// Old servers: no stable_id, the source id is the identity.
const old = (sourceId, n = 4) => st(n, {mic: {source_id: sourceId, stable_id: undefined, label: undefined, state: undefined}});
r = new MicReminder({minutes: 10});
r.observe(old('m1'), T0);
eq('no stable_id: same source keeps counting', [r.observe(old('m1'), T0 + M), r.quietSince], [NONE, T0]);
eq('no stable_id: other source resets', [r.observe(old('m2'), T0 + 2 * M), r.quietSince], [NONE, T0 + 2 * M]);
eq('no stable_id: generic body', r.fire(T0 + 12 * M), shows(10, 'the microphone'));
r = new MicReminder({minutes: 10});
r.observe(st(4, {mic: {stable_id: null}}), T0);
eq('stable_id null falls back to source_id', [r.observe(st(4, {mic: {stable_id: null}}), T0 + M), r.quietSince], [NONE, T0]);

// --- disarming -----------------------------------------------------------------------
const DISARM = [
    ['not running', null],
    ['mic off', st(4, {mic: {on: false}})],
    ['paused', st(4, {state: 'paused'})],
    ['recovering', st(4, {state: 'recovering'})],
    ['waiting for unlock', st(4, {waiting_for_unlock: true})],
    ['stopped', st(4, {state: 'stopped'})],
    ['failed', st(4, {state: 'failed'})],
    ['transcription turned off', without(st(4, {transcription_enabled: false}), 'transcription_with_text')],
    ['older server', without(st(4), 'transcription_with_text')],
    ['audio limit reached', st(4, {mic: {state: 'limit_reached'}})],
    ['audio failed', st(4, {mic: {state: 'failed'}})],
    ['output monitor captured', st(4, {audio_output_monitor: true})],
];
for (const [name, status] of DISARM) {
    r = new MicReminder({minutes: 10});
    r.observe(st(4), T0);
    r.fire(T0 + 10 * M);
    eq(`${name}: withdraws a shown reminder`, r.observe(status, T0 + 11 * M), WITHDRAW);
    eq(`${name}: cancels`, [r.quietSince, r.dueAt, r.fire(T0 + 30 * M)], [null, null, NONE]);
    eq(`${name} again: nothing to withdraw`, r.observe(status, T0 + 12 * M), NONE);
    eq(`${name}: armed again counts from then`, [r.observe(st(4), T0 + 13 * M), r.quietSince, r.dueAt],
        [NONE, T0 + 13 * M, T0 + 23 * M]);
}
// Once --max-audio-bytes is reached the server records no audio until a new
// session while mic.on stays true; no microphone choice can help.
r = new MicReminder({minutes: 10});
r.observe(st(4, {mic: {state: 'limit_reached'}}), T0);
eq('limit_reached: no reminder after 10 min', r.observe(st(4, {mic: {state: 'limit_reached'}}), T0 + 10 * M), NONE);
// Speech from a call or video on the output monitor would hide a dead
// microphone, so the reminder stays inert rather than wrong.
r = new MicReminder({minutes: 10});
r.observe(st(4, {audio_output_monitor: true}), T0);
eq('output monitor: no reminder after 10 min', r.observe(st(4, {audio_output_monitor: true}), T0 + 10 * M), NONE);
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
eq('disarm before any reminder withdraws (idempotent in the glue)', r.observe(null, T0 + M), WITHDRAW);
// A pause and resume between polls with no speech: still one quiet stretch.
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
r.observe(st(4, {state: 'paused'}), T0 + 2 * M);
r.observe(st(4), T0 + 3 * M);
eq('pause then recording again restarts the count', [r.quietSince, r.dueAt], [T0 + 3 * M, T0 + 13 * M]);

// --- Stop reminding -----------------------------------------------------------------------
r = new MicReminder({minutes: 10});
eq('suppress while not armed does nothing', r.suppress(), NONE);
r.observe(st(4), T0);
eq('suppress while not armed does not carry over', r.dueAt, T0 + 10 * M);
r.fire(T0 + 10 * M);
eq('suppress withdraws', r.suppress(), WITHDRAW);
eq('suppressed: nothing due', r.dueAt, null);
eq('suppressed: fire does nothing', r.fire(T0 + 100 * M), NONE);
eq('suppressed: overdue polls do nothing', r.observe(st(4), T0 + 100 * M), NONE);
eq('suppressed: N change does nothing', [r.setMinutes(1, T0 + 101 * M), r.dueAt], [NONE, null]);
eq('suppressed: until speech', [r.observe(st(5), T0 + 102 * M), r.quietSince, r.dueAt], [NONE, T0 + 102 * M, T0 + 103 * M]);
eq('after speech: reminds again', r.fire(T0 + 103 * M), shows(1));
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
r.suppress();
r.observe(st(4, {mic: {stable_id: 'other'}}), T0 + M);
eq('another microphone ends the suppression', r.dueAt, T0 + 11 * M);
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
r.suppress();
r.observe(st(2), T0 + M);
eq('a server restart (counter lower) ends the suppression', r.dueAt, T0 + 11 * M);
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
r.suppress();
r.observe(st(4, {mic: {on: false}}), T0 + M);
r.observe(st(4), T0 + 2 * M);
eq('disarming ends the suppression', r.dueAt, T0 + 12 * M);

// --- changing N --------------------------------------------------------------------------
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
eq('N later (before first): no reminder', [r.setMinutes(20, T0 + 3 * M), r.dueAt, r.minutes], [NONE, T0 + 20 * M, 20]);
eq('N shorter but not yet due', [r.setMinutes(5, T0 + 3 * M), r.dueAt], [NONE, T0 + 5 * M]);
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
eq('N shorter and overdue: reminds at once', r.setMinutes(5, T0 + 7 * M), shows(7));
eq('then every N from that reminder', r.dueAt, T0 + 12 * M);
r = new MicReminder({minutes: 10});
r.observe(st(4), T0);
r.fire(T0 + 10 * M);
eq('N later after a reminder: due from the last reminder', [r.setMinutes(30, T0 + 15 * M), r.dueAt], [NONE, T0 + 40 * M]);
eq('N shorter after a reminder, overdue: reminds at once', r.setMinutes(5, T0 + 16 * M), shows(16));
eq('N = 0 withdraws', r.setMinutes(0, T0 + 17 * M), WITHDRAW);
eq('N = 0 cancels', [r.dueAt, r.quietSince, r.fire(T0 + 500 * M)], [null, null, NONE]);
eq('N = 0: polls do nothing', [r.observe(st(4), T0 + 500 * M), r.dueAt], [NONE, null]);
eq('N = 0 again: nothing to withdraw', r.setMinutes(0, T0 + 501 * M), NONE);
eq('N back on: counts from the next poll', [r.setMinutes(10, T0 + 502 * M), r.dueAt], [NONE, null]);
eq('N back on: next poll arms', [r.observe(st(4), T0 + 503 * M), r.dueAt], [NONE, T0 + 513 * M]);
r = new MicReminder({minutes: 0});
eq('off from the start: nothing', [r.observe(st(4), T0), r.dueAt, r.quietSince], [NONE, null, null]);
r = new MicReminder({minutes: 10});
eq('N change while not armed: nothing', [r.setMinutes(3, T0), r.dueAt, r.minutes], [NONE, null, 3]);
eq('N clamped to the schema range', [999, -1, 2.7, NaN].map(n => new MicReminder({minutes: n}).minutes), [MAX_MINUTES, 0, 2, 0]);
r.setMinutes(1000, T0);
eq('setMinutes clamps too', r.minutes, MAX_MINUTES);

if (failed) {
    print(`${failed} failed`);
    (await import('system')).default.exit(1);
}
print('all passed');
