// Pure helpers over the app server's timesheet day (GET
// /api/v1/timesheet/day, a `TimesheetDay`) and the app server's address: no
// GI imports, so they run under plain `gjs -m` tests. Ported from the
// whatdidido app (frontend/src/lib/core/day.ts, core/time.ts, core/route.ts,
// theme/palette.ts) with the same behavior; POPOVER.md sections 3 and 6.
//
// A TimesheetDay, as far as this module reads it (instants are ISO strings):
//   {date, zone, now, span: {start, end} | null,
//    segments: [{start, end, state, window: {app_id, app_name, title} | null}],
//    entries: [{assignment: {ticket, client, category, ...}, clip_start, clip_end}],
//    unassigned: [{start, end, state, ...}],
//    suggestions: {tickets: [string], ticket_defaults: [{ticket, client, category, billable}]}}

const ms = iso => Date.parse(iso);

/**
 * The unassigned stretch that runs up to now, if any: the latest `active`
 * or `idle` run of `day.unassigned` that ended at most `slackMs` before
 * `day.now`.
 * @param {object} day TimesheetDay
 * @param {number} [slackMs]
 * @returns {object|null} the TimesheetRun ({start, end, state, ...}) or null
 */
export function currentStretch(day, slackMs = 60000) {
    const now = ms(day.now);
    for (let i = day.unassigned.length - 1; i >= 0; i--) {
        const r = day.unassigned[i];
        if (now - ms(r.end) > slackMs)
            return null;
        if (r.state === 'active' || r.state === 'idle')
            return r;
    }
    return null;
}

/**
 * The entry that ends last (the Now card's "<ticket> until <end>").
 * @param {object} day TimesheetDay
 * @returns {object|null} the TimesheetEntry ({assignment, clip_start, clip_end, ...}) or null
 */
export function lastEntry(day) {
    let best = null;
    for (const e of day.entries) {
        if (!best || ms(e.clip_end) > ms(best.clip_end))
            best = e;
    }
    return best;
}

/**
 * The most recent segment with a focused window.
 * @param {object} day TimesheetDay
 * @returns {object|null} the TimesheetSegment ({start, end, state, window}) or null
 */
export function lastFocus(day) {
    for (let i = day.segments.length - 1; i >= 0; i--) {
        const s = day.segments[i];
        if (s.window)
            return s;
    }
    return null;
}

/**
 * Buckets of `minutes` from the start of the span (floored to the bucket
 * size, in UTC like the app) to now; buckets without any segment are left
 * out.
 * @param {object} day TimesheetDay
 * @param {number} [minutes]
 * @returns {Array<{start: number, end: number, active: number, state: string, ticket: string|null}>}
 *   start/end in ms since the epoch; active: fraction of the bucket that was
 *   active (0..1); state: the dominant segment state (ties: the first seen);
 *   ticket: the ticket of the entry covering the bucket's middle ('' for an
 *   entry without ticket), null when none covers it.
 */
export function sparkBuckets(day, minutes = 15) {
    if (!day.span)
        return [];
    const step = minutes * 60000;
    const end = Math.min(ms(day.span.end), ms(day.now));
    const first = Math.floor(ms(day.span.start) / step) * step;
    const out = [];
    for (let t = first; t < end; t += step) {
        const per = new Map();
        for (const s of day.segments) {
            const o = Math.min(ms(s.end), t + step) - Math.max(ms(s.start), t);
            if (o > 0)
                per.set(s.state, (per.get(s.state) ?? 0) + o);
        }
        if (!per.size)
            continue;
        let state = 'untracked';
        let most = -1;
        for (const [k, v] of per) {
            if (v > most)
                [state, most] = [k, v];
        }
        const mid = t + step / 2;
        const cover = day.entries.find(e => ms(e.clip_start) <= mid && mid < ms(e.clip_end));
        out.push({
            start: t,
            end: t + step,
            active: (per.get('active') ?? 0) / step,
            state,
            ticket: cover ? cover.assignment.ticket : null,
        });
    }
    return out;
}

/**
 * Initials for an app tile: "ConnectWise Manage" -> "CM", "firefox" -> "Fi", "" -> "?".
 * @param {string} name
 * @returns {string}
 */
export function appInitials(name) {
    const words = name.split(/[\s._-]+/).filter(Boolean);
    if (words.length >= 2)
        return (words[0][0] + words[1][0]).toUpperCase();
    const w = words[0] ?? '?';
    return w.slice(0, 2).replace(/^./, c => c.toUpperCase());
}

// The GNOME skin's data palette, frontend/src/lib/theme/tokens.css:
// light = :root[data-platform="gnome"] --data-0..--data-7 and --data-neutral,
// dark = :root[data-platform="gnome"][data-theme="dark"] the same tokens.
export const DATA_COLORS = {
    light: ['#e01b24', '#9141ac', '#ff7800', '#986a44', '#e5a50a', '#3584e4', '#1a5fb4', '#2ec27e'],
    dark: ['#f66151', '#c061cb', '#ffa348', '#cdab8f', '#f8e45c', '#62a0ea', '#99c1f1', '#57e389'],
};
export const NEUTRAL_COLORS = {light: '#77767b', dark: '#9a9996'};
export const PALETTE_SIZE = 8;

/**
 * "#20591", "20591" and " #20591 " share a color.
 * @param {string} ticket
 * @returns {string}
 */
export function normalizeTicket(ticket) {
    return ticket.trim().replace(/^#/, '').toLowerCase();
}

/**
 * FNV-1a over the normalized string plus a murmur3 finalizer, reduced to a
 * palette slot (the app's paletteSlot).
 * @param {string} key
 * @returns {number} 0..7
 */
export function paletteSlot(key) {
    let h = 0x811c9dc5;
    for (const ch of normalizeTicket(key)) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) % PALETTE_SIZE;
}

/**
 * CSS color of a ticket; empty tickets (admin / internal time) are neutral.
 * @param {string|null|undefined} ticket
 * @param {'light'|'dark'} variant anything but 'dark' is light
 * @returns {string} '#rrggbb'
 */
export function ticketColor(ticket, variant) {
    const v = variant === 'dark' ? 'dark' : 'light';
    if (!ticket || !normalizeTicket(ticket))
        return NEUTRAL_COLORS[v];
    return DATA_COLORS[v][paletteSlot(ticket)];
}

// gjs's Intl honors timeZone (probed on gjs 1.88: 21:14Z in America/New_York
// formats as 5:14 PM); an unknown zone throws RangeError, then the local zone
// is used, like the app.
function formatTime(msValue, zone, options, locale) {
    const d = new Date(msValue);
    let text;
    try {
        text = new Intl.DateTimeFormat(locale, {...options, timeZone: zone || undefined}).format(d);
    } catch {
        text = new Intl.DateTimeFormat(locale, options).format(d);
    }
    // ICU separates "PM" with a narrow no-break space; keep plain text plain.
    return text.replace(/[\u202f\u00a0]/g, ' ');
}

/**
 * Wall-clock time in an IANA zone: "5:14 PM" (12-hour) or "17:14" (24-hour).
 * @param {number|string} msValue ms since the epoch (or an ISO string)
 * @param {string} [zone] IANA zone (day.zone); invalid or empty: the local zone
 * @param {boolean} [use24h]
 * @returns {string}
 */
export function clockTime(msValue, zone, use24h = false) {
    if (use24h)
        return hhmm(msValue, zone);
    return formatTime(msValue, zone, {hour: 'numeric', minute: '2-digit'}, 'en-US');
}

/**
 * "HH:MM" (24-hour, zero-padded) in an IANA zone, for ?t= deep links.
 * @param {number|string} msValue
 * @param {string} [zone]
 * @returns {string}
 */
export function hhmm(msValue, zone) {
    return formatTime(msValue, zone, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}, 'en-GB');
}

/**
 * The local date (YYYY-MM-DD) of an instant on this machine, for ?date=.
 * @param {number} msValue
 * @returns {string}
 */
export function localDate(msValue) {
    const d = new Date(msValue);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// application/x-www-form-urlencoded like URLSearchParams.toString() (gjs has
// no URLSearchParams): only ASCII alphanumerics and *-._ stay, space is '+'.
function formEncode(s) {
    return encodeURIComponent(s).replace(/[!'()~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%20/g, '+');
}

/**
 * The app's hash route (formatHash): "#/timeline?date=2026-10-15&t=10:45";
 * empty values are left out.
 * @param {string} view 'today' | 'timeline' | 'timesheet' | ...
 * @param {Object<string, string>} [params]
 * @returns {string}
 */
export function appRoute(view, params = {}) {
    const entries = Object.entries(params).filter(([, v]) => v !== '');
    const query = entries.length ? `?${entries.map(([k, v]) => `${formEncode(k)}=${formEncode(String(v))}`).join('&')}` : '';
    return `#/${view}${query}`;
}

// A loopback http origin: http://127.0.0.1:<port> (not [::1]: the app server
// grants the local principal only for Host 127.0.0.1, POPOVER.md Amendment 1),
// no userinfo (it would not match), then an optional path, query, fragment.
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1):(\d{1,5})((?:[/?#].*)?)$/;

function loopback(url) {
    const m = typeof url === 'string' ? LOOPBACK_RE.exec(url) : null;
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535)
        return null;
    return {origin: `http://${m[1]}:${port}`, rest: m[3]};
}

const REDIRECTS = [302, 303, 307];

/**
 * The app server origin from the control server's answer to `GET /day`
 * (POPOVER.md 3.1): a 302/303/307 whose Location is an absolute loopback
 * http URL gives that URL's origin; a relative Location starting with
 * `/app/` gives controlBase's origin; anything else gives null.
 * @param {string} controlBase the control file's base_url
 * @param {number} status HTTP status of the probe
 * @param {string|null} location the Location header, if any
 * @returns {string|null} 'http://127.0.0.1:<port>' (no trailing slash) or null
 */
export function appBaseFromLocation(controlBase, status, location) {
    if (!REDIRECTS.includes(status) || typeof location !== 'string')
        return null;
    if (location.startsWith('/app/'))
        return loopback(controlBase)?.origin ?? null;
    return loopback(location)?.origin ?? null;
}

/**
 * The `app-url` setting (POPOVER.md 3.1). Empty (or blank): automatic
 * discovery. Otherwise only a loopback http origin with an explicit port and
 * an optional trailing slash is accepted.
 * @param {string} text
 * @returns {{auto: boolean, origin: string|null, invalid: boolean}}
 *   auto: discover; origin: the override; invalid: set but not a local address
 */
export function parseAppUrlSetting(text) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t)
        return {auto: true, origin: null, invalid: false};
    const lb = loopback(t);
    if (!lb || (lb.rest !== '' && lb.rest !== '/'))
        return {auto: false, origin: null, invalid: true};
    return {auto: false, origin: lb.origin, invalid: false};
}
