// Review finding (gnome-mic-review): the top-bar microphone icon follows mic.on
// only, so it shows "microphone live" while nothing is or will be captured
// this session: limit_reached (holds for the rest of the session) and failed
// (no retry; only off/on re-resolves). RELIABILITY.md sections 4 and 7.
// Run: gjs -m tests/mic_review_indicator_test.js
import System from 'system';

import {buildView} from '../whatdidido@wporter.org/lib/model.js';

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

const status = state => ({
    state: 'recording', monitors: 1, samples: 4, interval_seconds: 30, last_error: null, reason: null,
    mic: {available: true, on: true, source_id: '202', stable_id: 'usb-x', label: 'USB headset', state, remembered: false},
});

const ON_NAME = 'whatdidido: Recording, microphone on';
for (const state of ['capturing', 'pending', 'waiting_for_device', 'retrying', undefined]) {
    const name = state ?? 'no mic.state (older server)';
    eq(`${name}: live mic icon`, buildView(status(state)).micIndicator, true);
    eq(`${name}: accessible name says microphone on`, buildView(status(state)).accessibleName, ON_NAME);
}
for (const state of ['limit_reached', 'failed']) {
    eq(`${state}: no live mic icon (not capturing, will not resume)`, buildView(status(state)).micIndicator, false);
    eq(`${state}: accessible name without microphone on`, buildView(status(state)).accessibleName, 'whatdidido: Recording');
}
eq('icon hidden by setting, accessible name still says on',
    [buildView(status('capturing'), {showMic: false}).micIndicator, buildView(status('capturing'), {showMic: false}).accessibleName], [false, ON_NAME]);
eq('not running: accessible name', buildView(null, {running: false}).accessibleName, 'whatdidido: whatdidido not running');

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
