// Active-window reporting (whatdidido TIME_ACCOUNTING.md section 4): pure
// logic, no GI imports, so it runs under plain `gjs -m` tests. The glue in
// window_tracker.js only reads the focused window and wires signals/timers.
//
// Payloads are POST /control/v1/window bodies:
//   {"focus": "none"} or
//   {"focus": "window", "app_id": s, "app_name": s, "wm_class": s, "title": s}
// plus, only while the last poll showed window_activity.geometry === true
// (the at-rest guard, AT_REST_GUARD.md section 6), the optional
//   "monitors": [[x, y, w, h], ...], "changed_at": "<RFC 3339 UTC>"

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
// At most this many monitor rectangles; coordinates are signed 32-bit, sizes positive.
export const MONITORS_MAX = 16;
const COORD_MAX = 2 ** 31 - 1;

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

// The session stores monitors as compact JSON ("[[0,0,1920,1080]]") and
// never stores changed_at.
export function metadataBytes(payload) {
    let n = 0;
    for (const [k, v] of Object.entries(payload)) {
        if (k === 'changed_at')
            continue;
        n += utf8Length(k) + utf8Length(k === 'monitors' ? JSON.stringify(v) : v);
    }
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
// monitors and changed_at pass through unchanged (monitors are never
// shortened: they count toward the budget, so the title gives way).
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
    if (payload.monitors !== undefined)
        out.monitors = payload.monitors;
    if (payload.changed_at !== undefined)
        out.changed_at = payload.changed_at;
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

// --- title rules (whatdidido TIME_ACCOUNTING.md "Later": title rules) -------
// window-title-rules entries are [app, pattern, label]. The focused window's
// title becomes the label of the first rule whose app matches ('' = any app;
// otherwise the app id like an exclusion, with or without ".desktop", or the
// WM class, case-insensitively) and whose pattern matches the whole title.
// Patterns are case-insensitive globs: '*' any run, '?' one character,
// everything else literal (no escapes, no [classes]). No RegExp is ever built
// from them: the matcher runs in the shell's main loop.
// A pattern without a literal character (only '*' and '?') needs an app.
// Fail closed: while the setting holds any entry that can't be used, every
// title is sent empty, and so is a title too long to match
// (TITLE_RULE_MATCH_MAX) while any rule is set.
export const TITLE_RULES_MAX = 100;
export const TITLE_RULE_FIELD_MAX = 200;    // apps and labels
// Patterns: at most 63 tokens keep the matcher's state in two 32-bit words.
// With TITLE_RULE_MATCH_MAX, 100 such rules on one title stay well inside a
// 16 ms frame (tests/window_title_rules_test.js measures it).
export const TITLE_RULE_PATTERN_MAX = 60;
export const TITLE_RULE_MATCH_MAX = 4096;   // code points

// Per code point, so '?' is one character whatever it folds to ('ß' stays
// 'ß': it doesn't match 'SS').
const fold = ch => ch.toLowerCase();

// Titles and patterns alike: control characters as spaces (as sent), lone
// surrogates as U+FFFD.
const matchText = text => text.toWellFormed().replace(CONTROL_RE, ' ');

function tokenize(pattern) {
    const tokens = [];
    for (const ch of matchText(pattern)) {
        if (ch !== '*' || tokens.at(-1) !== '*')
            tokens.push(ch === '*' || ch === '?' ? ch : fold(ch));
    }
    return tokens;
}

// [low, high] word of bit j (j <= 63).
const bit = j => (j < 32 ? [1 << j, 0] : [0, 1 << (j - 32)]);

// A bit-parallel NFA (Shift-And) over the pattern's positions: bit j is "the
// first j pattern tokens matched", a '*' bit also stays set on any character
// and sets the next bit without consuming one. ids: folded character -> a
// number shared by the rule set (0: in no pattern). The state is two 32-bit
// words, so at most 63 tokens.
function compileGlob(tokens, ids) {
    let starLo = 0, starHi = 0, anyLo = 0, anyHi = 0;
    tokens.forEach((t, j) => {
        const [lo, hi] = bit(j);
        if (t === '*') {
            starLo |= lo;
            starHi |= hi;
        } else if (t === '?') {
            anyLo |= lo;
            anyHi |= hi;
        }
    });
    // row[id]: the character's mask pair in masks (row 0: any other character).
    const row = new Uint8Array(ids.size + 1), masks = [anyLo, anyHi];
    tokens.forEach((t, j) => {
        if (t === '*' || t === '?')
            return;
        const id = ids.get(t);
        if (!row[id]) {
            row[id] = masks.length / 2;
            masks.push(anyLo, anyHi);
        }
        const [lo, hi] = bit(j);
        masks[2 * row[id]] |= lo;
        masks[2 * row[id] + 1] |= hi;
    });
    const [acceptLo, acceptHi] = bit(tokens.length);
    return {starLo, starHi, acceptLo, acceptHi, row, masks: Int32Array.from(masks), tailStar: tokens.at(-1) === '*'};
}

// title: the title's character ids. One pass, never backtracking.
function globMatches(glob, title) {
    const {starLo, starHi, acceptLo, acceptHi, row, masks, tailStar} = glob;
    let lo = 1 | ((starLo & 1) << 1), hi = 0;
    for (let i = 0; i < title.length; i++) {
        // A trailing '*' keeps an accepted title accepted.
        if (tailStar && ((lo & acceptLo) | (hi & acceptHi)))
            return true;
        const k = row[title[i]] * 2;
        const advLo = lo & masks[k], advHi = hi & masks[k + 1];
        let nextLo = (advLo << 1) | (lo & starLo);
        let nextHi = (advHi << 1) | (advLo >>> 31) | (hi & starHi);
        // A set '*' bit also sets the next one (never a '*': runs are collapsed).
        const closeLo = nextLo & starLo;
        nextHi |= ((nextHi & starHi) << 1) | (closeLo >>> 31);
        nextLo |= closeLo << 1;
        if (!(nextLo | nextHi))
            return false;
        lo = nextLo;
        hi = nextHi;
    }
    return ((lo & acceptLo) | (hi & acceptHi)) !== 0;
}

// Rules match the title as it would be sent (control characters as
// spaces), but whole: before sanitizeWindow() shortens it.
function titleIds(title, ids) {
    return Int32Array.from(matchText(title), ch => ids.get(fold(ch)) ?? 0);
}

function idsOf(tokenLists) {
    const ids = new Map();
    for (const tokens of tokenLists) {
        for (const t of tokens) {
            if (t !== '*' && t !== '?' && !ids.has(t))
                ids.set(t, ids.size + 1);
        }
    }
    return ids;
}

// One pattern (up to 63 tokens) against one text, for tests.
export function globMatch(pattern, text) {
    const tokens = tokenize(String(pattern)), ids = idsOf([tokens]);
    return globMatches(compileGlob(tokens, ids), titleIds(String(text), ids));
}

// Why a rule can't be used (shown in Settings, logged by the extension), or
// null. Lengths are in characters (code points).
export function titleRuleProblem(app, pattern, label) {
    if (![app, pattern, label].every(v => typeof v === 'string'))
        return 'App, pattern and label must be text';
    if (pattern === '')
        return 'The pattern is empty';
    if (app.trim() === '' && /^[*?]+$/.test(pattern))
        return 'Without an app, a pattern of only * and ? would replace every title (set an app, or turn off ' +
            'Record active window instead)';
    if ([...app].length > TITLE_RULE_FIELD_MAX)
        return `The app is longer than ${TITLE_RULE_FIELD_MAX} characters`;
    if ([...pattern].length > TITLE_RULE_PATTERN_MAX)
        return `The pattern is longer than ${TITLE_RULE_PATTERN_MAX} characters`;
    if ([...label].length > TITLE_RULE_FIELD_MAX)
        return `The label is longer than ${TITLE_RULE_FIELD_MAX} characters`;
    return null;
}

// The problem of the setting's entry at index (from 0), or null.
export function titleEntryProblem(entry, index) {
    if (index >= TITLE_RULES_MAX)
        return `At most ${TITLE_RULES_MAX} rules are allowed`;
    if (!Array.isArray(entry) || entry.length !== 3)
        return 'Not an (app, pattern, label) entry';
    return titleRuleProblem(...entry);
}

// No rules: titles are sent as they are.
const NO_RULES = {list: [], ids: new Map(), closed: false};

// The settings value as {rules, problems}. rules is for applyTitleRules();
// with any problem (an entry Settings would refuse, possible through dconf,
// or too many entries) it empties every title. problems name entries by
// number, never by their text.
export function compileTitleRules(entries) {
    if (entries === undefined)
        return {rules: NO_RULES, problems: []};
    const problems = [];
    if (!Array.isArray(entries)) {
        problems.push('not a list of (app, pattern, label) entries');
    } else {
        if (entries.length > TITLE_RULES_MAX)
            problems.push(`${entries.length} rules, more than ${TITLE_RULES_MAX}`);
        entries.slice(0, TITLE_RULES_MAX).forEach((entry, i) => {
            const problem = titleEntryProblem(entry, i);
            if (problem)
                problems.push(`rule ${i + 1}: ${problem}`);
        });
    }
    if (problems.length)
        return {rules: {list: [], ids: new Map(), closed: true}, problems};
    const tokens = entries.map(([, pattern]) => tokenize(pattern)), ids = idsOf(tokens);
    const list = entries.map(([app, , label], i) => ({app: app.trim(), glob: compileGlob(tokens[i], ids), label}));
    return {rules: {list, ids, closed: false}, problems};
}

function ruleApplies(app, appId, wmClass) {
    if (app === '')
        return true;
    return (!!appId && bareId(app) === bareId(appId)) ||
        (!!wmClass && app.toLowerCase() === wmClass.trim().toLowerCase());
}

function longerThan(text, max) {
    if (text.length <= max)
        return false;
    let n = 0;
    for (const _ of text) {
        if (++n > max)
            return true;
    }
    return false;
}

// The label of the first matching rule (compileTitleRules().rules), else
// the title; empty while the rules fail closed, or for a title over
// TITLE_RULE_MATCH_MAX characters while any rule is set.
export function applyTitleRules(title, appId, wmClass, rules = NO_RULES) {
    if (!rules.closed && !rules.list.length)
        return title;
    if (rules.closed || longerThan(title, TITLE_RULE_MATCH_MAX))
        return '';
    const ids = titleIds(title, rules.ids);
    for (const rule of rules.list) {
        if (ruleApplies(rule.app, appId, wmClass) && globMatches(rule.glob, ids))
            return rule.label;
    }
    return title;
}

// A Settings row ({app, pattern, label}) at index -> {rule: the entry to
// save, problem: why it can't be saved, or null}.
export function parseTitleRule(row, index) {
    const rule = [String(row?.app ?? '').trim(), String(row?.pattern ?? ''), String(row?.label ?? '')];
    return {rule, problem: titleEntryProblem(rule, index)};
}

export function formatTitleRules(list) {
    return list.map(([app, pattern, label]) => ({app, pattern, label}));
}

// --- digit-only title changes (TIME_ACCOUNTING.md "Later") ---------------------
// The server's counter rule (day_summary_evidence._same_title): a title split
// around its ASCII digit runs has text at even, digit runs at odd indices.
const DIGIT_RUNS = /([0-9]+)/;
// The longest digit run whose change still counts as a counter.
export const COUNTER_MAX_DIGITS = 3;
// A counter-only change is sent once the title has stayed this long.
export const COUNTER_SETTLE_MS = 15000;

// Whether title repeats last: equal, or a counter tick that changes only
// digit runs of at most COUNTER_MAX_DIGITS on both sides ("30 FPS" -> "31
// FPS", "(9) Chat" -> "(10) Chat"); a ticket number (#20591 -> #20592) is
// a change.
export function sameCounter(last, title) {
    if (last === title)
        return true;
    const before = last.split(DIGIT_RUNS), after = title.split(DIGIT_RUNS);
    if (before.length !== after.length)
        return false;
    return before.every((old, i) => old === after[i] ||
        (i % 2 === 1 && Math.max(old.length, after[i].length) <= COUNTER_MAX_DIGITS));
}

// Whether payload is last with only a counter ticked in its title: the same
// window fields and monitors (changed_at aside). Such a payload is deferred
// until its title settles (WindowReporter).
export function counterTick(payload, last) {
    if (payload?.focus !== 'window' || last?.focus !== 'window')
        return false;
    return payload.app_id === last.app_id && payload.app_name === last.app_name &&
        payload.wm_class === last.wm_class && JSON.stringify(payload.monitors) === JSON.stringify(last.monitors) &&
        sameCounter(last.title, payload.title);
}

// --- window geometry (AT_REST_GUARD.md section 6) ---------------------------
// Rectangles are [x, y, w, h] arrays; the shell's are Mtk.Rectangle-like
// {x, y, width, height}, all in logical layout coordinates.

// Overlap with a positive area: touching edges or corners do not count.
export function rectsIntersect([ax, ay, aw, ah], [bx, by, bw, bh]) {
    return Math.max(ax, bx) < Math.min(ax + aw, bx + bw) && Math.max(ay, by) < Math.min(ay + ah, by + bh);
}

// [x, y, w, h] of a shell rectangle, or null when the server would refuse it.
function rectOf(r) {
    if (!r)
        return null;
    const {x, y, width, height} = r;
    const ok = [x, y, width, height].every(v => Number.isInteger(v) && Math.abs(v) <= COORD_MAX);
    return ok && width > 0 && height > 0 ? [x, y, width, height] : null;
}

function compareRects(a, b) {
    for (let i = 0; i < 4; i++) {
        if (a[i] !== b[i])
            return a[i] - b[i];
    }
    return 0;
}

// Sorted by x, then y (then size), deduplicated, at most MONITORS_MAX.
function monitorList(rects) {
    const sorted = [...rects].sort(compareRects);
    return sorted.filter((m, i) => i === 0 || compareRects(m, sorted[i - 1]) !== 0).slice(0, MONITORS_MAX);
}

// The monitors the window's frame rect intersects with a positive area, as
// a monitorList(). Empty when the frame is unknown or off every monitor.
export function windowMonitors(frame, layout) {
    const win = rectOf(frame);
    if (!win)
        return [];
    return monitorList((layout ?? []).map(rectOf).filter(m => m && rectsIntersect(win, m)));
}

// Two windowMonitors() results (either may be missing) as one monitorList().
export function unionMonitors(a, b) {
    return monitorList([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

export function sameMonitors(a, b) {
    return Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
}

// An RFC 3339 UTC instant with millisecond precision: 2026-10-23T12:34:56.789Z.
export function rfc3339(ms) {
    return new Date(Math.floor(ms)).toISOString();
}

// raw: null (no focused window) or what the shell reports:
// {appId, appName, wmClass, title, frame, layout}, any of which may be
// null/undefined; frame is the window's frame rect, layout the monitor
// rectangles. geometry: the last poll showed window_activity.geometry;
// only then are monitors (when non-empty; none means "unknown") and
// changed_at (ms since the epoch, when known) added. seen: monitor sets
// already seen in this burst (AT_REST_GUARD.md A2.3), added to the window's.
// rules: compileTitleRules().rules, applied to the whole raw title (an
// excluded app's title is empty whatever the rules).
export function windowPayload(raw, excluded = [], {geometry = false, changedAt = null, seen = [], rules} = {}) {
    if (!raw)
        return {focus: 'none'};
    const str = v => (typeof v === 'string' ? v : '');
    let appId = str(raw.appId);
    if (appId.startsWith('window:'))  // Shell's synthetic id for app-less windows
        appId = '';
    const payload = {
        focus: 'window',
        app_id: appId,
        app_name: str(raw.appName),
        wm_class: str(raw.wmClass),
        title: isExcluded(appId, excluded) ? '' : applyTitleRules(str(raw.title), appId, str(raw.wmClass), rules),
    };
    if (geometry) {
        const monitors = unionMonitors(windowMonitors(raw.frame, raw.layout), seen);
        if (monitors.length > 0)
            payload.monitors = monitors;
        if (Number.isFinite(changedAt))
            payload.changed_at = rfc3339(changedAt);
    }
    return sanitizeWindow(payload);
}

// Payloads are always built with the same key order. changed_at is not
// compared (the session neither stores nor compares it); monitors are.
export function samePayload(a, b) {
    const comparable = p => JSON.stringify({...p, changed_at: undefined});
    return !!a && !!b && comparable(a) === comparable(b);
}

export function windowActivityOffered(status, running) {
    return !!running && status?.window_activity?.available === true;
}

// Paused too while the session takes geometry (AT_REST_GUARD.md A2.2): its
// at-rest guard holds the first frames after a resume until a focus report
// arrives, and answers paused reports with recorded: false.
export function windowEligible(status, running) {
    if (!windowActivityOffered(status, running))
        return false;
    return status.state === 'recording' || (status.state === 'paused' && windowGeometry(status, running));
}

// window_activity.epoch (Amendment 1): bumped by the server whenever it
// forgets the last recorded window. null when absent (older server) or invalid.
export function windowEpoch(status, running) {
    const epoch = windowActivityOffered(status, running) ? status.window_activity.epoch : undefined;
    return Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
}

// window_activity.geometry (CONTROL_API.md Amendment 4): the session accepts
// monitors and changed_at. An older session answers them with 400 invalid.
export function windowGeometry(status, running) {
    return windowActivityOffered(status, running) && status.window_activity.geometry === true;
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
//   and state "recording" (or "paused" with window_activity.geometry), and no
//   409 came back since that poll. A paused report is answered with
//   recorded: false, which is a success like any 202.
// - changed() (re)arms a SETTLE_MS timer; on fire the payload is built from
//   the *current* focus and skipped if equal to the last one sent.
// - At most one POST per SPACING_MS, one in flight at a time; a send inside
//   the spacing waits for its end and then uses the focus at that moment.
// - Becoming active (transition into recording, from unavailable, setting
//   turned on) forgets the last payload and sends at once (spacing permitting).
//   So does a changed window_activity.epoch between two polls while active
//   (a start, resume or recovery, seen or not by the polls), a paused ->
//   recording edge, and a changed window_activity.geometry (the keys the
//   session accepts changed).
// - Title rules (setTitleRules) replace the title before anything else; with
//   ignoreDigitChanges, a payload that is the last one sent with only a
//   counter ticked in its title (counterTick) is held while recording,
//   unless its burst holds a focus change (changed(true)), and sent once the
//   raw title has stayed unchanged for COUNTER_SETTLE_MS (each change of it
//   restarts the wait), with the changed_at of its burst. So an FPS counter
//   never sends while it ticks, and 'Issue 123' -> 'Issue 124' is recorded
//   about 15 s late. Any other send (a newer payload, a focus change, a
//   re-send, a retry, a paused report) drops the held one, as do going back
//   to the sent title and becoming inactive: a focus change reports the new
//   window at its usual time rather than first sending the old window's
//   held title, which would delay the focus report by the spacing.
//   Re-sends, retries (nothing sent to compare with) and paused reports
//   always go out.
// - monitors and changed_at are added only while the last poll showed
//   window_activity.geometry === true. Dedupe ignores changed_at.
// - A burst is the changed() calls while active up to the payload built
//   from them (one settle, or longer when spacing or a failed POST delays
//   it). Its payload carries the union of the monitor sets read at each
//   call and at build time, stamped with the burst's first change time
//   (AT_REST_GUARD.md A2.3: over-dropping is the safe direction). When the
//   union is more than the window's current set, a follow-up burst starting
//   at build time reports the current set after the settle. Without a burst
//   (becoming active, a re-send), changed_at is the time of the last
//   changed() call, or of construction before any. A failed POST puts its
//   burst back (merged with any newer one) for the retry.
// - Becoming inactive cancels every pending timer. Turning the setting off
//   while active sends {"focus": "none"} once (after any request in flight,
//   spacing permitting; never retried), unless recording/availability ends
//   first.
// - A failed POST (any error except 409 unavailable) forgets the last payload
//   and retries the *current* focus with backoff RETRY_MIN_MS, doubling up
//   to RETRY_MAX_MS, until a POST succeeds or the focus changes (a change
//   goes through the settle timer instead).
// - Errors are logged once per distinct message (the last LOGGED_MAX kept),
//   title rule problems whenever their list changes.
//
// deps: now() -> ms (monotonic); wallNow() -> ms since the epoch (for
// changed_at); setTimer(ms, fn) -> id; clearTimer(id); readFocus() -> raw
// focus for windowPayload(); send(payload) -> Promise (rejects with
// {status, code, message}); log(message); onUnavailable() after a 409 turned
// reporting off until the next poll.
export class WindowReporter {
    constructor({now, wallNow = () => Date.now(), setTimer, clearTimer, readFocus, send, log = () => {},
        onUnavailable = () => {}, enabled = true, excluded = [], titleRules = [], ignoreDigitChanges = false,
        settleMs = SETTLE_MS, spacingMs = SPACING_MS, retryMinMs = RETRY_MIN_MS, retryMaxMs = RETRY_MAX_MS}) {
        Object.assign(this, {_now: now, _wallNow: wallNow, _setTimer: setTimer, _clearTimer: clearTimer,
            _readFocus: readFocus, _send: send, _log: log, _onUnavailable: onUnavailable, _settleMs: settleMs, _spacingMs: spacingMs,
            _retryMinMs: retryMinMs, _retryMaxMs: retryMaxMs});
        this._enabled = !!enabled;
        this._excluded = excluded;
        this._rules = null;         // compileTitleRules().rules
        this._ruleProblems = '';    // compileTitleRules().problems last logged, joined
        this._ignoreDigits = !!ignoreDigitChanges;
        this._eligible = false;
        this._unavailable = false;
        this._destroyed = false;
        this._last = null;          // last payload the server accepted (202)
        this._generation = 0;       // bumped whenever _last is forgotten
        this._epoch = null;         // window_activity.epoch of the last poll
        this._geometry = false;     // window_activity.geometry of the last poll
        this._recording = false;    // the last poll showed state "recording"
        this._changedAt = wallNow(); // wall-clock ms of the last change signal
        this._burst = null;         // unsent changes while active: {since, monitors, focus, at}
        this._held = null;          // a counter tick waiting to settle: {payload, burst, title, retitled, due}
        this._counterTimer = null;
        this._lastSendAt = -Infinity;
        this._settleTimer = null;
        this._spacingTimer = null;
        this._retryTimer = null;
        this._failures = 0;         // consecutive failed POSTs (backoff step)
        this._offPending = false;   // {"focus": "none"} owed after switching off
        this._inFlight = false;
        this._pending = false;
        this._logged = new Set();   // insertion order: oldest first
        this._setRules(titleRules);
    }

    get active() {
        return !this._destroyed && this._enabled && this._eligible && !this._unavailable;
    }

    get unavailable() {
        return this._unavailable;
    }

    get geometry() {
        return this._geometry;
    }

    // The session's at-rest guard wants focus reports (enabled, geometry
    // offered, no 409 since the last poll), whatever its state: the
    // extension then polls at poll-active while paused or stopped too, so a
    // start or resume is seen quickly (AT_REST_GUARD.md A2.2).
    get watching() {
        return !this._destroyed && this._enabled && this._geometry && !this._unavailable;
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

    // The window-title-rules value ([app, pattern, label] entries).
    setTitleRules(entries) {
        this._setRules(entries);
        this.changed();
    }

    setIgnoreDigitChanges(on) {
        this._ignoreDigits = !!on;
        this.changed();
    }

    // After every status poll; status is null when the server is not running.
    updateStatus(status, running) {
        const epoch = windowEpoch(status, running);
        const epochChanged = epoch !== null && this._epoch !== null && epoch !== this._epoch;
        this._epoch = epoch;
        const geometry = windowGeometry(status, running);
        const geometryChanged = geometry !== this._geometry;
        this._geometry = geometry;
        const recording = windowEligible(status, running) && status.state === 'recording';
        const resumed = recording && !this._recording;
        this._recording = recording;
        this._update(() => {
            this._eligible = windowEligible(status, running);
            this._unavailable = false;
        }, epochChanged || geometryChanged || resumed);
        // Not recording (or not offered) any more: the server no longer
        // attributes time to the last window, so "none" is not needed.
        if (!this._eligible)
            this._offPending = false;
    }

    // Focus (focus true), title, wm-class or the focused window's monitor
    // set changed. Stamped even while inactive: becoming active sends it
    // with this time.
    changed(focus = false) {
        this._changedAt = this._wallNow();
        if (!this.active)
            return;
        this._burst ??= {since: this._changedAt, monitors: [], focus: false};
        this._burst.focus ||= focus;
        this._burst.at = this._now();
        if (this._held && !this._held.retitled && this._readFocus()?.title !== this._held.title)
            this._held.retitled = true;
        if (this._geometry)
            this._burst.monitors = unionMonitors(this._burst.monitors, this._currentMonitors(this._readFocus()));
        this._clear('_settleTimer');
        this._clear('_retryTimer');
        this._armSettle();
    }

    destroy() {
        this._destroyed = true;
        this._offPending = false;
        this._clear('_settleTimer');
        this._clear('_spacingTimer');
        this._clear('_retryTimer');
        this._dropHeld();
    }

    // Logged when the list of problems changes (not through _logOnce: its
    // set is shared with send errors), naming the entries by number only.
    _setRules(entries) {
        const {rules, problems} = compileTitleRules(entries);
        this._rules = rules;
        const key = problems.join('\n');
        if (key === this._ruleProblems)
            return;
        this._ruleProblems = key;
        if (!problems.length)
            return;
        const shown = problems.slice(0, 3).join('; ') + (problems.length > 3 ? `; ${problems.length - 3} more` : '');
        this._log(`whatdidido: window-title-rules can't be used (${shown}): every window title is sent empty ` +
            'until it is fixed');
    }

    _armSettle() {
        if (this._settleTimer !== null)
            return;
        this._settleTimer = this._setTimer(this._settleMs, () => {
            this._settleTimer = null;
            this._flush();
        });
    }

    _currentMonitors(raw) {
        return raw ? windowMonitors(raw.frame, raw.layout) : [];
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
            this._dropHeld();
            this._offPending = false;
            if (!was)
                this._failures = 0;
            this._clear('_settleTimer');
            this._clear('_retryTimer');
            this._flush();
        } else if (was && !is) {
            this._burst = null;
            this._dropHeld();
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
        const raw = this._readFocus();
        let burst = this._burst;
        this._burst = null;
        let payload = windowPayload(raw, this._excluded,
            {geometry: this._geometry, changedAt: burst?.since ?? this._changedAt, seen: burst?.monitors,
                rules: this._rules});
        if (payload.monitors) {
            const current = this._currentMonitors(raw);
            if (!sameMonitors(payload.monitors, current)) {
                this._burst = {since: this._wallNow(), monitors: current, focus: false};
                this._armSettle();
            }
        }
        if (samePayload(payload, this._last)) {
            this._dropHeld();
            return;
        }
        // A counter in the title: held until the title settles.
        if (this._ignoreDigits && this._recording && !burst?.focus && counterTick(payload, this._last)) {
            const held = this._held;
            if (!held || held.retitled || !samePayload(held.payload, payload)) {
                this._hold(payload, burst, raw);
                return;
            }
            if (!held.due)
                return;
            ({payload, burst} = held);
        }
        this._dropHeld();
        this._post(payload, burst);
    }

    // Hold payload (built from burst) until COUNTER_SETTLE_MS after the
    // burst's last change; then _flush() sends it if it is still current.
    _hold(payload, burst, raw) {
        this._clear('_counterTimer');
        const held = {payload, burst, title: raw?.title, retitled: false, due: false};
        this._held = held;
        const wait = (burst?.at ?? this._now()) + COUNTER_SETTLE_MS - this._now();
        this._counterTimer = this._setTimer(Math.max(0, wait), () => {
            this._counterTimer = null;
            held.due = true;
            // A pending settle flushes it (or what replaced it).
            if (this._settleTimer === null)
                this._flush();
        });
    }

    _dropHeld() {
        this._held = null;
        this._clear('_counterTimer');
    }

    _logOnce(msg, key = msg) {
        if (this._logged.has(key))
            return;
        this._log(msg);
        this._logged.add(key);
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

    async _post(payload, burst = null) {
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
            if (burst) {
                const newer = this._burst;
                this._burst = newer
                    ? {since: Math.min(burst.since, newer.since), monitors: unionMonitors(burst.monitors, newer.monitors)}
                    : burst;
            }
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
// window at a time and calls onChange() on its title/wm-class changes, and
// onMove() (when given) on its position/size changes. Its `unmanaged` signal
// drops the handlers (Amendment 2 item 6); disconnecting tolerates a window
// that is already disposed.
export class FocusWatch {
    constructor(onChange, onMove = null) {
        this._onChange = onChange;
        this._onMove = onMove;
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
        if (this._onMove) {
            this._ids.push(
                win.connect('position-changed', () => this._onMove()),
                win.connect('size-changed', () => this._onMove()));
        }
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

// The focused window's monitor set (AT_REST_GUARD.md section 6): compute()
// returns windowMonitors() for the focused window now. update() (on a move,
// resize or monitor layout change) calls onChange() only when the set
// differs from the last one, so a drag within a monitor reports nothing.
// reset() (on a focus change, which is reported anyway) only remembers it.
export class MonitorSet {
    constructor(compute, onChange) {
        this._compute = compute;
        this._onChange = onChange;
        this._monitors = null;
    }

    get monitors() {
        return this._monitors;
    }

    reset() {
        this._monitors = this._compute();
    }

    update() {
        const next = this._compute();
        if (sameMonitors(next, this._monitors))
            return;
        this._monitors = next;
        this._onChange();
    }
}

