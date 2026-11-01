// Output monitor with output.available false (from the outmon-ext review).
// The real server reports available false after one failed inventory read
// (work_session_backend.py _role_status: available = gate and not closed and
// _inventory_readable) while the output keeps capturing. Feature detection is
// "the status has an `output` object"; available false hides the Output source
// picker and greys an off tile, like the microphone, but the tile stays with a
// working Off while output.on, and the speaker icon and accessible name follow
// output.on and its state like the microphone's.
// Run: gjs -m tests/output_indicator_test.js
import System from 'system';

import {buildView, micSwitch, outputSwitch} from '../whatdidido@wporter.org/lib/model.js';
import {OutputController, outputHint, outputOffered} from '../whatdidido@wporter.org/lib/output_model.js';
import {popoverView} from '../whatdidido@wporter.org/lib/popover_model.js';

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

// Exactly what the real router answered for this controller state
// (the "inventory-unreadable output" case of the review's router probe).
const OUTPUT_UNREADABLE = {available: false, on: true, source_id: '88', stable_id: 'alsa_output.usb-dock',
    label: 'Dock Headphones', state: 'capturing', remembered: false};
const OUTPUT_UNREADABLE_OFF = {available: false, on: false, source_id: null, stable_id: null, label: null, state: 'off', remembered: false};
const MIC_UNREADABLE = {available: false, on: true, source_id: '52', stable_id: 'usb-mic',
    label: 'USB Desk Microphone', state: 'capturing', remembered: false};
const MIC_OFF = {available: false, on: false, source_id: null, stable_id: null, label: null, state: 'off', remembered: false};
const base = {state: 'recording', monitors: 1, samples: 3, interval_seconds: 5, last_error: null, reason: null};
const st = (output, state = 'recording') => ({...base, state, mic: MIC_OFF, ...(output === undefined ? {} : {output})});

// Control: the microphone's icon stays on through an unreadable inventory.
const micView = buildView({...base, mic: MIC_UNREADABLE}, {running: true});
eq('mic capturing, inventory unreadable: mic icon shown', micView.micIndicator, true);

// The output, same situation: the contract says "same rules as the mic indicator".
const outView = buildView(st(OUTPUT_UNREADABLE), {running: true});
eq('output capturing, inventory unreadable: speaker icon shown', outView.outputIndicator, true);
eq('output capturing, inventory unreadable: accessible name says output on',
    outView.accessibleName.includes('output on'), true);
for (const state of ['limit_reached', 'failed'])
    eq(`output ${state}, inventory unreadable: no speaker icon (like the mic)`,
        buildView(st({...OUTPUT_UNREADABLE, state})).outputIndicator, false);
eq('output on, inventory unreadable, icon setting off: hidden, name still says on',
    [buildView(st(OUTPUT_UNREADABLE), {showOutput: false}).outputIndicator,
        buildView(st(OUTPUT_UNREADABLE), {showOutput: false}).accessibleName], [false, 'whatdidido: Recording, output on']);
eq('output off, inventory unreadable: no icon', buildView(st(OUTPUT_UNREADABLE_OFF)).outputIndicator, false);
eq('not running: no icon', buildView(st(OUTPUT_UNREADABLE), {running: false}).outputIndicator, false);

// Feature detection: the status has an `output` object.
eq('offered: output object with available false', outputOffered(st(OUTPUT_UNREADABLE_OFF), true), true);
eq('not offered: no output key (older or ungated server)', outputOffered(st(undefined), true), false);
eq('not offered: output null', outputOffered(st(null), true), false);
eq('not offered: output not an object', [outputOffered(st('on'), true), outputOffered(st([]), true)], [false, false]);
eq('not offered: not running', outputOffered(st(OUTPUT_UNREADABLE), false), false);

// The tile: visible with a working Off while on; an off tile greys out like the mic's.
const pop = popoverView(st(OUTPUT_UNREADABLE), {});
const tile = pop.tiles.output;
eq('output capturing, inventory unreadable: Output tile still shown', tile.visible, true);
eq('output capturing, inventory unreadable: tile on, sensitive, action Off',
    [tile.on, tile.accent, tile.sensitive, tile.action], [true, true, true, {action: 'output', on: false}]);
eq('output capturing, inventory unreadable: subtitle names the output', tile.subtitle, 'On · Dock Headphones');
eq('output on, inventory unreadable, starting: Off waits like every switch',
    popoverView(st(OUTPUT_UNREADABLE, 'starting'), {}).tiles.output.sensitive, false);
eq('switch: on with available false is sensitive (Off works on the server)',
    outputSwitch(st(OUTPUT_UNREADABLE), true), {sensitive: true, on: true});
const offTile = popoverView(st(OUTPUT_UNREADABLE_OFF), {outputChoiceLabel: 'Dock Headphones'}).tiles.output;
eq('output off, inventory unreadable: tile visible, off, insensitive (like the mic)',
    [offTile.visible, offTile.on, offTile.sensitive], [true, false, false]);
eq('output off, inventory unreadable: subtitle', offTile.subtitle, 'Off · outputs unavailable');
eq('switch: off with available false matches the mic switch',
    outputSwitch(st(OUTPUT_UNREADABLE_OFF), true), micSwitch({...base, mic: MIC_OFF}, true));
eq('no output key: tile hidden', popoverView(st(undefined), {}).tiles.output.visible, false);

// The picker, like the Input picker: only while available is true.
eq('output on, inventory unreadable: Output source picker hidden (like Input)', pop.outputSource.visible, false);
eq('mic unavailable: Input picker hidden (the rule copied)', popoverView({...base, mic: MIC_UNREADABLE}, {}).input.visible, false);
eq('output on, inventory unreadable: picker never expands',
    popoverView(st(OUTPUT_UNREADABLE), {ui: {expanded: 'output'}}).outputSource.expanded, false);

// No "choose" hint while available is false (nothing can be chosen).
eq('hint: available false, asked -> nothing',
    outputHint(st(OUTPUT_UNREADABLE_OFF), {running: true, outputs: null, preferred: {}, prompt: true}), null);

// The controller sends the Off even though the inventory is unreadable.
async function controller() {
    const sent = [];
    const c = new OutputController({
        settings: {get: () => '', set: () => {}},
        setOutputOn: async on => sent.push(on),
        readStatus: async () => st(OUTPUT_UNREADABLE),
        confirm: async () => {
            throw new Error('never asked');
        },
    });
    c.updateStatus(st(OUTPUT_UNREADABLE), true);
    eq('tile Off with available false: sent off, nothing asked', [await c.toggle(false, null), sent], ['off', [false]]);
}
await controller();

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
