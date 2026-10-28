// Run: gjs -m tests/window_title_review_pattern_test.js
// Title rule patterns (from the review's PoCs, TR-1 and TR-2).
//
// TR-1: rules match the title with control characters turned into spaces,
// so the pattern's control characters are turned into spaces too: a pattern
// holding the title's own tab, newline or C1 character (copied from the
// title, or set through dconf) matches it, and Settings agrees.
// TR-2: Settings refuses an all-* pattern because it would hide every
// title, and so "?*", "*?" and "*?*", which match every non-empty title
// just the same (for a rule of any app; tests/window_title_rules_test.js
// covers app-scoped rules).
import System from 'system';

import {
    SETTLE_MS, SPACING_MS, WindowReporter, applyTitleRules, compileTitleRules, globMatch, parseTitleRule,
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

const drain = async () => {
    for (let i = 0; i < 20; i++)
        await null;
};
const st = {state: 'recording', window_activity: {available: true, recorded: 0, dropped: 0, epoch: 0, geometry: false}};
function harness(opts = {}) {
    const h = {t: 0, timers: new Map(), sent: [], logs: [],
        focus: {appId: 'org.gnome.Ptyxis.desktop', appName: 'Ptyxis', wmClass: 'org.gnome.Ptyxis', title: ''}};
    let nextId = 1;
    h.r = new WindowReporter({
        now: () => h.t,
        wallNow: () => 1e12 + h.t,
        setTimer: (ms, fn) => {
            const id = nextId++;
            h.timers.set(id, {at: h.t + ms, fn});
            return id;
        },
        clearTimer: id => h.timers.delete(id),
        readFocus: () => h.focus,
        log: m => h.logs.push(m),
        send: p => {
            h.sent.push(p);
            return Promise.resolve({recorded: true});
        },
        ...opts,
    });
    h.advance = async ms => {
        const end = h.t + ms;
        await drain();
        for (let guard = 0; guard < 1000; guard++) {
            let next = null;
            for (const [id, tm] of h.timers) {
                if (tm.at <= end && (!next || tm.at < next[1].at))
                    next = [id, tm];
            }
            if (!next)
                break;
            h.timers.delete(next[0]);
            h.t = next[1].at;
            next[1].fn();
            await drain();
        }
        h.t = end;
    };
    h.titles = () => h.sent.map(p => p.title);
    return h;
}

async function main() {
    // TR-1: the matcher sees "ssh\tprod-db" as "ssh prod-db"; the pattern
    // keeps its tab. Either fix passes: match it (normalize the pattern the
    // same way) or refuse the rule visibly (a problem), never a silently
    // dead rule.
    for (const [name, ch] of [['tab', '\t'], ['newline', '\n'], ['C1 NEL', '\u0085']]) {
        const title = `ssh${ch}prod-db-01`;
        const {rules, problems} = compileTitleRules([['', `ssh${ch}prod-db-*`, 'Terminal']]);
        const label = applyTitleRules(title, 'org.gnome.Ptyxis.desktop', 'org.gnome.Ptyxis', rules);
        eq(`TR-1 a pattern with the title's ${name} relabels it or is refused`,
            {relabeled: label === 'Terminal', refused: problems.length > 0, matches: globMatch(`ssh${ch}prod-db-*`, title)},
            problems.length > 0 ? {relabeled: false, refused: true, matches: false}
                : {relabeled: true, refused: false, matches: true});
        eq(`TR-1 Settings agrees with the extension on the ${name} rule`,
            parseTitleRule({app: '', pattern: `ssh${ch}prod-db-*`, label: 'Terminal'}, 0).problem !== null,
            problems.length > 0);
    }
    const h = harness({titleRules: [['', 'ssh\tprod-db-*', 'Terminal']]});
    h.focus.title = 'ssh\tprod-db-01';
    h.r.updateStatus(st, true);
    await h.advance(SETTLE_MS + SPACING_MS);
    eq('TR-1 wire: the rule relabels the title, or its refusal is logged', h.titles()[0] === 'Terminal' ||
        h.logs.some(m => /rule 1/.test(m)), true);

    // TR-2: patterns without a literal character match (almost) every title.
    const every = ['?*', '*?', '*?*', '?**'];
    for (const pattern of every)
        eq(`TR-2 "${pattern}" matches any non-empty title`, globMatch(pattern, 'Inbox - Mail'), true);
    eq('TR-2 Settings refuses patterns that hide every title, like it refuses "*"',
        every.map(pattern => parseTitleRule({app: '', pattern, label: ''}, 0).problem !== null), every.map(() => true));
}

await main();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
