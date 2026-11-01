// No OutputController path sends output-on (which the client always sends
// with consent: true) without the consent dialog confirmed in that same
// action, other than switching an output that is already on (from the
// outmon-ext review).
// Run: gjs -m tests/output_consent_test.js
import GLib from 'gi://GLib';
import System from 'system';

import {OUTPUT_KEYS, OutputController} from '../whatdidido@wporter.org/lib/output_model.js';

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

const DOCK = {id: '88', label: 'Dock Headphones', stable_id: 'alsa_output.usb-dock'};
const SPK = {id: '61', label: 'Built-in Speakers', stable_id: 'alsa_output.pci'};
const OFF = {available: true, on: false, source_id: null, stable_id: null, label: null, state: 'off', remembered: false};
const ON = {available: true, on: true, source_id: '88', stable_id: 'alsa_output.usb-dock', label: 'Dock Headphones',
    state: 'capturing', remembered: true};
const st = (output, state = 'recording') => ({state, mic: {available: true, on: false}, output});

function make({saved = {}, status = st(OFF), answers = []} = {}) {
    const store = {[OUTPUT_KEYS.stableId]: '', [OUTPUT_KEYS.id]: '', [OUTPUT_KEYS.label]: '', ...saved};
    const log = {sent: [], asked: 0, pending: []};
    const c = new OutputController({
        settings: {get: k => store[k], set: (k, v) => (store[k] = v)},
        setOutputOn: async (on, preferred) => {
            log.sent.push({on, stableId: preferred.stableId});
        },
        readStatus: async () => log.status,
        confirm: () => {
            log.asked++;
            if (answers.length)
                return Promise.resolve(answers.shift());
            return new Promise(resolve => log.pending.push(resolve));
        },
    });
    log.status = status;
    return {c, log, store};
}
const saved = {[OUTPUT_KEYS.stableId]: DOCK.stable_id, [OUTPUT_KEYS.id]: DOCK.id, [OUTPUT_KEYS.label]: DOCK.label};
const item = o => ({id: o.id, stableId: o.stable_id, label: o.label, checked: false});
const tick = () => new Promise(r => setTimeout(r, 0));

async function main() {
    // 1. Polling and inventory reads, even of a remembered "on", never ask or send.
    {
        const {c, log} = make({saved, status: st(ON)});
        for (const s of [st(ON), st(OFF), st(ON, 'paused'), st(ON, 'stopped'), null])
            c.updateStatus(s, s !== null);
        c.setInventory([DOCK, SPK]);
        c.setInventory(null);
        c.menuClosed();
        c.view();
        eq('poll/inventory/menu close: nothing asked', log.asked, 0);
        eq('poll/inventory/menu close: nothing sent', log.sent, []);
    }
    // 2. Tile on, Cancel / dialog throws / non-true answers: nothing sent.
    for (const answer of [false, undefined, 'true', 1, null]) {
        const {c, log} = make({saved, answers: [answer]});
        const r = await c.toggle(true, null);
        eq(`tile on, dialog answers ${JSON.stringify(answer)}: cancelled, nothing sent`, [r, log.sent], ['cancelled', []]);
    }
    {
        const {c, log} = make({saved});
        c._confirm = () => Promise.reject(new Error('dialog destroyed'));
        eq('tile on, dialog rejects: nothing sent', [await c.toggle(true, null), log.sent], ['cancelled', []]);
    }
    // 3. Tile on, then Off while the dialog is open, then the confirm: off wins.
    {
        const {c, log} = make({saved});
        const on = c.toggle(true, null);
        await tick();
        const off = c.toggle(false, null);
        log.pending.shift()(true);
        eq('on, off during dialog, confirm: superseded then off', [await on, await off], ['superseded', 'off']);
        eq('on, off during dialog, confirm: only off sent', log.sent, [{on: false, stableId: 'alsa_output.usb-dock'}]);
    }
    // 4. Pick while off and not asked (any session state): only saves.
    for (const state of ['recording', 'paused', 'stopped', 'failed', 'recovering', 'starting', 'stopping']) {
        const {c, log} = make({status: st(OFF, state)});
        const r = await c.choose(item(SPK), null);
        eq(`pick while off (${state}), not asked: saved, nothing asked or sent`, [r, log.asked, log.sent], ['saved', 0, []]);
    }
    // 5. Tile with no saved choice -> list -> pick: asks; Cancel sends nothing.
    {
        const {c, log} = make({answers: [false]});
        eq('tile without a choice: choose', await c.toggle(true, null), 'choose');
        eq('pick after the tile asked, Cancel: nothing sent', [await c.choose(item(SPK), null), log.asked, log.sent],
            ['cancelled', 1, []]);
    }
    // 6. The prompt is dropped on menu close (the dialog closes the menu itself,
    //    but choose() read it before).
    {
        const {c, log} = make({answers: [true]});
        await c.toggle(true, null);
        c.menuClosed();
        eq('tile asked, menu closed, later pick: saved only', [await c.choose(item(SPK), null), log.sent], ['saved', []]);
    }
    // 7. Pick while the output is on but the fresh status says it went off: save only.
    {
        const {c, log} = make({saved, status: st(OFF)});
        c.updateStatus(st(ON), true);
        eq('pick, stale on but fresh off: saved, nothing sent', [await c.choose(item(SPK), null), log.sent], ['saved', []]);
    }
    // 8. Switching an output that is on: no dialog, one on (contract allows).
    {
        const {c, log} = make({saved, status: st(ON)});
        eq('switch while on: no dialog, sent', [await c.choose(item(SPK), null), log.asked, log.sent],
            ['on', 0, [{on: true, stableId: 'alsa_output.pci'}]]);
    }
    // 9. Forget (prefs) while the dialog is open: the confirm sends nothing for a
    //    choice that no longer exists (the client refuses output_unset itself).
    {
        const {c, log, store} = make({saved});
        const on = c.toggle(true, null);
        await tick();
        for (const k of ['output-id', 'output-label', 'output-stable-id'])
            store[k] = '';
        log.pending.shift()(true);
        await on;
        eq('forget during dialog, confirm: preferred empty at send', log.sent, [{on: true, stableId: ''}]);
    }
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    failed++;
    print(`FAIL uncaught: ${e}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
