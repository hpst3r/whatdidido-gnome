// Run: gjs -m tests/window_title_rules_test.js
// Window title rules (whatdidido TIME_ACCOUNTING.md "Later": title rules):
// (app, pattern, label) entries whose case-insensitive glob over the whole
// title replaces it with the label before it leaves the shell, the prefs
// parser that refuses empty and all-* patterns, and the counter rule
// (sameCounter, the server's day_summary_evidence._same_title) the digit
// filter uses.
import System from 'system';

import {
    TITLE_RULES_MAX, TITLE_RULE_FIELD_MAX, TITLE_MAX_CHARS, globMatch, compileTitleRules, applyTitleRules,
    titleRuleProblem, parseTitleRules, formatTitleRules, sameCounter, counterTick, windowPayload,
} from '../whatdidido@wporter.org/lib/window_model.js';

let failed = 0;
function eq(name, got, want) {
    const g = String(JSON.stringify(got)), w = String(JSON.stringify(want));
    if (g !== w) {
        failed++;
        print(`FAIL ${name}: got ${g.slice(0, 300)} want ${w.slice(0, 300)}`);
    } else {
        print(`ok   ${name}`);
    }
}

eq('caps', [TITLE_RULES_MAX, TITLE_RULE_FIELD_MAX], [100, 200]);

// --- globMatch ----------------------------------------------------------------------
eq('* any run, whole title', [
    globMatch('*Discord*', 'Friends - Discord — Mozilla Firefox'),
    globMatch('*Discord*', 'Discord'),
    globMatch('Discord', 'Discord - Friends'),
    globMatch('*Discord', 'Discord - Friends'),
    globMatch('Discord*', 'Discord - Friends'),
], [true, true, false, false, true]);
eq('case-insensitive both ways', [globMatch('*discord*', 'DISCORD'), globMatch('*DISCORD*', 'discord')], [true, true]);
eq('? is exactly one character', [globMatch('a?c', 'abc'), globMatch('a?c', 'ac'), globMatch('a?c', 'abbc')],
    [true, false, false]);
eq('? is one code point (astral emoji)', [globMatch('x?y', 'x😀y'), globMatch('x??y', 'x😀y')], [true, false]);
eq('[ is literal', [globMatch('[a]*', '[a] foo'), globMatch('[a]*', 'a foo'), globMatch('[ab]', 'a')],
    [true, false, false]);
eq('\\ is literal (no escapes)', [globMatch('a\\b', 'a\\b'), globMatch('\\*', '\\anything'), globMatch('\\*', '*x')],
    [true, true, false]);
eq('regex syntax is literal', [globMatch('.*', '.foo'), globMatch('.*', 'xfoo'), globMatch('(a+)+$', '(a+)+$'),
    globMatch('(a+)+$', 'aaa')], [true, false, true, false]);
eq('unicode case folding', [globMatch('ÉCOLE*', 'école primaire'), globMatch('*straße*', 'STRASSE'),
    globMatch('*Привет*', 'ну привет мир')], [true, false, true]);
eq('runs of * collapse', [globMatch('**a**', 'xay'), globMatch('a***', 'a')], [true, true]);
eq('empty pattern matches only the empty title', [globMatch('', ''), globMatch('', 'x')], [true, false]);
eq('* alone matches everything (refused as a rule)', [globMatch('*', ''), globMatch('*', 'anything')], [true, true]);
eq('star backtracking', [globMatch('a*b*c', 'abcbc'), globMatch('a*b*c', 'abcb'), globMatch('*a?', 'aaab')],
    [true, false, true]);

// Cross-check against a memoized reference over bounded random cases,
// including patterns longer than one 32-bit word.
function reference(p, t) {
    const P = [...p].map(c => (c === '*' || c === '?' ? c : c.toLowerCase())), T = [...t].map(c => c.toLowerCase());
    const memo = new Map();
    const go = (i, j) => {
        const k = i * 10000 + j;
        if (memo.has(k))
            return memo.get(k);
        let r;
        if (i === P.length)
            r = j === T.length;
        else if (P[i] === '*')
            r = go(i + 1, j) || (j < T.length && go(i, j + 1));
        else
            r = j < T.length && (P[i] === '?' || P[i] === T[j]) && go(i + 1, j + 1);
        memo.set(k, r);
        return r;
    };
    return go(0, 0);
}
let seed = 12345;
const rand = n => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
};
let mismatches = 0, matches = 0;
for (let n = 0; n < 3000; n++) {
    const plen = rand(70), tlen = rand(90);
    const p = Array.from({length: plen}, () => 'aAb*?'[rand(5)]).join('');
    const t = Array.from({length: tlen}, () => 'abB'[rand(3)]).join('');
    const want = reference(p, t);
    if (globMatch(p, t) !== want)
        mismatches++;
    if (want)
        matches++;
}
eq('agrees with a reference matcher on 3000 random cases', mismatches, 0);
eq('the random cases include matches', matches > 100, true);
eq('long literal across word boundaries', [
    globMatch('x'.repeat(31) + '?' + 'y'.repeat(40), 'x'.repeat(31) + 'Q' + 'y'.repeat(40)),
    globMatch('x'.repeat(31) + '*' + 'y'.repeat(40), 'x'.repeat(31) + 'qqq' + 'y'.repeat(40)),
    globMatch('x'.repeat(31) + '*' + 'y'.repeat(40), 'x'.repeat(30) + 'qqq' + 'y'.repeat(40)),
    globMatch('x'.repeat(64), 'x'.repeat(64)), globMatch('x'.repeat(64), 'x'.repeat(63)),
], [true, true, false, true, false]);

// --- adversarial performance ----------------------------------------------------------
// A catastrophic-backtracking shape for regex engines: 100 rules of 200
// characters (the caps) against a 100 000-character title.
const evilPattern = '*a'.repeat(99) + '*b';
eq('adversarial pattern is at the cap', [...evilPattern].length, TITLE_RULE_FIELD_MAX);
const evilTitle = 'a'.repeat(100000);
const evilRules = compileTitleRules(Array.from({length: TITLE_RULES_MAX}, (_, i) =>
    ['', i % 2 ? evilPattern : `${'a?'.repeat(99)}b*`, 'x'])).rules;
let start = Date.now();
eq('adversarial: no rule matches', applyTitleRules(evilTitle, '', '', evilRules), evilTitle);
let elapsed = Date.now() - start;
print(`     adversarial: 100 rules x 100000 chars in ${elapsed} ms`);
eq('adversarial: 100 capped rules over a 100k title stay under 2 s', elapsed < 2000, true);
start = Date.now();
eq('adversarial: a single rule over a 100k title', globMatch(evilPattern, evilTitle), false);
elapsed = Date.now() - start;
print(`     adversarial: one rule in ${elapsed} ms`);
eq('adversarial: one rule under 100 ms', elapsed < 100, true);

// --- rule validation -----------------------------------------------------------------
const long = 'x'.repeat(TITLE_RULE_FIELD_MAX + 1);
eq('valid rule: no problem', [titleRuleProblem('', '*Discord*', ''), titleRuleProblem('firefox', 'a', 'b')],
    [null, null]);
eq('refused: empty pattern', typeof titleRuleProblem('', '', 'x'), 'string');
eq('refused: all-* patterns', ['*', '**', '*****'].map(p => typeof titleRuleProblem('', p, '')),
    ['string', 'string', 'string']);
eq('allowed: * with something else', [titleRuleProblem('', '*?*', ''), titleRuleProblem('', ' ', '')], [null, null]);
eq('refused: pattern or label over 200 characters',
    [typeof titleRuleProblem('', long, ''), typeof titleRuleProblem('', 'a', long)], ['string', 'string']);
eq('allowed: exactly 200 characters, counted in code points',
    [titleRuleProblem('', 'x'.repeat(200), '😀'.repeat(200)), typeof titleRuleProblem('', '😀'.repeat(201), '')],
    [null, 'string']);
eq('refused: non-string fields', typeof titleRuleProblem('', 5, ''), 'string');

// --- compileTitleRules (the model side: hand-edited dconf) ------------------------------
let compiled = compileTitleRules([['', '*a*', 'A'], ['', '', 'empty'], ['', '*', 'all'], ['', long, ''],
    ['x', 'y'], 'junk', ['', '*b*', 'B']]);
eq('compile: invalid entries are dropped', compiled.rules.map(r => r.label), ['A', 'B']);
eq('compile: one problem per dropped entry, numbered from 1, never the pattern text',
    [compiled.problems.length, compiled.problems.every(m => !m.includes(long)), !!compiled.problems[0]?.includes('2')],
    [5, true, true]);
compiled = compileTitleRules(Array.from({length: TITLE_RULES_MAX + 5}, (_, i) => ['', `t${i}`, `L${i}`]));
eq('compile: at most 100 rules', [compiled.rules.length, compiled.rules.at(-1)?.label, compiled.problems.length],
    [TITLE_RULES_MAX, `L${TITLE_RULES_MAX - 1}`, 1]);
eq('compile: not an array -> no rules', compileTitleRules(null).rules, []);

// --- applyTitleRules ---------------------------------------------------------------------
const rules = compileTitleRules([
    ['org.mozilla.firefox', '*Discord*', 'Discord (private)'],
    ['', '*Discord*', ''],
    ['Slack', '*', 'never: refused'],
    ['slack', '*DM*', 'Slack DM'],
    ['', 'Inbox (*)*', 'Mail'],
]).rules;
const apply = (title, appId, wmClass) => applyTitleRules(title, appId, wmClass, rules);
eq('app-scoped relabel', apply('Friends - Discord — Mozilla Firefox', 'org.mozilla.firefox.desktop', 'firefox'),
    'Discord (private)');
eq('app id matches without .desktop (the way exclusions do)',
    apply('x Discord', 'org.mozilla.firefox', ''), 'Discord (private)');
eq('app-scoped rule does not hit another app: the next (any-app) rule blanks it',
    apply('Discord', 'com.discordapp.Discord.desktop', 'discord'), '');
eq('wm_class matches case-insensitively', apply('DM with Bob', '', 'Slack'), 'Slack DM');
eq('app id is compared exactly (case matters)', apply('DM with Bob', 'SLACK.desktop', ''), 'DM with Bob');
eq('no rule matches -> unchanged', apply('Terminal', 'org.gnome.Ptyxis.desktop', 'ptyxis'), 'Terminal');
eq('first match wins (order)', applyTitleRules('Inbox (3) - Discord', '', '', compileTitleRules([
    ['', 'Inbox*', 'first'], ['', '*Discord', 'second']]).rules), 'first');
eq('first match wins (reversed order)', applyTitleRules('Inbox (3) - Discord', '', '', compileTitleRules([
    ['', '*Discord', 'second'], ['', 'Inbox*', 'first']]).rules), 'second');
eq('matched on the title with control characters as spaces',
    applyTitleRules('Chat\n- Bob', '', '', compileTitleRules([['', 'Chat - *', 'Chat']]).rules), 'Chat');

// --- windowPayload with rules ------------------------------------------------------------
const raw = (title, appId = 'org.mozilla.firefox.desktop', wmClass = 'firefox') =>
    ({appId, appName: 'Firefox', wmClass, title});
eq('payload: relabeled', windowPayload(raw('Bob - Discord'), [], {rules}).title, 'Discord (private)');
eq('payload: blanked', windowPayload(raw('Bob - Discord', 'x.desktop', 'x'), [], {rules}).title, '');
eq('payload: excluded app wins (empty, not the label)',
    windowPayload(raw('Bob - Discord'), ['org.mozilla.firefox'], {rules}).title, '');
eq('payload: no rules -> the title', windowPayload(raw('Bob - Discord')).title, 'Bob - Discord');
const longTitle = 'p'.repeat(5000) + ' - Discord';
eq('payload: rules see the raw title before truncation',
    [windowPayload(raw(longTitle), [], {rules}).title, [...windowPayload(raw(longTitle)).title].length],
    ['Discord (private)', TITLE_MAX_CHARS]);
eq('payload: the label is sanitized like a title', windowPayload(raw('t'), [],
    {rules: compileTitleRules([['', 't', 'a\tb']]).rules}).title, 'a b');

// --- prefs parser ---------------------------------------------------------------------
let parsed = parseTitleRules([
    {app: ' firefox ', pattern: '*Discord*', label: 'Discord'},
    {app: '', pattern: '', label: ''},
    {app: '', pattern: '**', label: 'x'},
    {app: '', pattern: long, label: ''},
    {app: '', pattern: 'a', label: long},
    {app: '', pattern: ' *Mail* ', label: ''},
]);
eq('parse: valid rows saved (app trimmed, pattern and label kept)', parsed.rules,
    [['firefox', '*Discord*', 'Discord'], ['', ' *Mail* ', '']]);
eq('parse: one error per refused row, null for good rows',
    parsed.errors.map(e => (e === null ? null : typeof e)), [null, 'string', 'string', 'string', 'string', null]);
eq('parse: all-* refusal says why', /every title/.test(parsed.errors[2]), true);
parsed = parseTitleRules(Array.from({length: TITLE_RULES_MAX + 2}, (_, i) => ({app: '', pattern: `p${i}`, label: ''})));
eq('parse: rows past 100 are refused', [parsed.rules.length, parsed.errors.filter(Boolean).length],
    [TITLE_RULES_MAX, 2]);
eq('parse: missing fields are empty', parseTitleRules([{pattern: 'x'}]).rules, [['', 'x', '']]);
eq('format: settings tuples -> rows', formatTitleRules([['a', 'b', 'c']]), [{app: 'a', pattern: 'b', label: 'c'}]);
eq('format then parse round-trips', parseTitleRules(formatTitleRules([['a', '*b*', ''], ['', 'c?', 'd']])).rules,
    [['a', '*b*', ''], ['', 'c?', 'd']]);

// --- sameCounter (day_summary_evidence._same_title, collapse_digits=True) -------------
eq('counter: equal', [sameCounter('a', 'a'), sameCounter('', '')], [true, true]);
eq('counter: FPS ticks', [sameCounter('fps:5', 'fps:12'), sameCounter('(9) Chat', '(10) Chat'),
    sameCounter('NinjaOne 30 FPS 120 ms', 'NinjaOne 31 FPS 99 ms')], [true, true, true]);
eq('counter: a ticket number (5 digits) is a change', sameCounter('#20591 Fix', '#20592 Fix'), false);
eq('counter: 4 digits on either side is a change', [sameCounter('999 FPS', '1000 FPS'),
    sameCounter('1000 FPS', '999 FPS'), sameCounter('1000 FPS', '1001 FPS')], [false, false, false]);
eq('counter: an unchanged long run does not matter', sameCounter('#20591 at 5%', '#20591 at 6%'), true);
eq('counter: text change', [sameCounter('a1b', 'a1c'), sameCounter('fps 5', 'FPS 5')], [false, false]);
eq('counter: digits appearing or vanishing', [sameCounter('a1', 'a1 b2'), sameCounter('a', 'a1'),
    sameCounter('1a', 'a')], [false, false, false]);
eq('counter: leading and trailing runs', [sameCounter('1.2.3', '1.2.4'), sameCounter('12abc', '7abc')], [true, true]);
eq('counter: only ASCII digits are digits', [sameCounter('x٣', 'x٤'), sameCounter('x３', 'x４')], [false, false]);

// --- counterTick (payload level) ----------------------------------------------------------
const P = (title, extra = {}) => ({focus: 'window', app_id: 'a', app_name: 'A', wm_class: 'a', title, ...extra});
eq('tick: same app, counter title', counterTick(P('fps 5'), P('fps 6')), true);
eq('tick: needs a last payload and windows', [counterTick(P('fps 5'), null), counterTick({focus: 'none'},
    {focus: 'none'}), counterTick(P('x'), {focus: 'none'})], [false, false, false]);
eq('tick: app fields must match', [counterTick(P('1', {app_id: 'b'}), P('2')), counterTick(P('1', {app_name: 'B'}),
    P('2')), counterTick(P('1', {wm_class: 'b'}), P('2'))], [false, false, false]);
eq('tick: monitors must match', [counterTick(P('1', {monitors: [[0, 0, 1, 1]]}), P('2', {monitors: [[0, 0, 1, 1]]})),
    counterTick(P('1', {monitors: [[0, 0, 1, 1]]}), P('2', {monitors: [[1, 0, 1, 1]]})),
    counterTick(P('1', {monitors: [[0, 0, 1, 1]]}), P('2'))], [true, false, false]);
eq('tick: changed_at is ignored', counterTick(P('1', {changed_at: 'x'}), P('2', {changed_at: 'y'})), true);

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
