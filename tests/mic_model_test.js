// Explicit microphone selection (issue #1, whatdidido RELIABILITY.md section 10).
// Run: gjs -m tests/mic_model_test.js
import {
    CHOOSE_TEXT, MIC_KEYS, MicController,
    activeMicLabel, chooseMicrophone, hasMicChoice, liveSwitchNeeded, micHint,
    micSourceItems, micSwitchLabel, migrateStableId, missingText, preferredMic,
} from '../whatdidido@wporter.org/lib/mic_model.js';

let failed = 0;
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) {
        failed++;
        print(`FAIL ${name}: got ${g} want ${w}`);
    } else {
        print(`ok   ${name}`);
    }
}

const BUILTIN = {id: '7', label: 'Built-in', stable_id: 'pci-builtin'};
const USB_OLD = {id: '101', label: 'USB headset', stable_id: 'usb-x'};
const USB_NEW = {id: '202', label: 'USB headset', stable_id: 'usb-x'};
const pref = (stableId, id, label = 'USB headset') => ({stableId, id, label});
const idOf = m => m?.id ?? null;

// --- preferred microphone ----------------------------------------------------
eq('preferred normalizes missing keys', preferredMic({}), {stableId: '', id: '', label: ''});
eq('preferred ignores non-strings', preferredMic({stableId: 5, id: null, label: ['x']}), {stableId: '', id: '', label: ''});
eq('no choice', hasMicChoice(preferredMic({label: 'USB headset'})), false);
eq('choice by stable id', hasMicChoice(pref('usb-x', '')), true);
eq('choice by legacy id', hasMicChoice(pref('', '101')), true);
eq('setting keys', MIC_KEYS, {stableId: 'microphone-stable-id', id: 'microphone-id', label: 'microphone-label'});

// --- chooseMicrophone: unset, available, missing, reconnected -----------------
eq('unset -> null (no first-microphone fallback)', chooseMicrophone([BUILTIN, USB_NEW], pref('', '', '')), null);
eq('unset, one microphone -> still null', chooseMicrophone([BUILTIN], pref('', '', '')), null);
eq('available by stable id', idOf(chooseMicrophone([BUILTIN, USB_OLD], pref('usb-x', '101'))), '101');
eq('reconnected: stable id re-resolves to the new serial', idOf(chooseMicrophone([BUILTIN, USB_NEW], pref('usb-x', '101'))), '202');
eq('missing: stable id gone -> null, never the built-in', chooseMicrophone([BUILTIN], pref('usb-x', '101')), null);
eq('missing: stale legacy id is not used when a stable id is saved',
    chooseMicrophone([BUILTIN, {id: '101', label: 'USB headset', stable_id: 'other'}], pref('usb-x', '101')), null);
eq('ambiguous stable id -> null', chooseMicrophone([USB_OLD, USB_NEW], pref('usb-x', '')), null);
eq('empty inventory -> null', chooseMicrophone([], pref('usb-x', '101')), null);
eq('unknown inventory -> null', chooseMicrophone(null, pref('usb-x', '101')), null);
// Legacy: only microphone-id saved (before stable ids), or an old server.
eq('legacy id present -> it', idOf(chooseMicrophone([BUILTIN, USB_OLD], pref('', '101'))), '101');
eq('legacy id absent -> null (treated as unset, no fallback)', chooseMicrophone([BUILTIN, USB_NEW], pref('', '101')), null);
eq('legacy id reused by another device (label differs) -> null',
    chooseMicrophone([{id: '101', label: 'Built-in', stable_id: 'pci-builtin'}], pref('', '101')), null);
eq('legacy id without a saved label -> it', idOf(chooseMicrophone([USB_OLD], pref('', '101', ''))), '101');
const OLD_SERVER = [{id: 'm1', label: 'Built-in'}, {id: 'm2', label: 'USB headset'}];
eq('old server: stable id saved, legacy id matches', idOf(chooseMicrophone(OLD_SERVER, pref('usb-x', 'm2'))), 'm2');
eq('old server: legacy id gone -> null', chooseMicrophone(OLD_SERVER, pref('usb-x', 'gone')), null);
eq('new server, device without stable id: legacy id', idOf(chooseMicrophone([BUILTIN, {id: '9', label: 'Line in', stable_id: null}], pref('', '9', 'Line in'))), '9');

// --- migration (first inventory read) ----------------------------------------
eq('migrate: legacy id present with a stable id', migrateStableId([BUILTIN, USB_OLD], pref('', '101')), 'usb-x');
eq('migrate: legacy id absent -> nothing', migrateStableId([BUILTIN, USB_NEW], pref('', '101')), null);
eq('migrate: stable id already saved -> nothing', migrateStableId([BUILTIN, USB_OLD], pref('usb-y', '101')), null);
eq('migrate: device without stable id -> nothing', migrateStableId([{id: '9', label: 'USB headset', stable_id: null}], pref('', '9')), null);
eq('migrate: old server -> nothing', migrateStableId(OLD_SERVER, pref('', 'm2')), null);
eq('migrate: unset -> nothing', migrateStableId([BUILTIN], pref('', '')), null);
eq('migrate: legacy id without its label (half-cleared) -> nothing', migrateStableId([BUILTIN, USB_OLD], pref('', '101', '')), null);

// --- source submenu: the checked item is the saved preference only -------------
eq('items: reconnected preference checked', micSourceItems([BUILTIN, USB_NEW], pref('usb-x', '101')), [
    {id: '7', stableId: 'pci-builtin', label: 'Built-in', checked: false},
    {id: '202', stableId: 'usb-x', label: 'USB headset', checked: true}]);
eq('items: unset -> nothing checked', micSourceItems([BUILTIN, USB_NEW], pref('', '', '')).map(i => i.checked), [false, false]);
eq('items: missing -> nothing checked', micSourceItems([BUILTIN], pref('usb-x', '101')).map(i => i.checked), [false]);
eq('items: old server has no stable ids', micSourceItems(OLD_SERVER, pref('', 'm2')).map(i => [i.stableId, i.checked]), [['', false], ['', true]]);

// --- active microphone (distinct from the preference) ----------------------------
const status = (mic, state = 'recording') => ({state, mic: {available: true, ...mic}});
eq('active label from mic.label', activeMicLabel({on: true, source_id: '202', label: 'USB headset'}, [BUILTIN]), 'USB headset');
eq('active label from the inventory (old server)', activeMicLabel({on: true, source_id: '7'}, [BUILTIN, USB_NEW]), 'Built-in');
eq('active label unknown', activeMicLabel({on: true, source_id: '9'}, [BUILTIN]), null);
eq('switch label: capturing', micSwitchLabel(status({on: true, source_id: '202', stable_id: 'usb-x', label: 'USB headset', state: 'capturing'}), true, null),
    'Microphone: USB headset');
eq('switch label: waiting for device', micSwitchLabel(status({on: true, source_id: null, stable_id: 'usb-x', label: 'USB headset', state: 'waiting_for_device'}), true, null),
    'Microphone: USB headset (waiting for device)');
eq('switch label: retrying', micSwitchLabel(status({on: true, source_id: '202', label: 'USB headset', state: 'retrying'}), true, null),
    'Microphone: USB headset (restarting)');
eq('switch label: limit reached', micSwitchLabel(status({on: true, source_id: '202', label: 'USB headset', state: 'limit_reached'}), true, null),
    'Microphone: USB headset (limit reached)');
eq('switch label: failed', micSwitchLabel(status({on: true, source_id: '202', label: 'USB headset', state: 'failed'}), true, null),
    'Microphone: USB headset (failed)');
eq('switch label: pending has no suffix', micSwitchLabel(status({on: true, source_id: '202', label: 'USB headset', state: 'pending'}, 'paused'), true, null),
    'Microphone: USB headset');
eq('switch label: waiting, no label known', micSwitchLabel(status({on: true, source_id: null, state: 'waiting_for_device'}), true, [BUILTIN]),
    'Microphone (waiting for device)');
eq('switch label: old server uses the inventory', micSwitchLabel(status({on: true, source_id: 'm1'}), true, OLD_SERVER), 'Microphone: Built-in');
eq('switch label: off', micSwitchLabel(status({on: false, source_id: null, state: 'off'}), true, OLD_SERVER), 'Microphone');
eq('switch label: not running', micSwitchLabel(null, false, OLD_SERVER), 'Microphone');
eq('switch label: active differs from the preference (chosen on the page)',
    micSwitchLabel(status({on: true, source_id: '7', stable_id: 'pci-builtin', label: 'Built-in', state: 'capturing'}), true, [BUILTIN, USB_NEW]),
    'Microphone: Built-in');

// --- hint under the switch ----------------------------------------------------------
const OFF = status({on: false, source_id: null});
eq('hint: unset, not asked -> nothing', micHint(OFF, {running: true, mics: [BUILTIN], preferred: pref('', '', ''), prompt: false}), null);
eq('hint: unset, switch turned on -> choose', micHint(OFF, {running: true, mics: [BUILTIN], preferred: pref('', '', ''), prompt: true}), CHOOSE_TEXT);
eq('choose text', CHOOSE_TEXT, 'Choose a microphone');
eq('hint: missing -> not connected', micHint(OFF, {running: true, mics: [BUILTIN], preferred: pref('usb-x', '101')}), 'USB headset is not connected');
eq('missing text without a label', missingText(pref('usb-x', '101', '')), 'The chosen microphone is not connected');
eq('hint: available -> nothing', micHint(OFF, {running: true, mics: [BUILTIN, USB_NEW], preferred: pref('usb-x', '101')}), null);
eq('hint: inventory unknown -> nothing', micHint(OFF, {running: true, mics: null, preferred: pref('usb-x', '101')}), null);
eq('hint: inventory unknown, refused as missing -> not connected',
    micHint(OFF, {running: true, mics: null, preferred: pref('usb-x', '101'), missing: true}), 'USB headset is not connected');
eq('hint: mic on -> nothing', micHint(status({on: true, source_id: '7'}), {running: true, mics: [BUILTIN], preferred: pref('usb-x', '101')}), null);
eq('hint: not running -> nothing', micHint(null, {running: false, mics: [BUILTIN], preferred: pref('usb-x', '101')}), null);

// --- switching a live microphone when another source is chosen ----------------------
const item = (id, stableId) => ({id, stableId, label: 'x', checked: false});
eq('live: same stable id, new serial -> no switch', liveSwitchNeeded({on: true, source_id: '101', stable_id: 'usb-x'}, true, item('202', 'usb-x')), false);
eq('live: different device -> switch', liveSwitchNeeded({on: true, source_id: '202', stable_id: 'usb-x'}, true, item('7', 'pci-builtin')), true);
eq('live: old server, same id -> no switch', liveSwitchNeeded({on: true, source_id: 'm2'}, true, item('m2', '')), false);
eq('live: old server, other id -> switch', liveSwitchNeeded({on: true, source_id: 'm2'}, true, item('m1', '')), true);
eq('live: waiting for the chosen device -> no switch', liveSwitchNeeded({on: true, source_id: null, stable_id: 'usb-x'}, true, item('202', 'usb-x')), false);
eq('live: off -> no switch', liveSwitchNeeded({on: false, source_id: null}, true, item('7', 'pci-builtin')), false);
eq('live: not running -> no switch', liveSwitchNeeded({on: true, source_id: '7'}, false, item('202', 'usb-x')), false);

// --- MicController: the menu's decisions, with a spy instead of the client ---------
// h.server: what a fresh GET /control/v1/status returns (default: the last poll).
// hold: each setMicOn waits in h.pending until the test answers it.
function harness(saved = {}, {reject = null, hold = false} = {}) {
    const store = {'microphone-stable-id': '', 'microphone-id': '', 'microphone-label': '', ...saved};
    const h = {store, calls: [], opened: 0, changed: 0, writes: [], server: undefined, reads: 0, pending: []};
    h.ctl = new MicController({
        settings: {get: k => store[k], set: (k, v) => {
            store[k] = v;
            h.writes.push([k, v]);
        }},
        setMicOn: async (on, preferred) => {
            h.calls.push([on, preferred]);
            if (hold)
                await new Promise(resolve => h.pending.push(resolve));
            if (reject)
                throw reject;
            return {};
        },
        readStatus: async () => {
            h.reads++;
            return h.server === undefined ? h.ctl.status : h.server;
        },
        openSources: () => h.opened++,
        changed: () => h.changed++,
    });
    return h;
}

// Unset: no server call, prompt, source submenu opens; picking saves all three keys and turns on.
{
    const h = harness();
    h.ctl.updateStatus(OFF, true);
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    eq('unset toggle -> choose', await h.ctl.toggle(true, null), 'choose');
    eq('unset toggle: nothing sent', h.calls, []);
    eq('unset toggle: sources opened', h.opened, 1);
    eq('unset toggle: hint', h.ctl.view().hint, CHOOSE_TEXT);
    eq('unset pick -> on', await h.ctl.choose(micSourceItems(h.ctl.mics, h.ctl.preferred)[1], null), 'on');
    eq('unset pick saved stable id, label, legacy id', [h.store['microphone-stable-id'], h.store['microphone-label'], h.store['microphone-id']],
        ['usb-x', 'USB headset', '202']);
    eq('unset pick turned the mic on with that choice', h.calls, [[true, {stableId: 'usb-x', id: '202', label: 'USB headset'}]]);
    eq('unset pick: prompt gone', h.ctl.view().hint, null);
}
// Picking a source while off without having asked only saves it.
{
    const h = harness();
    h.ctl.updateStatus(OFF, true);
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    eq('pick while off -> saved only', await h.ctl.choose(micSourceItems(h.ctl.mics, h.ctl.preferred)[0], null), 'saved');
    eq('pick while off: nothing sent', h.calls, []);
    // Menu closed without picking: the next pick does not turn it on either.
    await h.ctl.toggle(true, null);
    eq('toggle with a choice is sent', h.calls.length, 1);
}
{
    const h = harness();
    h.ctl.updateStatus(OFF, true);
    await h.ctl.toggle(true, null);
    h.ctl.menuClosed();
    eq('prompt ends with the menu', h.ctl.view().hint, null);
    eq('pick after the prompt ended -> saved only', await h.ctl.choose(item('7', 'pci-builtin'), null), 'saved');
    eq('pick after the prompt ended: nothing sent', h.calls, []);
}
// Picking a microphone without a stable id clears a previously saved one.
{
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '101', 'microphone-label': 'USB headset'});
    await h.ctl.choose({id: '9', stableId: '', label: 'Line in', checked: false}, null);
    eq('pick without stable id clears the old one', [h.store['microphone-stable-id'], h.store['microphone-id'], h.store['microphone-label']], ['', '9', 'Line in']);
}
// Missing: the client refuses (microphone_missing); the switch stays off and the menu says why.
{
    const err = Object.assign(new Error('USB headset is not connected'), {code: 'microphone_missing', microphones: [BUILTIN]});
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '101', 'microphone-label': 'USB headset'}, {reject: err});
    h.ctl.updateStatus(OFF, true);
    eq('missing toggle -> missing', await h.ctl.toggle(true, null), 'missing');
    eq('missing toggle asked the client with the saved choice', h.calls, [[true, {stableId: 'usb-x', id: '101', label: 'USB headset'}]]);
    eq('missing: hint', h.ctl.view().hint, 'USB headset is not connected');
    eq('missing: nothing written to settings', h.writes, []);
    eq('missing: the fresh inventory is shown', h.ctl.mics, [BUILTIN]);
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    eq('missing: device back -> hint gone', h.ctl.view().hint, null);
}
{
    const h = harness({'microphone-stable-id': 'usb-x'}, {reject: Object.assign(new Error('HTTP 409'), {code: 'not_allowed'})});
    let thrown = null;
    try {
        await h.ctl.toggle(true, null);
    } catch (e) {
        thrown = e.code;
    }
    eq('other errors propagate (shown as the notice)', thrown, 'not_allowed');
}
// Migration on the first inventory read.
{
    const h = harness({'microphone-id': '101', 'microphone-label': 'USB headset'});
    h.ctl.setInventory([BUILTIN, USB_OLD]);
    eq('migration stores the stable id', h.writes, [['microphone-stable-id', 'usb-x']]);
    h.ctl.setInventory([BUILTIN, USB_OLD]);
    eq('migration only once', h.writes.length, 1);
}
{
    const h = harness({'microphone-id': '101', 'microphone-label': 'USB headset'});
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    eq('migration: legacy id absent -> nothing written', h.writes, []);
    h.ctl.updateStatus(OFF, true);
    eq('migration: legacy id absent -> not connected, no fallback', h.ctl.view().sources.map(i => i.checked), [false, false]);
}
// Status polling never turns the mic on or off and never changes the preference.
{
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '101', 'microphone-label': 'USB headset'});
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    for (const mic of [
        {on: false, source_id: null},
        {on: true, source_id: '7', stable_id: 'pci-builtin', label: 'Built-in', state: 'capturing'},
        {on: true, source_id: null, stable_id: 'usb-x', label: 'USB headset', state: 'waiting_for_device'},
        {on: true, source_id: '202', stable_id: 'usb-x', label: 'USB headset', state: 'retrying'},
        {on: false, source_id: null, state: 'off'},
    ]) {
        h.ctl.updateStatus(status(mic), true);
        h.ctl.view();
    }
    h.ctl.updateStatus(null, false);
    eq('polling never posts', h.calls, []);
    eq('polling never writes settings', h.writes, []);
    eq('page-chosen mic shown as active, preference kept', (() => {
        h.ctl.updateStatus(status({on: true, source_id: '7', stable_id: 'pci-builtin', label: 'Built-in', state: 'capturing'}), true);
        const v = h.ctl.view();
        return [v.switchLabel, v.sources.filter(i => i.checked).map(i => i.label)];
    })(), ['Microphone: Built-in', ['USB headset']]);
}
// Choosing another source while on switches the live microphone; the same device does not.
{
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '101', 'microphone-label': 'USB headset'});
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    h.ctl.updateStatus(status({on: true, source_id: '202', stable_id: 'usb-x', label: 'USB headset', state: 'capturing'}), true);
    eq('pick the same device while on -> saved only', await h.ctl.choose(micSourceItems(h.ctl.mics, h.ctl.preferred)[1], null), 'saved');
    eq('pick another device while on -> on', await h.ctl.choose(micSourceItems(h.ctl.mics, h.ctl.preferred)[0], null), 'on');
    eq('switching sent the new choice', h.calls, [[true, {stableId: 'pci-builtin', id: '7', label: 'Built-in'}]]);
}
// Turning off always goes to the server.
{
    const h = harness();
    eq('off without a choice -> off', await h.ctl.toggle(false, null), 'off');
    eq('off sent', h.calls.map(c => c[0]), [false]);
}

// Mic requests run one after another; the last user intent wins.
{
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'});
    const [on, off] = [h.ctl.toggle(true, null), h.ctl.toggle(false, null)];
    await Promise.all([on, off]);
    eq('on then off at once: the on is not sent', h.calls.map(c => c[0]), [false]);
    const results = await Promise.all([h.ctl.toggle(true, null), h.ctl.toggle(false, null), h.ctl.toggle(true, null)]);
    eq('on, off, on: ends on', h.calls.slice(1).map(c => c[0]), [false, true]);
    eq('on, off, on: results', results, ['superseded', 'off', 'on']);
}
{
    const flush = async () => {
        for (let i = 0; i < 10; i++)
            await null;
    };
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'}, {hold: true});
    const on = h.ctl.toggle(true, null);
    await flush();
    const off = h.ctl.toggle(false, null);
    await flush();
    eq('on in flight: the off waits for it', h.calls.map(c => c[0]), [true]);
    h.pending.shift()();
    await on;
    await flush();
    eq('on in flight: the off follows it', h.calls.map(c => c[0]), [true, false]);
    h.pending.shift()();
    eq('on in flight: results', [await on, await off], ['on', 'off']);
}
{
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'});
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    const results = await Promise.all([h.ctl.choose(item('7', 'pci-builtin'), null), h.ctl.toggle(false, null)]);
    eq('pick then off at once: only off is sent', [results, h.calls.map(c => c[0])], [['saved', 'off'], [false]]);
    eq('pick then off at once: the pick is still saved', h.store['microphone-stable-id'], 'pci-builtin');
}
// A pick decides from a fresh status, not the last poll.
{
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'});
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    h.ctl.updateStatus(status({on: true, source_id: '202', stable_id: 'usb-x', label: 'USB headset', state: 'capturing'}), true);
    h.server = status({on: false, source_id: null, state: 'off'});  // turned off on the session page since the poll
    eq('stale poll says on, server says off: pick only saves', await h.ctl.choose(item('7', 'pci-builtin'), null), 'saved');
    eq('stale poll: status read once, nothing sent', [h.reads, h.calls], [1, []]);
    eq('stale poll: choice saved', h.store['microphone-stable-id'], 'pci-builtin');
    h.ctl.updateStatus(OFF, true);
    h.server = status({on: true, source_id: '202', stable_id: 'usb-x', label: 'USB headset', state: 'capturing'});
    eq('stale poll says off, server says on with another device: pick switches', await h.ctl.choose(item('7', 'pci-builtin'), null), 'on');
}
// Starting / stopping: a pick only saves, even right after "Choose a microphone".
for (const state of ['starting', 'stopping']) {
    const h = harness({'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'});
    h.ctl.setInventory([BUILTIN, USB_NEW]);
    h.ctl.updateStatus(status({on: true, source_id: '202', stable_id: 'usb-x', label: 'USB headset', state: 'capturing'}, state), true);
    eq(`${state}: pick another device while on -> saved only`, await h.ctl.choose(item('7', 'pci-builtin'), null), 'saved');
    const u = harness();
    u.ctl.updateStatus(OFF, true);
    await u.ctl.toggle(true, null);
    u.server = status({on: false, source_id: null}, state);
    eq(`${state}: pick after "Choose a microphone" -> saved only`, await u.ctl.choose(item('7', 'pci-builtin'), null), 'saved');
    eq(`${state}: nothing sent`, [h.calls, u.calls], [[], []]);
}

if (failed) {
    print(`${failed} failed`);
    (await import('system')).default.exit(1);
}
print('all passed');
