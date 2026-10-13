// Run: gjs -m tests/pause_reminder_test.js
// Pause reminder: when the first reminder is due, repeats, withdrawal on
// leaving "paused", changes of the delay, "Stop reminding", and the texts.
// Driven by a fake monotonic clock (plain numbers, ms).
import {
    MINUTE_MS, DEFAULT_MINUTES, MAX_MINUTES, REMINDER_TITLE,
    wholeMinutes, pausedForText, reminderBody, timerDelay, PauseReminder,
} from '../whatdidido@wporter.org/lib/pause_reminder.js';

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
const TAIL = ". Screenshots, audio and window activity aren't being recorded.";
const shows = minutes => ({show: `Paused for ${minutes === 1 ? '1 minute' : `${minutes} minutes`}${TAIL}`, withdraw: false});
// Arbitrary monotonic origin: the clock never starts at 0 in the shell.
const T0 = 7_654_321;

// --- constants and texts ---------------------------------------------------
eq('constants', [MINUTE_MS, DEFAULT_MINUTES, MAX_MINUTES, REMINDER_TITLE], [60000, 10, 240, 'Recording is paused']);
eq('whole minutes floor', [0, 59999, 60000, 119999, 120000, 12 * M + 5].map(wholeMinutes), [0, 0, 1, 1, 2, 12]);
eq('whole minutes of junk is 0', [-5, NaN, null, undefined].map(wholeMinutes), [0, 0, 0, 0]);
eq('body 1 minute singular', reminderBody(M), `Paused for 1 minute${TAIL}`);
eq('body 119999 ms is still 1 minute', reminderBody(2 * M - 1), `Paused for 1 minute${TAIL}`);
eq('body 2 minutes plural', reminderBody(2 * M), `Paused for 2 minutes${TAIL}`);
eq('body 47 minutes', reminderBody(47 * M + 59999), `Paused for 47 minutes${TAIL}`);
eq('menu text below one minute', [0, 1, 59999].map(pausedForText), ['Paused for <1 min', 'Paused for <1 min', 'Paused for <1 min']);
eq('menu text whole minutes', [M, 12 * M, 12 * M + 59999, 240 * M].map(pausedForText),
    ['Paused for 1 min', 'Paused for 12 min', 'Paused for 12 min', 'Paused for 240 min']);

// --- timer delay for the single GLib timeout ---------------------------------
eq('timer delay none when nothing is due', timerDelay(null, T0), null);
eq('timer delay rounds up', timerDelay(T0 + 1500.2, T0), 1501);
eq('timer delay overdue is 0 (at once)', [timerDelay(T0, T0), timerDelay(T0 - 5 * M, T0)], [0, 0]);

// --- not paused: nothing scheduled --------------------------------------------
let r = new PauseReminder({minutes: 10});
eq('default minutes', new PauseReminder().minutes, DEFAULT_MINUTES);
eq('fresh: nothing due', [r.pausedSince, r.dueAt, r.pausedFor(T0)], [null, null, null]);
eq('recording: nothing due', [r.observe('recording', T0), r.dueAt], [NONE, null]);
eq('not running: nothing due', [r.observe(null, T0), r.dueAt], [NONE, null]);
eq('fire while not paused does nothing', r.fire(T0 + 60 * M), NONE);

// --- first reminder and repeats -----------------------------------------------
r = new PauseReminder({minutes: 10});
r.observe('recording', T0);
eq('pause observed: no immediate reminder', r.observe('paused', T0 + 5), NONE);
eq('pausedSince = first observation', r.pausedSince, T0 + 5);
eq('first reminder due after N min', r.dueAt, T0 + 5 + 10 * M);
eq('pausedFor', r.pausedFor(T0 + 5 + 3 * M), 3 * M);
eq('later paused polls keep pausedSince', [r.observe('paused', T0 + 4 * M), r.pausedSince, r.dueAt],
    [NONE, T0 + 5, T0 + 5 + 10 * M]);
eq('fire 1 ms early does nothing', r.fire(T0 + 5 + 10 * M - 1), NONE);
eq('due time unchanged after early fire', r.dueAt, T0 + 5 + 10 * M);
eq('first reminder at pausedSince + N', r.fire(T0 + 5 + 10 * M), shows(10));
eq('second due N min after the first reminder', r.dueAt, T0 + 5 + 20 * M);
eq('fire again at the same time does nothing', r.fire(T0 + 5 + 10 * M), NONE);
// A late timer (e.g. a busy main loop): the next one counts from when it fired.
eq('late second reminder', r.fire(T0 + 5 + 21 * M), shows(21));
eq('third due N min after the late one', r.dueAt, T0 + 5 + 31 * M);
eq('third reminder', r.fire(T0 + 5 + 31 * M), shows(31));
// The status poll is a backup for a missed timer.
eq('paused poll when overdue reminds', r.observe('paused', T0 + 5 + 45 * M), shows(45));
eq('poll reminder counts as the previous reminder', r.dueAt, T0 + 5 + 55 * M);

// --- leaving paused ---------------------------------------------------------------
for (const next of ['recording', 'stopped', 'stopping', 'failed', 'recovering', 'starting', 'exploded', undefined]) {
    r = new PauseReminder({minutes: 10});
    r.observe('paused', T0);
    r.fire(T0 + 10 * M);
    eq(`leaving paused -> ${next} withdraws`, r.observe(next, T0 + 11 * M), WITHDRAW);
    eq(`leaving paused -> ${next} cancels`, [r.pausedSince, r.dueAt, r.pausedFor(T0 + 11 * M)], [null, null, null]);
}
r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
eq('not running withdraws (before any reminder too)', r.observe(null, T0 + 2 * M), WITHDRAW);
eq('not running cancels', [r.pausedSince, r.dueAt], [null, null]);
eq('fire after not running does nothing', r.fire(T0 + 10 * M), NONE);
eq('not running again: nothing to withdraw', r.observe(null, T0 + 3 * M), NONE);
eq('paused again counts from the new observation', [r.observe('paused', T0 + 4 * M), r.pausedSince, r.dueAt],
    [NONE, T0 + 4 * M, T0 + 14 * M]);
eq('no reminder at the old due time', r.fire(T0 + 10 * M), NONE);
eq('reminder at the new due time', r.fire(T0 + 14 * M), shows(10));

// A resume and pause between two polls is invisible: still one pause.
r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
r.observe('recording', T0 + M);
r.observe('paused', T0 + 2 * M);
eq('pause, resume, pause restarts the count', [r.pausedSince, r.dueAt], [T0 + 2 * M, T0 + 12 * M]);

// --- extension started mid-pause ------------------------------------------------------
r = new PauseReminder({minutes: 10});
eq('start mid-pause: no reminder at once', r.observe('paused', T0 + 99 * M), NONE);
eq('start mid-pause: counts from the first observation', [r.pausedSince, r.dueAt], [T0 + 99 * M, T0 + 109 * M]);
eq('start mid-pause: menu says <1 min', pausedForText(r.pausedFor(T0 + 99 * M + 30000)), 'Paused for <1 min');
eq('start mid-pause: first reminder', r.fire(T0 + 109 * M), shows(10));

// --- changing N while paused ------------------------------------------------------------
r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
eq('N later (before first): no reminder', r.setMinutes(20, T0 + 3 * M), NONE);
eq('N later (before first): due from pausedSince', r.dueAt, T0 + 20 * M);
eq('minutes stored', r.minutes, 20);
eq('N shorter but not yet due', [r.setMinutes(5, T0 + 3 * M), r.dueAt], [NONE, T0 + 5 * M]);

r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
eq('N shorter and overdue: reminds at once', r.setMinutes(5, T0 + 7 * M), shows(7));
eq('then every N from that reminder', r.dueAt, T0 + 12 * M);

r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
r.fire(T0 + 10 * M);
eq('N later after a reminder: no reminder', r.setMinutes(30, T0 + 15 * M), NONE);
eq('N later after a reminder: due from the last reminder', r.dueAt, T0 + 40 * M);
eq('N shorter after a reminder, overdue: reminds at once', r.setMinutes(5, T0 + 16 * M), shows(16));
eq('N shorter after a reminder: next from that one', r.dueAt, T0 + 21 * M);
eq('N exactly due counts as overdue', r.setMinutes(1, T0 + 22 * M), shows(22));

r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
r.fire(T0 + 10 * M);
eq('N = 0 withdraws', r.setMinutes(0, T0 + 12 * M), WITHDRAW);
eq('N = 0 cancels', r.dueAt, null);
eq('N = 0: fire does nothing', r.fire(T0 + 500 * M), NONE);
eq('N = 0: polls do nothing', r.observe('paused', T0 + 500 * M), NONE);
eq('N = 0 keeps pausedSince for the menu', r.pausedSince, T0);
eq('N back on, overdue: reminds at once', r.setMinutes(10, T0 + 501 * M), shows(501));
eq('N back on: next from that one', r.dueAt, T0 + 511 * M);

r = new PauseReminder({minutes: 0});
eq('off from the start: pause schedules nothing', [r.observe('paused', T0), r.dueAt], [NONE, null]);
eq('N = 0 again while paused: withdraw (idempotent in the glue)', r.setMinutes(0, T0 + M), WITHDRAW);
eq('turned on later: due from pausedSince', [r.setMinutes(10, T0 + 2 * M), r.dueAt], [NONE, T0 + 10 * M]);

r = new PauseReminder({minutes: 10});
eq('N change while not paused: nothing', [r.setMinutes(3, T0), r.dueAt, r.minutes], [NONE, null, 3]);
eq('N = 0 while not paused: nothing to withdraw', r.setMinutes(0, T0), NONE);
eq('N clamped to the schema range', [999, -1, 2.7, NaN].map(n => new PauseReminder({minutes: n}).minutes), [240, 0, 2, 0]);
r.setMinutes(1000, T0);
eq('setMinutes clamps too', r.minutes, 240);

// --- Stop reminding ------------------------------------------------------------------------
r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
r.fire(T0 + 10 * M);
eq('suppress withdraws', r.suppress(), WITHDRAW);
eq('suppressed: nothing due', r.dueAt, null);
eq('suppressed: fire does nothing', r.fire(T0 + 100 * M), NONE);
eq('suppressed: overdue polls do nothing', r.observe('paused', T0 + 100 * M), NONE);
eq('suppressed: N change does nothing', [r.setMinutes(1, T0 + 101 * M), r.dueAt], [NONE, null]);
eq('suppressed: menu still counts', r.pausedFor(T0 + 101 * M), 101 * M);
eq('suppressed: leaving paused withdraws/cancels', r.observe('recording', T0 + 102 * M), WITHDRAW);
eq('next pause reminds again', [r.observe('paused', T0 + 103 * M), r.dueAt], [NONE, T0 + 104 * M]);
eq('next pause: reminder', r.fire(T0 + 104 * M), shows(1));
r = new PauseReminder({minutes: 10});
r.observe('paused', T0);
r.suppress();
r.observe(null, T0 + M);
r.observe('paused', T0 + 2 * M);
eq('not running also ends the suppression', r.dueAt, T0 + 12 * M);
r = new PauseReminder({minutes: 10});
eq('suppress while not paused does nothing', r.suppress(), NONE);
r.observe('paused', T0);
eq('suppress while not paused does not carry into the next pause', r.dueAt, T0 + 10 * M);

if (failed) {
    print(`${failed} failed`);
    (await import('system')).default.exit(1);
}
print('all passed');
