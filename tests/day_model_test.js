// Run: gjs -m tests/day_model_test.js
// Includes the whatdidido app's own expectations for these helpers
// (frontend/src/lib/core/core.test.ts), on a synthetic day.
import {
    DATA_COLORS, NEUTRAL_COLORS,
    appBaseFromLocation, appInitials, appRoute, clockTime, currentStretch, hhmm, lastEntry, lastFocus,
    localDate, normalizeTicket, paletteSlot, parseAppUrlSetting, sparkBuckets, ticketColor,
} from '../whatdidido@wporter.org/lib/day_model.js';
import {sampleDay} from './fake_app.js';

let failed = 0;
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) {
        failed++;
        print(`FAIL ${name}: got ${g} want ${w}`);
    } else {
        print(`ok   ${name}`);
    }
}

const at = hm => `2026-10-15T${hm}:00.000Z`;
const T = hm => Date.parse(at(hm));

// --- currentStretch -----------------------------------------------------------------
const d = sampleDay();
eq('stretch: the live active run', currentStretch(d), d.unassigned[2]);
eq('stretch: ends at now (app test)', currentStretch(d).end, d.now);
eq('stretch: idle counts', currentStretch({...d, unassigned: [{...d.unassigned[2], state: 'idle'}]})?.state, 'idle');
eq('stretch: locked tail looks further back', currentStretch({...d, unassigned: [
    {start: at('14:40'), end: at('15:09'), state: 'active'},
    {start: at('15:09'), end: at('15:10'), state: 'locked'},
]})?.end, at('15:09'));
eq('stretch: ended more than the slack ago', currentStretch({...d, now: at('15:12')}), null);
eq('stretch: within the slack', currentStretch({...d, now: at('15:11')})?.end, at('15:10'));
eq('stretch: custom slack', currentStretch({...d, now: at('15:12')}, 3 * 60000)?.end, at('15:10'));
eq('stretch: a paused tail is not assignable', currentStretch({...d, unassigned: d.unassigned.slice(0, 1), now: at('14:20')}), null);
eq('stretch: none once the tail is assigned (app test)', currentStretch({...d, unassigned: d.unassigned.slice(0, 2)}), null);
eq('stretch: empty', currentStretch({...d, unassigned: []}), null);

// --- lastEntry / lastFocus ----------------------------------------------------------
eq('lastEntry: the only one', lastEntry(d).assignment.ticket, '#4101');
const later = {...d.entries[0], assignment: {...d.entries[0].assignment, ticket: '#4102'}, clip_start: at('14:40'), clip_end: at('15:00')};
eq('lastEntry: the one ending last, whatever the order', lastEntry({...d, entries: [later, d.entries[0]]}).assignment.ticket, '#4102');
eq('lastEntry: the one ending last, other order', lastEntry({...d, entries: [d.entries[0], later]}).assignment.ticket, '#4102');
eq('lastEntry: none', lastEntry({...d, entries: []}), null);
eq('lastFocus: the latest segment with a window (app test)', lastFocus(d).window.app_name, 'Ptyxis Terminal');
eq('lastFocus: skips segments without a window', lastFocus({...d, segments: d.segments.slice(0, 4)}).window.app_name, 'Text Editor');
eq('lastFocus: none', lastFocus({...d, segments: d.segments.slice(2, 4)}), null);

// --- sparkBuckets -------------------------------------------------------------------
const b = sparkBuckets(d);
eq('buckets: 13:00 .. 15:00, 15 minutes each (app test)', b.map(x => x.end - x.start === 15 * 60000), Array(9).fill(true));
eq('buckets: starts', b.map(x => x.start), ['13:00', '13:15', '13:30', '13:45', '14:00', '14:15', '14:30', '14:45', '15:00'].map(T));
eq('buckets: dominant states (locked and paused, app test)', b.map(x => x.state),
    ['active', 'active', 'active', 'active', 'paused', 'locked', 'locked', 'active', 'active']);
eq('buckets: tickets by the entry covering the middle', b.map(x => x.ticket),
    ['#4101', '#4101', '#4101', '#4101', null, null, null, null, null]);
eq('buckets: active share', b.map(x => Math.round(x.active * 100)), [100, 100, 100, 100, 0, 0, 33, 100, 67]);
eq('buckets: no span', sparkBuckets({...d, span: null}), []);
eq('buckets: span floored to the bucket', sparkBuckets({...d, span: {start: at('13:07'), end: d.span.end}})[0].start, T('13:00'));
eq('buckets: up to now when the span runs past it', sparkBuckets({...d, now: at('13:20')}).length, 2);
eq('buckets: empty buckets left out', sparkBuckets({...d, segments: [d.segments[0], d.segments[4]]}).map(x => x.start),
    ['13:00', '13:15', '13:30', '14:30', '14:45', '15:00'].map(T));
const touching = [{start: at('13:00'), end: at('13:45'), state: 'active', window: null}, {start: at('14:30'), end: at('15:10'), state: 'idle', window: null}];
eq('buckets: a segment touching a bucket edge does not count', sparkBuckets({...d, segments: touching}).map(x => [x.start, x.state]),
    [['13:00', 'active'], ['13:15', 'active'], ['13:30', 'active'], ['14:30', 'idle'], ['14:45', 'idle'], ['15:00', 'idle']].map(([t, s]) => [T(t), s]));
eq('buckets: 30-minute buckets', sparkBuckets(d, 30).length, 5);
const empty = {...d.entries[0], assignment: {...d.entries[0].assignment, ticket: ''}};
eq('buckets: an entry without ticket is ""', sparkBuckets({...d, entries: [empty]})[0].ticket, '');

// --- appInitials (app tests) ---------------------------------------------------------
eq('initials: two words', appInitials('ConnectWise Manage'), 'CM');
eq('initials: one word', appInitials('firefox'), 'Fi');
eq('initials: empty', appInitials(''), '?');
eq('initials: separators', appInitials('org.gnome_text-editor'), 'OG');
eq('initials: one letter', appInitials('x'), 'X');

// --- palette (app tests) -------------------------------------------------------------
eq('normalize', normalizeTicket(' #20591 '), '20591');
eq('slot ignores spelling', paletteSlot('#20591'), paletteSlot('20591'));
eq('slots in range', Array.from({length: 500}, (_, i) => paletteSlot(`T-${i}`)).every(s => s >= 0 && s < 8), true);
eq('spread over the palette', new Set(Array.from({length: 64}, (_, i) => paletteSlot(`#${20000 + i}`))).size, 8);
// Pinned from the app's own palette.ts (run under node), so a port mistake
// in the hash shows.
eq('slot pinned values', ['#4101', '#4102', '#4207', 'abc', ''].map(paletteSlot), [1, 7, 4, 4, 3]);
eq('ticketColor: empty is neutral (light)', ticketColor('', 'light'), NEUTRAL_COLORS.light);
eq('ticketColor: null is neutral (dark)', ticketColor(null, 'dark'), '#9a9996');
eq('ticketColor: "#" alone is neutral', ticketColor(' # ', 'dark'), '#9a9996');
eq('ticketColor: light slot', ticketColor('#4101', 'light'), DATA_COLORS.light[paletteSlot('#4101')]);
eq('ticketColor: dark slot', ticketColor('#4101', 'dark'), DATA_COLORS.dark[paletteSlot('#4101')]);
eq('ticketColor: GNOME tokens', [DATA_COLORS.light[5], DATA_COLORS.dark[5]], ['#3584e4', '#62a0ea']);
eq('ticketColor: unknown variant is light', ticketColor('#4101', 'x'), ticketColor('#4101', 'light'));

// --- clockTime / hhmm ----------------------------------------------------------------
eq('clock: 12h in the zone (app test)', clockTime(Date.parse('2026-10-15T21:14:00Z'), 'America/New_York', false), '5:14 PM');
eq('clock: no no-break spaces', /[\u202f\u00a0]/.test(clockTime(Date.parse('2026-10-15T21:14:00Z'), 'America/New_York')), false);
eq('clock: 24h', clockTime(Date.parse('2026-10-15T21:14:00Z'), 'America/New_York', true), '17:14');
eq('clock: 24h midnight', clockTime(Date.parse('2026-10-15T04:05:00Z'), 'America/New_York', true), '00:05');
eq('clock: 12h midnight', clockTime(Date.parse('2026-10-15T04:05:00Z'), 'America/New_York', false), '12:05 AM');
eq('clock: another zone', clockTime(Date.parse('2026-10-15T21:14:00Z'), 'Asia/Tokyo', false), '6:14 AM');
eq('clock: ISO input', clockTime('2026-10-15T21:14:00Z', 'America/New_York'), '5:14 PM');
eq('clock: bad zone falls back to local', clockTime(T('13:00'), 'Nope/Zone', true), hhmm(T('13:00'), undefined));
eq('hhmm: zero-padded 24h', hhmm(Date.parse('2026-10-15T13:05:00Z'), 'America/New_York'), '09:05');
eq('hhmm: midnight', hhmm(Date.parse('2026-10-15T04:00:00Z'), 'America/New_York'), '00:00');
eq('localDate', localDate(new Date(2026, 9, 5, 23, 59).getTime()), '2026-10-05');

// --- appRoute (the app's formatHash) -------------------------------------------------
eq('route: no params', appRoute('today'), '#/today');
eq('route: empty values dropped (app test)', appRoute('today', {date: ''}), '#/today');
eq('route: timeline', appRoute('timeline', {date: '2026-10-15', t: '10:45'}), '#/timeline?date=2026-10-15&t=10%3A45');
eq('route: PHI', appRoute('timeline', {date: '2026-10-15', phi: '1'}), '#/timeline?date=2026-10-15&phi=1');
eq('route: form encoding like URLSearchParams', appRoute('search', {q: "dpd retry & more (it's)~*"}),
    '#/search?q=dpd+retry+%26+more+%28it%27s%29%7E*');
eq('route: unicode', appRoute('search', {q: 'café'}), '#/search?q=caf%C3%A9');

// --- appBaseFromLocation (POPOVER.md 3.1) -------------------------------------------
const CB = 'http://127.0.0.1:18850';
eq('location: absolute loopback 307', appBaseFromLocation(CB, 307, 'http://127.0.0.1:18851/app/#/today'), 'http://127.0.0.1:18851');
eq('location: 303', appBaseFromLocation(CB, 303, 'http://127.0.0.1:18851/app/'), 'http://127.0.0.1:18851');
eq('location: 302 any path', appBaseFromLocation(CB, 302, 'http://127.0.0.1:18851/elsewhere?x=1'), 'http://127.0.0.1:18851');
eq('location: origin only', appBaseFromLocation(CB, 307, 'http://127.0.0.1:18851'), 'http://127.0.0.1:18851');
eq('location: IPv6 loopback', appBaseFromLocation(CB, 307, 'http://[::1]:18851/app/'), 'http://[::1]:18851');
eq('location: relative /app/', appBaseFromLocation(CB, 307, '/app/#/today'), CB);
eq('location: relative /app/ with a trailing-slash base', appBaseFromLocation(`${CB}/`, 302, '/app/'), CB);
eq('location: relative other path', appBaseFromLocation(CB, 307, '/day/'), null);
eq('location: relative /app without slash', appBaseFromLocation(CB, 307, '/app'), null);
eq('location: protocol-relative', appBaseFromLocation(CB, 307, '//127.0.0.1:18851/app/'), null);
eq('location: non-loopback host', appBaseFromLocation(CB, 307, 'http://example.com:18851/app/'), null);
eq('location: localhost name', appBaseFromLocation(CB, 307, 'http://localhost:18851/app/'), null);
eq('location: other 127/8 address', appBaseFromLocation(CB, 307, 'http://127.0.0.2:18851/app/'), null);
eq('location: https', appBaseFromLocation(CB, 307, 'https://127.0.0.1:18851/app/'), null);
eq('location: userinfo', appBaseFromLocation(CB, 307, 'http://u:p@127.0.0.1:18851/app/'), null);
eq('location: userinfo-looking host', appBaseFromLocation(CB, 307, 'http://127.0.0.1:18851@example.com/app/'), null);
eq('location: no port', appBaseFromLocation(CB, 307, 'http://127.0.0.1/app/'), null);
eq('location: port 0', appBaseFromLocation(CB, 307, 'http://127.0.0.1:0/app/'), null);
eq('location: port too large', appBaseFromLocation(CB, 307, 'http://127.0.0.1:65536/app/'), null);
eq('location: port 65535', appBaseFromLocation(CB, 307, 'http://127.0.0.1:65535/'), 'http://127.0.0.1:65535');
eq('location: none', appBaseFromLocation(CB, 307, null), null);
eq('location: 200', appBaseFromLocation(CB, 200, 'http://127.0.0.1:18851/app/'), null);
eq('location: 404', appBaseFromLocation(CB, 404, '/app/'), null);
eq('location: 301 is not one of the three', appBaseFromLocation(CB, 301, '/app/'), null);
eq('location: relative with a bad control base', appBaseFromLocation('http://example.com:80', 307, '/app/'), null);

// --- parseAppUrlSetting --------------------------------------------------------------
const auto = {auto: true, origin: null, invalid: false};
const bad = {auto: false, origin: null, invalid: true};
const ok = origin => ({auto: false, origin, invalid: false});
eq('setting: empty is automatic', parseAppUrlSetting(''), auto);
eq('setting: blank is automatic', parseAppUrlSetting('  '), auto);
eq('setting: not a string is automatic', parseAppUrlSetting(undefined), auto);
eq('setting: origin', parseAppUrlSetting('http://127.0.0.1:18851'), ok('http://127.0.0.1:18851'));
eq('setting: trailing slash', parseAppUrlSetting('http://127.0.0.1:18851/'), ok('http://127.0.0.1:18851'));
eq('setting: surrounding spaces', parseAppUrlSetting(' http://[::1]:18851/ '), ok('http://[::1]:18851'));
eq('setting: port leading zero normalized', parseAppUrlSetting('http://127.0.0.1:08851'), ok('http://127.0.0.1:8851'));
eq('setting: path', parseAppUrlSetting('http://127.0.0.1:18851/app/'), bad);
eq('setting: query', parseAppUrlSetting('http://127.0.0.1:18851/?x'), bad);
eq('setting: fragment', parseAppUrlSetting('http://127.0.0.1:18851#x'), bad);
eq('setting: two slashes', parseAppUrlSetting('http://127.0.0.1:18851//'), bad);
eq('setting: https', parseAppUrlSetting('https://127.0.0.1:18851'), bad);
eq('setting: other host', parseAppUrlSetting('http://example.com:18851'), bad);
eq('setting: localhost', parseAppUrlSetting('http://localhost:18851'), bad);
eq('setting: userinfo', parseAppUrlSetting('http://me@127.0.0.1:18851'), bad);
eq('setting: no port', parseAppUrlSetting('http://127.0.0.1'), bad);
eq('setting: port 0', parseAppUrlSetting('http://127.0.0.1:0'), bad);
eq('setting: port 70000', parseAppUrlSetting('http://127.0.0.1:70000'), bad);
eq('setting: no scheme', parseAppUrlSetting('127.0.0.1:18851'), bad);

if (failed) {
    print(`${failed} failed`);
    (await import('system')).default.exit(1);
}
print('all passed');
