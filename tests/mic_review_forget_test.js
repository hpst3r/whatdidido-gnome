// Review finding (gnome-mic-review): prefs "Forget microphone" clears the three
// keys one set_string at a time, stable id FIRST. The extension sees each
// write as its own change; an inventory read (menu open -> _loadMics ->
// setInventory, which migrates a legacy microphone-id) landing between the
// first and second write re-saves the stable id from the not yet cleared
// microphone-id. The forgotten microphone is chosen again and the next switch
// on POSTs it instead of asking "Choose a microphone".
// Run: gjs -m tests/mic_review_forget_test.js
import GLib from 'gi://GLib';
import System from 'system';

import {MicController, hasMicChoice} from '../whatdidido@wporter.org/lib/mic_model.js';

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

// The Forget button's key order, read from prefs.js (GTK; not importable here).
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([here, '..', 'whatdidido@wporter.org', 'prefs.js']));
const src = new TextDecoder().decode(bytes);
const m = src.match(/const MIC_KEYS = \[([^\]]*)\];[\s\S]*?forget\.connect\('clicked', \(\) => \{\s*for \(const key of MIC_KEYS\)\s*settings\.set_string\(key, ''\);/);
if (!m) {
    print('FAIL could not find the Forget handler in prefs.js (changed?)');
    System.exit(1);
}
const forgetOrder = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);

const USB = {id: '202', label: 'USB headset', stable_id: 'usb-x'};
const BUILTIN = {id: '7', label: 'Built-in', stable_id: 'pci-builtin'};
const inventory = [BUILTIN, USB];

const store = {'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'};
const posts = [];
const ctl = new MicController({
    settings: {get: k => store[k], set: (k, v) => {
        store[k] = v;
    }},
    setMicOn: (on, preferred) => {
        posts.push({on, preferred});
        return Promise.resolve();
    },
});
ctl.setInventory(inventory);
ctl.updateStatus({state: 'recording', mic: {available: true, on: false, source_id: null}}, true);

// Forget, with an in-flight inventory read completing after each write but
// the last (each write from the prefs process is a separate change).
forgetOrder.forEach((key, i) => {
    store[key] = '';
    if (i < forgetOrder.length - 1)
        ctl.setInventory(inventory);
});

eq('after Forget no microphone is chosen', hasMicChoice(ctl.preferred), false);
eq('after Forget all three keys are empty', forgetOrder.map(k => store[k]), ['', '', '']);
const result = await ctl.toggle(true, null);
eq('after Forget the switch asks to choose', result, 'choose');
eq('after Forget nothing is turned on', posts.filter(p => p.on), []);

// Migration needs the legacy id AND its label: a half-cleared choice (in any
// order the keys are written) never adopts a stable id again.
for (const half of [{'microphone-id': '202', 'microphone-label': ''}, {'microphone-id': '', 'microphone-label': 'USB headset'}]) {
    Object.assign(store, {'microphone-stable-id': ''}, half);
    ctl.setInventory(inventory);
    eq(`half-cleared ${JSON.stringify(half)}: no stable id adopted`, store['microphone-stable-id'], '');
}

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
