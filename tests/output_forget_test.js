// Forget output (prefs) also turns the output off: prefs only clears the
// three output keys, so a remembered "on" would otherwise survive on the
// server. When the saved choice goes from set to cleared (output-stable-id and
// output-id both empty) while the latest status has output.on true, the
// extension sends {"on": false} once, without the consent dialog.
// Run: gjs -m tests/output_forget_test.js
import System from 'system';

import {OUTPUT_KEYS, OutputController, forgetTurnsOff} from '../whatdidido@wporter.org/lib/output_model.js';

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

const ON = {available: true, on: true, source_id: '88', stable_id: 'alsa_output.usb-dock', label: 'Dock Headphones',
    state: 'capturing', remembered: true};
const OFF = {available: true, on: false, source_id: null, stable_id: null, label: null, state: 'off', remembered: false};
const st = (output, state = 'recording') => ({state, mic: {available: true, on: false}, ...(output === undefined ? {} : {output})});
const SAVED = {[OUTPUT_KEYS.stableId]: 'alsa_output.usb-dock', [OUTPUT_KEYS.id]: '88', [OUTPUT_KEYS.label]: 'Dock Headphones'};
// prefs.js Forget output's write order: id, label, then the stable id.
const FORGET_ORDER = [OUTPUT_KEYS.id, OUTPUT_KEYS.label, OUTPUT_KEYS.stableId];

// The decision by itself.
eq('set -> cleared while on: off', forgetTurnsOff(true, false, st(ON), true), true);
eq('set -> cleared while on, inventory unreadable: off', forgetTurnsOff(true, false, st({...ON, available: false}), true), true);
eq('set -> cleared while on, paused: off', forgetTurnsOff(true, false, st(ON, 'paused'), true), true);
eq('set -> cleared while off: nothing', forgetTurnsOff(true, false, st(OFF), true), false);
eq('set -> cleared, no output object: nothing', forgetTurnsOff(true, false, st(undefined), true), false);
eq('set -> cleared, not running: nothing', forgetTurnsOff(true, false, st(ON), false), false);
eq('set -> cleared, no status: nothing', forgetTurnsOff(true, false, null, true), false);
eq('cleared -> cleared while on: nothing', forgetTurnsOff(false, false, st(ON), true), false);
eq('set -> set while on: nothing', forgetTurnsOff(true, true, st(ON), true), false);
eq('cleared -> set while on: nothing', forgetTurnsOff(false, true, st(ON), true), false);
eq('on truthy but not true: nothing', forgetTurnsOff(true, false, st({...ON, on: 1}), true), false);

// The controller, one savedChanged() per changed:: signal.
function make(saved, status, running = true) {
    const store = {[OUTPUT_KEYS.stableId]: '', [OUTPUT_KEYS.id]: '', [OUTPUT_KEYS.label]: '', ...saved};
    const c = new OutputController({
        settings: {get: k => store[k], set: (k, v) => (store[k] = v)},
        setOutputOn: async () => {},
        readStatus: async () => status,
        confirm: async () => true,
    });
    c.updateStatus(status, running);
    // Each write is its own changed:: signal; collect what each one decides.
    const write = (key, value) => {
        store[key] = value;
        return c.savedChanged();
    };
    const forget = () => FORGET_ORDER.map(key => write(key, ''));
    return {c, store, write, forget};
}

{
    const {forget} = make(SAVED, st(ON));
    eq('forget while on: off decided once, on the last key that clears the choice', forget(), [false, false, true]);
}
{
    const {forget} = make(SAVED, st(ON));
    forget();
    eq('a second forget (keys already empty): nothing', forget(), [false, false, false]);
}
{
    const {forget} = make(SAVED, st(OFF));
    eq('forget while off: nothing', forget(), [false, false, false]);
}
{
    const {forget} = make(SAVED, st(undefined));
    eq('forget, status without an output object: nothing', forget(), [false, false, false]);
}
{
    const {forget} = make(SAVED, null, false);
    eq('forget, not running: nothing', forget(), [false, false, false]);
}
{
    // Startup with empty keys: no transition, so nothing, even while on.
    const {c, write} = make({}, st(ON));
    eq('startup with empty keys while on: nothing', [c.savedChanged(), write(OUTPUT_KEYS.label, '')], [false, false]);
}
{
    // A choice made, then forgotten: fires for that forget.
    const {write, forget} = make({}, st(ON));
    write(OUTPUT_KEYS.stableId, 'alsa_output.usb-dock');
    eq('chosen after startup, then forgotten while on: off once', forget(), [false, false, true]);
}
{
    // A legacy choice (id only) cleared: off.
    const {forget} = make({[OUTPUT_KEYS.id]: '88', [OUTPUT_KEYS.label]: 'HDMI'}, st(ON));
    eq('legacy id-only choice forgotten while on: off once', forget(), [true, false, false]);
}
{
    // Choosing another output in the menu never clears the choice: nothing.
    const {c, write} = make(SAVED, st(ON));
    const got = [write(OUTPUT_KEYS.stableId, 'alsa_output.pci'), write(OUTPUT_KEYS.label, 'Speakers'), write(OUTPUT_KEYS.id, '61')];
    eq('choosing another output while on: nothing', got, [false, false, false]);
    eq('the controller is unaffected', c.preferred, {stableId: 'alsa_output.pci', id: '61', label: 'Speakers'});
}
{
    // The status read when the last key clears decides, not the one at startup.
    const {c, forget} = make(SAVED, st(OFF));
    c.updateStatus(st(ON), true);
    eq('status turned on after startup, then forget: off once', forget(), [false, false, true]);
}

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
