// Run: gjs -m tests/window_title_rules_test.js
// Window title rules (whatdidido TIME_ACCOUNTING.md "Later": title rules):
// (app, pattern, label) entries whose case-insensitive glob over the whole
// title replaces it with the label before it leaves the shell, failing
// closed (every title empty) while the setting holds an entry that can't be
// used or the title is too long to match, the prefs parser that refuses
// empty and all-* patterns, and the counter rule
// (sameCounter, the server's day_summary_evidence._same_title) the digit
// filter uses.
import GLib from 'gi://GLib';
import System from 'system';

import {
    TITLE_RULES_MAX, TITLE_RULE_FIELD_MAX, TITLE_RULE_PATTERN_MAX, TITLE_RULE_MATCH_MAX, TITLE_MAX_CHARS, globMatch, compileTitleRules,
    applyTitleRules, titleRuleProblem, titleEntryProblem, parseTitleRule, formatTitleRules, sameCounter, counterTick,
    windowPayload,
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

// 60-character patterns: the matcher's state fits two 32-bit words, which
// keeps the worst case at the caps inside a frame (see adversarial below).
eq('caps', [TITLE_RULES_MAX, TITLE_RULE_FIELD_MAX, TITLE_RULE_PATTERN_MAX, TITLE_RULE_MATCH_MAX], [100, 200, 60, 4096]);

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
    const plen = rand(TITLE_RULE_PATTERN_MAX + 1), tlen = rand(90);
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
    globMatch('x'.repeat(31) + '?' + 'y'.repeat(28), 'x'.repeat(31) + 'Q' + 'y'.repeat(28)),
    globMatch('x'.repeat(31) + '*' + 'y'.repeat(28), 'x'.repeat(31) + 'qqq' + 'y'.repeat(28)),
    globMatch('x'.repeat(31) + '*' + 'y'.repeat(28), 'x'.repeat(30) + 'qqq' + 'y'.repeat(28)),
    globMatch('x'.repeat(60), 'x'.repeat(60)), globMatch('x'.repeat(60), 'x'.repeat(59)),
], [true, true, false, true, false]);

// --- adversarial performance ----------------------------------------------------------
// A catastrophic-backtracking shape for regex engines: 100 rules of 60
// characters (the caps) that never die and never match, against the longest
// title that is matched (4096 characters). One title change runs this once
// in the shell's main loop: it has to fit well inside a 16 ms frame. Best
// of 5, against machine noise.
const evilPattern = '*a'.repeat(29) + '*b', evilPattern2 = `*${'a?'.repeat(29)}b`;
eq('adversarial patterns are at the cap', [[...evilPattern].length, [...evilPattern2].length],
    [TITLE_RULE_PATTERN_MAX, TITLE_RULE_PATTERN_MAX]);
const evilRules = compileTitleRules(Array.from({length: TITLE_RULES_MAX}, (_, i) =>
    ['', i % 2 ? evilPattern : evilPattern2, 'x'.repeat(TITLE_RULE_FIELD_MAX)])).rules;
const best = fn => {
    let ms = Infinity, result;
    for (let i = 0; i < 5; i++) {
        const start = GLib.get_monotonic_time();
        result = fn();
        ms = Math.min(ms, (GLib.get_monotonic_time() - start) / 1000);
    }
    return [result, ms];
};
const evilTitle = 'a'.repeat(TITLE_RULE_MATCH_MAX);
let [result, elapsed] = best(() => applyTitleRules(evilTitle, '', '', evilRules));
eq('adversarial: no rule matches', result, evilTitle);
print(`     adversarial: ${TITLE_RULES_MAX} rules x ${TITLE_RULE_PATTERN_MAX} chars on a ${TITLE_RULE_MATCH_MAX}-char title in ${elapsed.toFixed(2)} ms`);
eq('adversarial: the caps fit well inside a frame (under 8 ms)', elapsed < 8, true);
[result, elapsed] = best(() => applyTitleRules('a'.repeat(1000000), '', '', evilRules));
print(`     adversarial: a 1000000-char title in ${elapsed.toFixed(2)} ms`);
eq('adversarial: a longer title is not matched at all, just emptied (under 8 ms)', [result, elapsed < 8], ['', true]);

// --- rule validation -----------------------------------------------------------------
const long = 'x'.repeat(TITLE_RULE_FIELD_MAX + 1);
eq('valid rule: no problem', [titleRuleProblem('', '*Discord*', ''), titleRuleProblem('firefox', 'a', 'b')],
    [null, null]);
eq('refused: empty pattern', typeof titleRuleProblem('', '', 'x'), 'string');
eq('refused: all-* patterns', ['*', '**', '*****'].map(p => typeof titleRuleProblem('', p, '')),
    ['string', 'string', 'string']);
eq('allowed: * with something else', [titleRuleProblem('', '*?*', ''), titleRuleProblem('', ' ', '')], [null, null]);
eq('refused: pattern over 60, label over 200 characters',
    [typeof titleRuleProblem('', 'x'.repeat(61), ''), typeof titleRuleProblem('', 'a', long)], ['string', 'string']);
eq('allowed: exactly 200 characters, counted in code points',
    [titleRuleProblem('', '😀'.repeat(60), '😀'.repeat(200)), typeof titleRuleProblem('', '😀'.repeat(61), ''),
        typeof titleRuleProblem('', 'a', '😀'.repeat(201))],
    [null, 'string', 'string']);
eq('refused: non-string fields', typeof titleRuleProblem('', 5, ''), 'string');

// --- compileTitleRules (the model side: hand-edited dconf) ------------------------------
// One entry the model can't use and every title is sent empty (fail
// closed): the rule meant to hide a title must never be skipped silently.
const blank = entries => applyTitleRules('Terminal', 'org.gnome.Ptyxis.desktop', 'ptyxis',
    compileTitleRules(entries).rules);
eq('compile: valid rules leave other titles alone', blank([['', '*q*', 'Q'], ['x', '*b*', 'B']]), 'Terminal');
eq('compile: no rules leave titles alone', [blank([]), blank(undefined)], ['Terminal', 'Terminal']);
eq('fail closed: an empty pattern', blank([['', '*z*', 'Z'], ['', '', 'empty']]), '');
eq('fail closed: an all-* pattern', blank([['', '**', 'all']]), '');
eq('fail closed: a pattern over 60 or a label over 200 characters', [blank([['', long, '']]), blank([['', 'q', long]])],
    ['', '']);
eq('fail closed: not (app, pattern, label)', [blank([['x', 'y']]), blank(['junk']), blank([['', 5, '']]),
    blank([['', 'y', 'z', 'w']])], ['', '', '', '']);
eq('fail closed: not a list', [blank(null), blank('junk'), blank({})], ['', '', '']);
eq('fail closed: more than 100 rules', [
    blank(Array.from({length: TITLE_RULES_MAX}, (_, i) => ['', `t${i}`, `L${i}`])),
    blank(Array.from({length: TITLE_RULES_MAX + 1}, (_, i) => ['', `t${i}`, `L${i}`])),
], ['Terminal', '']);
eq('fail closed: the valid rules\' labels are not used either',
    applyTitleRules('secret', '', '', compileTitleRules([['', 'secret', 'S'], ['', '', '']]).rules), '');
let compiled = compileTitleRules([['', '*a*', 'A'], ['', '', 'empty'], ['', '*', 'all'], ['', long, ''],
    ['x', 'y'], 'junk', ['', '*b*', 'B']]);
eq('compile: one problem per bad entry, numbered from 1, never the entry text',
    [compiled.problems.length, compiled.problems.every(m => !m.includes(long) && !m.includes('empty')),
        compiled.problems.map(m => m.match(/^rule (\d+):/)?.[1])],
    [5, true, ['2', '3', '4', '5', '6']]);
compiled = compileTitleRules(Array.from({length: TITLE_RULES_MAX + 5}, (_, i) => ['', `t${i}`, `L${i}`]));
eq('compile: too many rules is one problem with the count', [compiled.problems.length,
    /100/.test(compiled.problems[0]), /105/.test(compiled.problems[0])], [1, true, true]);
eq('compile: valid setting, no problems', compileTitleRules([['', 'a', '']]).problems, []);
eq('entry problem: the 101st entry', [titleEntryProblem(['', 'a', ''], TITLE_RULES_MAX - 1),
    typeof titleEntryProblem(['', 'a', ''], TITLE_RULES_MAX), typeof titleEntryProblem(['', ''], 0)],
[null, 'string', 'string']);

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
const longTitle = 'p'.repeat(TITLE_RULE_MATCH_MAX - 10) + ' - Discord';
eq('payload: rules see the raw title before truncation',
    [windowPayload(raw(longTitle), [], {rules}).title, [...windowPayload(raw(longTitle)).title].length],
    ['Discord (private)', TITLE_MAX_CHARS]);
eq('payload: fail closed: one bad entry blanks every title',
    windowPayload(raw('Terminal'), [], {rules: compileTitleRules([['', '*Discord*', 'D'], ['', '', '']]).rules}).title,
    '');

// --- titles too long to match (fail closed) ---------------------------------------------
const otherApp = compileTitleRules([['com.example.Other', 'zzz', 'Z']]).rules;
eq('match bound: 4096 code points are matched, 4097 are emptied, whatever the rule', [
    applyTitleRules('a'.repeat(TITLE_RULE_MATCH_MAX), 'x.desktop', 'x', otherApp) === 'a'.repeat(TITLE_RULE_MATCH_MAX),
    applyTitleRules('a'.repeat(TITLE_RULE_MATCH_MAX + 1), 'x.desktop', 'x', otherApp),
], [true, '']);
eq('match bound: counted in code points (astral emoji)', [
    applyTitleRules('😀'.repeat(TITLE_RULE_MATCH_MAX), '', '', otherApp).length,
    applyTitleRules('😀'.repeat(TITLE_RULE_MATCH_MAX + 1), '', '', otherApp),
], [2 * TITLE_RULE_MATCH_MAX, '']);
eq('match bound: no rules, no bound (just shortened)',
    [...windowPayload(raw('q'.repeat(TITLE_RULE_MATCH_MAX + 1))).title].length, TITLE_MAX_CHARS);
eq('match bound: a rule that would match past the bound still empties',
    windowPayload(raw('p'.repeat(TITLE_RULE_MATCH_MAX) + ' - Discord'), [], {rules}).title, '');
eq('payload: the label is sanitized like a title', windowPayload(raw('t'), [],
    {rules: compileTitleRules([['', 't', 'a\tb']]).rules}).title, 'a b');

// --- prefs parser (one row) -------------------------------------------------------------
const row = (app, pattern, label, i = 0) => parseTitleRule({app, pattern, label}, i);
eq('parse: valid row (app trimmed, pattern and label kept)', [row(' firefox ', '*Discord*', 'Discord'),
    row('', ' *Mail* ', '')], [{rule: ['firefox', '*Discord*', 'Discord'], problem: null},
    {rule: ['', ' *Mail* ', ''], problem: null}]);
eq('parse: refused rows have a problem',
    [row('', '', ''), row('', '**', 'x'), row('', long, ''), row('', 'a', long)].map(r => typeof r.problem),
    ['string', 'string', 'string', 'string']);
eq('parse: all-* refusal says why', /every title/.test(row('', '**', 'x').problem), true);
eq('parse: row 101 is refused', [row('', 'p', '', TITLE_RULES_MAX - 1).problem,
    typeof row('', 'p', '', TITLE_RULES_MAX).problem], [null, 'string']);
eq('parse: missing fields are empty', parseTitleRule({pattern: 'x'}, 0).rule, ['', 'x', '']);
eq('format: settings tuples -> rows', formatTitleRules([['a', 'b', 'c']]), [{app: 'a', pattern: 'b', label: 'c'}]);
eq('format then parse round-trips', formatTitleRules([['a', '*b*', ''], ['', 'c?', 'd']]).map(parseTitleRule)
    .map(r => r.rule), [['a', '*b*', ''], ['', 'c?', 'd']]);

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
