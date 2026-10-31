// Output monitor (CONTROL_API.md Amendment 5): saved choice by stable id,
// which user actions need the consent dialog, the popover's tile, picker and
// notices, the top-bar icon, and feature detection.
// Run: gjs -m tests/output_model_test.js
import System from 'system';

import {buildView, outputSwitch} from '../whatdidido@wporter.org/lib/model.js';
import {
    CONSENT_BODY, CONSENT_CANCEL, CONSENT_CONFIRM, CONSENT_TITLE, OUTPUT_CHOOSE_TEXT, OUTPUT_KEYS, OutputController,
    activeOutputLabel, chooseAction, chooseOutput, outputErrorText, outputHint, outputMissingText, outputOffered,
    outputRequest, outputSourceItems,
} from '../whatdidido@wporter.org/lib/output_model.js';
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

const SPEAKERS = {id: '61', label: 'Built-in Speakers', stable_id: 'alsa_output.pci.analog-stereo'};
const DOCK_OLD = {id: '70', label: 'Dock Headphones', stable_id: 'alsa_output.usb-dock'};
const DOCK_NEW = {id: '88', label: 'Dock Headphones', stable_id: 'alsa_output.usb-dock'};
const pref = (stableId, id, label = 'Dock Headphones') => ({stableId, id, label});
const idOf = o => o?.id ?? null;
const OFF_OBJ = {available: true, on: false, source_id: null, stable_id: null, label: null, state: 'off', remembered: false};
const ON_OBJ = {available: true, on: true, source_id: '88', stable_id: 'alsa_output.usb-dock', label: 'Dock Headphones', state: 'capturing', remembered: true};
const MIC = {available: true, on: true, source_id: '52', stable_id: 'usb-mic', label: 'USB Desk Microphone', state: 'capturing', remembered: false};
const status = (output, state = 'recording') => ({
    state, monitors: 2, samples: 10, interval_seconds: 5, last_error: null, reason: null, mic: MIC,
    ...(output === undefined ? {} : {output}),
});

// --- constants ----------------------------------------------------------------------
eq('setting keys', OUTPUT_KEYS, {stableId: 'output-stable-id', id: 'output-id', label: 'output-label'});
eq('choose text', OUTPUT_CHOOSE_TEXT, 'Choose an output');
eq('dialog title', CONSENT_TITLE, 'Record the output?');
eq('dialog body is the session page warning', CONSENT_BODY,
    'Output capture records everything this computer plays through the selected output, including other ' +
    "people's voices in calls and meetings. Enable it only when everyone being recorded has agreed.");
eq('dialog buttons', [CONSENT_CANCEL, CONSENT_CONFIRM], ['Cancel', 'Everyone has agreed — record']);

// --- feature detection ----------------------------------------------------------------
eq('offered: output.available true', outputOffered(status(OFF_OBJ), true), true);
eq('old server (no output key): not offered', outputOffered(status(undefined), true), false);
eq('available false: not offered', outputOffered(status({...OFF_OBJ, available: false}), true), false);
eq('available truthy but not true: not offered', outputOffered(status({...OFF_OBJ, available: 1}), true), false);
eq('not running: not offered', outputOffered(status(OFF_OBJ), false), false);
eq('null status: not offered', outputOffered(null, true), false);

// --- saved choice by stable id ----------------------------------------------------------
eq('unset -> null (never a first-output fallback)', chooseOutput([SPEAKERS, DOCK_NEW], pref('', '', '')), null);
eq('reconnected: stable id re-resolves to the new serial', idOf(chooseOutput([SPEAKERS, DOCK_NEW], pref('alsa_output.usb-dock', '70'))), '88');
eq('missing: stable id gone -> null, never the speakers', chooseOutput([SPEAKERS], pref('alsa_output.usb-dock', '70')), null);
eq('stale legacy id not used when a stable id is known',
    chooseOutput([{id: '70', label: 'Dock Headphones', stable_id: 'other'}], pref('alsa_output.usb-dock', '70')), null);
eq('ambiguous stable id -> null', chooseOutput([DOCK_OLD, DOCK_NEW], pref('alsa_output.usb-dock', '')), null);
eq('legacy id only when no stable id is known', idOf(chooseOutput([{id: '9', label: 'HDMI', stable_id: null}], pref('', '9', 'HDMI'))), '9');
eq('legacy id reused by another device (label differs) -> null', chooseOutput([{id: '9', label: 'Speakers', stable_id: null}], pref('', '9', 'HDMI')), null);
eq('unknown inventory -> null', chooseOutput(null, pref('alsa_output.usb-dock', '70')), null);

// --- request body: consent only when on -------------------------------------------------
eq('on: consent true, resolved serial', outputRequest(true, [SPEAKERS, DOCK_NEW], pref('alsa_output.usb-dock', '70'), 'inv7'),
    {on: true, source_id: '88', inventory: 'inv7', consent: true});
eq('off: exactly {on:false}, no consent', outputRequest(false, [SPEAKERS], pref('alsa_output.usb-dock', '70'), 'inv7'), {on: false});
eq('on, choice missing -> null (nothing sent)', outputRequest(true, [SPEAKERS], pref('alsa_output.usb-dock', '70'), 'inv7'), null);
eq('on, no choice -> null', outputRequest(true, [SPEAKERS], pref('', '', ''), 'inv7'), null);
eq('missing text', outputMissingText(pref('x', '', 'Dock Headphones')), 'Dock Headphones is not connected');
eq('missing text without a label', outputMissingText(pref('x', '', '')), 'The chosen output is not connected');

// --- source items and labels --------------------------------------------------------------
eq('items: saved choice checked', outputSourceItems([SPEAKERS, DOCK_NEW], pref('alsa_output.usb-dock', '70')), [
    {id: '61', stableId: 'alsa_output.pci.analog-stereo', label: 'Built-in Speakers', checked: false},
    {id: '88', stableId: 'alsa_output.usb-dock', label: 'Dock Headphones', checked: true}]);
eq('items: nothing saved -> nothing checked', outputSourceItems([SPEAKERS], pref('', '', '')).map(i => i.checked), [false]);
eq('active label from output.label', activeOutputLabel(ON_OBJ, [SPEAKERS]), 'Dock Headphones');
eq('active label from the inventory', activeOutputLabel({on: true, source_id: '61'}, [SPEAKERS]), 'Built-in Speakers');

// --- hint ------------------------------------------------------------------------------------
const hint = (s, o) => outputHint(s, {running: true, outputs: [SPEAKERS], preferred: pref('', '', ''), ...o});
eq('hint: unset, not asked -> nothing', hint(status(OFF_OBJ), {}), null);
eq('hint: unset, tile turned on -> choose', hint(status(OFF_OBJ), {prompt: true}), 'Choose an output');
eq('hint: missing -> not connected', hint(status(OFF_OBJ), {preferred: pref('alsa_output.usb-dock', '70')}), 'Dock Headphones is not connected');
eq('hint: available -> nothing', hint(status(OFF_OBJ), {outputs: [DOCK_NEW], preferred: pref('alsa_output.usb-dock', '70')}), null);
eq('hint: refused as missing, inventory unknown', hint(status(OFF_OBJ), {outputs: null, preferred: pref('alsa_output.usb-dock', '70'), missing: true}),
    'Dock Headphones is not connected');
eq('hint: on -> nothing', hint(status(ON_OBJ), {preferred: pref('alsa_output.pci', '61')}), null);
eq('hint: old server -> nothing even when asked', hint(status(undefined), {prompt: true}), null);

// --- which user actions need consent (chooseAction) --------------------------------------------
const item = (id, stableId) => ({id, stableId, label: 'x', checked: false});
const DOCK_ITEM = item('88', 'alsa_output.usb-dock');
const SPK_ITEM = item('61', 'alsa_output.pci.analog-stereo');
eq('choose while off after the tile asked -> ask', chooseAction(status(OFF_OBJ), true, DOCK_ITEM), 'ask');
eq('choose while off, not asked -> save only', chooseAction(status(OFF_OBJ), false, DOCK_ITEM), 'save');
eq('choose another output while on -> switch, no dialog', chooseAction(status(ON_OBJ), false, SPK_ITEM), 'switch');
eq('choose another output while on, even after a prompt -> switch', chooseAction(status(ON_OBJ), true, SPK_ITEM), 'switch');
eq('choose the live output again -> save only', chooseAction(status(ON_OBJ), false, DOCK_ITEM), 'save');
eq('choose while starting -> save only', chooseAction(status(OFF_OBJ, 'starting'), true, DOCK_ITEM), 'save');
eq('choose while stopping -> save only', chooseAction(status(ON_OBJ, 'stopping'), false, SPK_ITEM), 'save');
eq('choose while stopped with prompt -> ask (selects for the next Start)', chooseAction(status(OFF_OBJ, 'stopped'), true, DOCK_ITEM), 'ask');
eq('choose on an old server -> save only', chooseAction(status(undefined), true, DOCK_ITEM), 'save');

// --- error texts ------------------------------------------------------------------------------
eq('error: unavailable names the output', outputErrorText({status: 409, code: 'unavailable'}), 'Output capture is not enabled on the server');
eq('error: inventory changed names outputs', outputErrorText({status: 409, code: 'inventory_changed'}), 'Outputs changed; try again');
eq('error: missing -> its message', outputErrorText({code: 'output_missing', message: 'Dock Headphones is not connected'}), 'Dock Headphones is not connected');
eq('error: unset', outputErrorText({code: 'output_unset', message: 'Choose an output'}), 'Choose an output');
eq('error: others as errorText', outputErrorText({status: 409, code: 'not_allowed'}), 'Not allowed in the current state');

// --- switch sensitivity and top-bar indicator (model.js) -----------------------------------------
eq('switch: old server -> insensitive, off', outputSwitch(status(undefined), true), {sensitive: false, on: false});
eq('switch: recording, off', outputSwitch(status(OFF_OBJ), true), {sensitive: true, on: false});
eq('switch: on', outputSwitch(status(ON_OBJ), true), {sensitive: true, on: true});
eq('switch: starting -> insensitive', outputSwitch(status(OFF_OBJ, 'starting'), true).sensitive, false);
eq('switch: unavailable -> insensitive', outputSwitch(status({...OFF_OBJ, available: false}), true).sensitive, false);
eq('switch: not running', outputSwitch(null, false), {sensitive: false, on: false});
for (const st of ['capturing', 'pending', 'waiting_for_device', 'retrying', undefined])
    eq(`indicator: ${st ?? 'no state'} -> shown`, buildView(status({...ON_OBJ, state: st})).outputIndicator, true);
for (const st of ['limit_reached', 'failed'])
    eq(`indicator: ${st} -> hidden (stopped for good)`, buildView(status({...ON_OBJ, state: st})).outputIndicator, false);
eq('indicator: off -> hidden', buildView(status(OFF_OBJ)).outputIndicator, false);
eq('indicator: old server -> hidden', buildView(status(undefined)).outputIndicator, false);
eq('indicator: on but available false -> hidden', buildView(status({...ON_OBJ, available: false})).outputIndicator, false);
eq('indicator: not running -> hidden', buildView(status(ON_OBJ), {running: false}).outputIndicator, false);
eq('indicator: setting off -> hidden', buildView(status(ON_OBJ), {showOutput: false}).outputIndicator, false);
eq('indicator: mic setting does not hide it', buildView(status(ON_OBJ), {showMic: false}).outputIndicator, true);
eq('accessible name says output on', buildView(status(ON_OBJ)).accessibleName, 'whatdidido: Recording, microphone on, output on');
eq('accessible name with the icon hidden still says output on', buildView(status(ON_OBJ), {showOutput: false}).accessibleName,
    'whatdidido: Recording, microphone on, output on');
eq('accessible name: old server unchanged', buildView(status(undefined)).accessibleName, 'whatdidido: Recording, microphone on');

// --- popover: tile, picker, notices --------------------------------------------------------------
const view = (s, o = {}) => popoverView(s, {
    output: {hint: null, sources: outputSourceItems(o.outputs ?? [SPEAKERS, DOCK_NEW], o.preferred ?? pref('', '', ''))},
    outputs: [SPEAKERS, DOCK_NEW], ...o,
});
const old = view(status(undefined));
eq('old server: no output tile', old.tiles.output.visible, false);
eq('old server: no output picker', old.outputSource.visible, false);
eq('old server: status subtitle unchanged', old.status.subtitle, '2 monitors · every 5 s · mic on');
const on = view(status(ON_OBJ), {outputChoiceLabel: 'Dock Headphones', preferred: pref('alsa_output.usb-dock', '70')});
eq('on: tile', [on.tiles.output.name, on.tiles.output.visible, on.tiles.output.title, on.tiles.output.icon, on.tiles.output.on,
    on.tiles.output.accent, on.tiles.output.sensitive, on.tiles.output.action],
['wdi-pop-output', true, 'Output', 'audio-speakers-symbolic', true, true, true, {action: 'output', on: false}]);
eq('on: tile subtitle names the output', on.tiles.output.subtitle, 'On · Dock Headphones');
// The status card stays as it is: the tile and the top-bar icon show the output.
eq('on: status subtitle unchanged', on.status.subtitle, '2 monitors · every 5 s · mic on');
eq('waiting: trouble in the subtitle', view(status({...ON_OBJ, source_id: null, state: 'waiting_for_device'})).tiles.output.subtitle,
    'On · Dock Headphones (waiting for device)');
const offSaved = view(status(OFF_OBJ), {outputChoiceLabel: 'Dock Headphones', preferred: pref('alsa_output.usb-dock', '70')});
eq('off with a saved choice: its label', [offSaved.tiles.output.subtitle, offSaved.tiles.output.on, offSaved.tiles.output.action],
    ['Off · Dock Headphones', false, {action: 'output', on: true}]);
eq('off with no choice: Choose an output', view(status(OFF_OBJ)).tiles.output.subtitle, 'Choose an output');
eq('off: status subtitle without output', view(status(OFF_OBJ)).status.subtitle, '2 monitors · every 5 s · mic on');
eq('starting: tile insensitive', view(status(OFF_OBJ, 'starting')).tiles.output.sensitive, false);
const picker = on.outputSource;
eq('picker', [picker.name, picker.visible, picker.title, picker.value, picker.expanded, picker.accessibleName, picker.action],
    ['wdi-pop-output-source', true, 'Output source', 'Dock Headphones', false, 'Output source: Dock Headphones', {action: 'expand', list: 'output'}]);
eq('picker items', picker.items.map(i => [i.name, i.label, i.checked, i.action.action, i.action.item.id]),
    [['wdi-pop-output-item-0', 'Built-in Speakers', false, 'choose-output', '61'], ['wdi-pop-output-item-1', 'Dock Headphones', true, 'choose-output', '88']]);
eq('picker: no choice -> Choose…', view(status(OFF_OBJ)).outputSource.value, 'Choose…');
eq('picker expanded only for the output list', [
    view(status(OFF_OBJ), {ui: {expanded: 'output'}}).outputSource.expanded,
    view(status(OFF_OBJ), {ui: {expanded: 'output'}}).input.expanded,
    view(status(OFF_OBJ), {ui: {expanded: 'input'}}).outputSource.expanded,
], [true, false, false]);
eq('picker: empty list', view(status(OFF_OBJ), {outputs: [], output: {hint: null, sources: []}}).outputSource.emptyText, 'No outputs found');
eq('picker: unknown list', view(status(OFF_OBJ), {outputs: null, output: {hint: null, sources: []}}).outputSource.emptyText, 'Outputs unavailable');
eq('output hint is a notice after the mic hint',
    view(status(OFF_OBJ), {mic: {hint: 'Choose a microphone', sources: []}, output: {hint: 'Choose an output', sources: []}}).notices.map(n => n.text),
    ['Choose a microphone', 'Choose an output']);
eq('not running: tile hidden', view(null, {running: false}).tiles.output.visible, false);

// --- OutputController ------------------------------------------------------------------------------
// h.answers: what each confirm() resolves to, in order (default: agree).
function harness(saved = {}, {reject = null, hold = false, answers = []} = {}) {
    const store = {'output-stable-id': '', 'output-id': '', 'output-label': '', ...saved};
    const h = {store, calls: [], asked: 0, opened: 0, writes: [], server: undefined, reads: 0, pending: [], confirms: []};
    h.ctl = new OutputController({
        settings: {get: k => store[k], set: (k, v) => {
            store[k] = v;
            h.writes.push([k, v]);
        }},
        setOutputOn: async (on, preferred) => {
            h.calls.push([on, preferred]);
            if (hold)
                await new Promise(resolve => h.pending.push(resolve));
            if (reject)
                throw reject;
            return {};
        },
        readStatus: async () => {
            h.reads++;
            return h.server ?? h.ctl.status;
        },
        confirm: () => {
            h.asked++;
            if (answers === 'hold')
                return new Promise(resolve => h.confirms.push(resolve));
            const a = answers.length ? answers.shift() : true;
            return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
        },
        openSources: () => h.opened++,
    });
    return h;
}
const SAVED = {'output-stable-id': 'alsa_output.usb-dock', 'output-id': '70', 'output-label': 'Dock Headphones'};
const flush = async () => {
    for (let i = 0; i < 50; i++)
        await null;
};

async function controllerTests() {
    {
        const h = harness();
        h.ctl.updateStatus(status(OFF_OBJ), true);
        eq('tile on, no choice -> choose', await h.ctl.toggle(true, null), 'choose');
        eq('tile on, no choice: list opened, nothing asked or sent', [h.opened, h.asked, h.calls.length], [1, 0, 0]);
        eq('tile on, no choice: hint', h.ctl.view().hint, 'Choose an output');
        h.ctl.menuClosed();
        eq('menu closed clears the prompt', h.ctl.view().hint, null);
    }
    {
        const h = harness(SAVED);
        h.ctl.updateStatus(status(OFF_OBJ), true);
        eq('tile on with a choice -> asks, then on', await h.ctl.toggle(true, null), 'on');
        eq('tile on: asked once, sent on with the saved choice', [h.asked, h.calls],
            [1, [[true, {stableId: 'alsa_output.usb-dock', id: '70', label: 'Dock Headphones'}]]]);
    }
    {
        const h = harness(SAVED, {answers: [false]});
        h.ctl.updateStatus(status(OFF_OBJ), true);
        eq('tile on, dialog cancelled -> cancelled', await h.ctl.toggle(true, null), 'cancelled');
        eq('cancelled: nothing sent', h.calls.length, 0);
    }
    {
        const h = harness(SAVED, {answers: [new Error('dialog destroyed')]});
        h.ctl.updateStatus(status(OFF_OBJ), true);
        eq('dialog gone without an answer -> cancelled', await h.ctl.toggle(true, null), 'cancelled');
        eq('dialog gone: nothing sent', h.calls.length, 0);
    }
    {
        const h = harness(SAVED);
        h.ctl.updateStatus(status(ON_OBJ), true);
        eq('tile off -> off, no dialog', [await h.ctl.toggle(false, null), h.asked, h.calls], ['off', 0, [[false, {stableId: 'alsa_output.usb-dock', id: '70', label: 'Dock Headphones'}]]]);
    }
    {
        const h = harness();
        h.ctl.updateStatus(status(ON_OBJ), true);
        eq('tile off without a saved choice is still sent', [await h.ctl.toggle(false, null), h.calls.length], ['off', 1]);
    }
    {
        // Choosing after the tile asked: saved, then asked, then on.
        const h = harness();
        h.ctl.updateStatus(status(OFF_OBJ), true);
        await h.ctl.toggle(true, null);
        eq('choose after prompt -> on', await h.ctl.choose(DOCK_ITEM, null), 'on');
        eq('choose after prompt: asked once, fresh status read', [h.asked, h.reads], [1, 1]);
        eq('choose: writes stable id, label, then id', h.writes,
            [['output-stable-id', 'alsa_output.usb-dock'], ['output-label', 'x'], ['output-id', '88']]);
    }
    {
        const h = harness({}, {answers: [false]});
        h.ctl.updateStatus(status(OFF_OBJ), true);
        await h.ctl.toggle(true, null);
        eq('choose after prompt, cancelled -> cancelled, choice kept', [await h.ctl.choose(DOCK_ITEM, null), h.calls.length, h.store['output-stable-id']],
            ['cancelled', 0, 'alsa_output.usb-dock']);
    }
    {
        const h = harness();
        h.ctl.updateStatus(status(OFF_OBJ), true);
        eq('choose while off, not asked -> saved, no dialog, nothing sent', [await h.ctl.choose(DOCK_ITEM, null), h.asked, h.calls.length], ['saved', 0, 0]);
    }
    {
        const h = harness(SAVED);
        h.ctl.updateStatus(status(ON_OBJ), true);
        eq('switch while on -> on without a dialog', [await h.ctl.choose(SPK_ITEM, null), h.asked], ['on', 0]);
        eq('switch sent the new choice', h.calls, [[true, {stableId: 'alsa_output.pci.analog-stereo', id: '61', label: 'x'}]]);
    }
    {
        // The poll said off, but the session page turned it on meanwhile: a
        // fresh status decides, so it is a switch, not a turn-on.
        const h = harness(SAVED);
        h.ctl.updateStatus(status(OFF_OBJ), true);
        h.server = status(ON_OBJ);
        eq('fresh status on -> switch without a dialog', [await h.ctl.choose(SPK_ITEM, null), h.asked], ['on', 0]);
    }
    {
        // ...and the other way round: polled on, but it is off now.
        const h = harness(SAVED);
        h.ctl.updateStatus(status(ON_OBJ), true);
        h.server = status(OFF_OBJ);
        eq('fresh status off, not asked -> saved, nothing sent', [await h.ctl.choose(SPK_ITEM, null), h.asked, h.calls.length], ['saved', 0, 0]);
    }
    {
        const h = harness(SAVED);
        h.ctl.updateStatus(status(OFF_OBJ, 'starting'), true);
        await h.ctl.toggle(true, null);
        h.calls = [];
        h.asked = 0;
        eq('choose while starting -> saved', [await h.ctl.choose(SPK_ITEM, null), h.asked, h.calls.length], ['saved', 0, 0]);
    }
    {
        // Polls and inventory reads, including a remembered output that is
        // on, never ask and never send.
        const h = harness(SAVED);
        h.ctl.updateStatus(status(ON_OBJ), true);
        h.ctl.setInventory([SPEAKERS, DOCK_NEW]);
        h.ctl.updateStatus(status({...ON_OBJ, state: 'waiting_for_device'}), true);
        h.ctl.setInventory([SPEAKERS]);
        h.ctl.updateStatus(status(OFF_OBJ, 'stopped'), true);
        h.ctl.setInventory(null);
        h.ctl.view();
        eq('polling and remembered state: no dialog, no request', [h.asked, h.calls.length, h.reads], [0, 0, 0]);
    }
    {
        const err = Object.assign(new Error('Dock Headphones is not connected'), {code: 'output_missing', outputs: [SPEAKERS]});
        const h = harness(SAVED, {reject: err});
        h.ctl.updateStatus(status(OFF_OBJ), true);
        eq('missing after the dialog -> missing', await h.ctl.toggle(true, null), 'missing');
        eq('missing: hint and fresh inventory', [h.ctl.view().hint, h.ctl.outputs.map(o => o.id)], ['Dock Headphones is not connected', ['61']]);
        h.ctl.setInventory([DOCK_NEW]);
        eq('back in the inventory clears missing', h.ctl.view().hint, null);
    }
    {
        const h = harness(SAVED, {reject: Object.assign(new Error('HTTP 409'), {code: 'not_allowed'})});
        h.ctl.updateStatus(status(OFF_OBJ), true);
        let e = null;
        try {
            await h.ctl.toggle(true, null);
        } catch (x) {
            e = x;
        }
        eq('other failures reject', e?.code, 'not_allowed');
    }
    {
        // On, then off while the dialog is still open: the agreed on is
        // superseded and never sent; the off is.
        const h = harness(SAVED, {answers: 'hold'});
        h.ctl.updateStatus(status(OFF_OBJ), true);
        const on = h.ctl.toggle(true, null);
        await flush();
        const off = h.ctl.toggle(false, null);
        h.confirms.shift()(true);
        eq('on then off during the dialog', [await on, await off], ['superseded', 'off']);
        eq('only the off was sent', h.calls.map(c => c[0]), [false]);
    }
    {
        // Two turn-ons: each asks; a turn-on never rides on an earlier answer.
        const h = harness(SAVED);
        h.ctl.updateStatus(status(OFF_OBJ), true);
        await h.ctl.toggle(true, null);
        h.ctl.updateStatus(status(OFF_OBJ), true);
        await h.ctl.toggle(true, null);
        eq('every turn-on asks again', h.asked, 2);
    }
    {
        // Old server: the controller still works by itself, but the tile is
        // hidden; choose decides "save" so nothing is ever sent.
        const h = harness(SAVED);
        h.ctl.updateStatus(status(undefined), true);
        eq('old server: choose only saves', [await h.ctl.choose(SPK_ITEM, null), h.asked, h.calls.length], ['saved', 0, 0]);
    }
    {
        const h = harness(SAVED);
        h.ctl.updateStatus(status(OFF_OBJ), true);
        h.ctl.setInventory([SPEAKERS, DOCK_NEW]);
        const v = h.ctl.view();
        eq('view sources', v.sources.map(s => [s.id, s.checked]), [['61', false], ['88', true]]);
        eq('preferred from settings', h.ctl.preferred, {stableId: 'alsa_output.usb-dock', id: '70', label: 'Dock Headphones'});
    }
    {
        // A choice saved without a stable id by an older server adopts it
        // once the output reports one (the microphone's migration).
        const h = harness({'output-id': '70', 'output-label': 'Dock Headphones'});
        h.ctl.setInventory([SPEAKERS, DOCK_OLD]);
        eq('migration adopts the stable id', h.store['output-stable-id'], 'alsa_output.usb-dock');
    }
}

await controllerTests();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
