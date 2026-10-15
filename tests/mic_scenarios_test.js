// Issue #1 scenarios end to end: the menu's MicController + ControlClient +
// the loopback fake (unset, available, missing, reconnected, migration).
// Run: gjs -m tests/mic_scenarios_test.js [runtime-dir]
import GLib from 'gi://GLib';
import System from 'system';

import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {CHOOSE_TEXT, MicController} from '../whatdidido@wporter.org/lib/mic_model.js';
import {FakeControl, writeControlFile, removeControlFile} from './fake_control.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const runtimeDir = ARGV[0] ?? GLib.build_filenamev([here, '..', 'build', 'test-runtime', 'mic-scenarios']);
GLib.mkdir_with_parents(runtimeDir, 0o700);
const TOKEN = 'tokenMIC_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

const BUILTIN = {id: '7', label: 'Built-in', stable_id: 'pci-builtin'};
const USB = id => ({id, label: 'USB headset', stable_id: 'usb-x'});

async function main() {
    const fake = new FakeControl({token: TOKEN});
    writeControlFile(runtimeDir, fake.listen(), TOKEN);
    const client = new ControlClient({runtimeDir});
    const posts = () => fake.requests.filter(r => r.method === 'POST' && r.path === '/control/v1/mic').map(r => JSON.parse(r.body));

    // One "extension": settings store, controller wired to the real client, and
    // the poll/menu-open steps the indicator performs.
    function extension(saved = {}) {
        const store = {'microphone-stable-id': '', 'microphone-id': '', 'microphone-label': '', ...saved};
        const ext = {store, opened: 0};
        ext.ctl = new MicController({
            settings: {get: k => store[k], set: (k, v) => {
                store[k] = v;
            }},
            setMicOn: (on, preferred, c) => client.setMicOn(on, preferred, c),
            readStatus: c => client.status(c),
            openSources: () => ext.opened++,
        });
        ext.poll = async () => ext.ctl.updateStatus(await client.status(null), true);
        ext.openMenu = async () => {
            await ext.poll();
            ext.ctl.setInventory((await client.microphones(null)).microphones);
        };
        return ext;
    }
    const reset = (mics, micDetails = true) => {
        fake.micDetails = micDetails;
        fake.mics = mics;
        fake.inventory = `inv${Math.floor(Math.random() * 1e6)}`;
        fake.status.mic = {available: true, on: false, source_id: null};
        fake.requests = [];
    };

    // --- reconnect: saved stable id survives a new serial; never the built-in --------
    {
        reset([USB('101')]);
        const ext = extension({'microphone-stable-id': 'usb-x', 'microphone-id': '101', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        eq('reconnect: first on', await ext.ctl.toggle(true, null), 'on');
        await ext.ctl.toggle(false, null);
        // Dock reconnect: new serial, built-in listed first. The menu still holds the old inventory.
        fake.mics = [BUILTIN, USB('202')];
        fake.inventory = 'inv-reconnected';
        eq('reconnect: on again', await ext.ctl.toggle(true, null), 'on');
        eq('reconnect: posted 101 then 202, never 7', posts().filter(p => p.on).map(p => p.source_id), ['101', '202']);
        await ext.poll();
        eq('reconnect: the menu shows the active microphone', ext.ctl.view().switchLabel, 'Microphone: USB headset');
        eq('reconnect: preference unchanged (stable id)', ext.store['microphone-stable-id'], 'usb-x');
        // Restart of the extension (new controller, same settings) after another re-enumeration.
        await ext.ctl.toggle(false, null);
        fake.mics = [BUILTIN, USB('303')];
        fake.inventory = 'inv-restarted';
        const restarted = extension(ext.store);
        await restarted.openMenu();
        eq('restart: preference checked', restarted.ctl.view().sources.map(i => [i.id, i.checked]), [['7', false], ['303', true]]);
        fake.requests = [];
        await restarted.ctl.toggle(true, null);
        eq('restart: posted 303', posts().map(p => p.source_id), ['303']);
    }

    // --- missing: nothing posted, switch stays off, "<label> is not connected" ------------
    {
        reset([BUILTIN]);
        const ext = extension({'microphone-stable-id': 'usb-x', 'microphone-id': '101', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        eq('missing: hint before trying', ext.ctl.view().hint, 'USB headset is not connected');
        eq('missing: toggle', await ext.ctl.toggle(true, null), 'missing');
        await ext.poll();
        eq('missing: nothing posted', posts(), []);
        eq('missing: switch stays off', ext.ctl.status.mic.on, false);
        eq('missing: menu text', ext.ctl.view().hint, 'USB headset is not connected');
        eq('missing: nothing checked', ext.ctl.view().sources.map(i => i.checked), [false]);
        eq('missing: preference kept', [ext.store['microphone-stable-id'], ext.store['microphone-label']], ['usb-x', 'USB headset']);
    }

    // --- unset: choose first; picking saves and turns on --------------------------------
    {
        reset([BUILTIN, USB('202')]);
        const ext = extension();
        await ext.openMenu();
        eq('unset: toggle', await ext.ctl.toggle(true, null), 'choose');
        eq('unset: nothing sent', fake.requests.filter(r => r.method === 'POST'), []);
        eq('unset: menu text', ext.ctl.view().hint, CHOOSE_TEXT);
        eq('unset: source submenu opened', ext.opened, 1);
        eq('unset: pick USB', await ext.ctl.choose(ext.ctl.view().sources[1], null), 'on');
        eq('unset: saved stable id, label, legacy id',
            [ext.store['microphone-stable-id'], ext.store['microphone-label'], ext.store['microphone-id']], ['usb-x', 'USB headset', '202']);
        eq('unset: posted the pick', posts().map(p => p.source_id), ['202']);
        await ext.poll();
        eq('unset: mic on', [ext.ctl.status.mic.on, ext.ctl.view().switchLabel, ext.ctl.view().hint], [true, 'Microphone: USB headset', null]);
    }

    // --- migration: legacy id present with a stable id ----------------------------------
    {
        reset([BUILTIN, USB('101')]);
        const ext = extension({'microphone-id': '101', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        eq('migration: stable id saved', ext.store['microphone-stable-id'], 'usb-x');
        fake.mics = [USB('202'), BUILTIN];
        fake.inventory = 'inv-migrated';
        await ext.ctl.toggle(true, null);
        eq('migration: later re-enumeration still resolves', posts().map(p => p.source_id), ['202']);
    }
    {
        reset([BUILTIN, USB('202')]);
        const ext = extension({'microphone-id': '101', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        eq('migration: legacy id absent -> nothing saved', ext.store['microphone-stable-id'], '');
        eq('migration: legacy id absent -> toggle refused', await ext.ctl.toggle(true, null), 'missing');
        eq('migration: legacy id absent -> nothing posted', posts(), []);
    }

    // --- old server (no stable_id, no mic.state) ---------------------------------------
    {
        reset([{id: 'm1', label: 'Built-in'}, {id: 'm2', label: 'USB headset'}], false);
        const ext = extension({'microphone-stable-id': 'usb-x', 'microphone-id': 'm2', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        await ext.ctl.toggle(true, null);
        await ext.poll();
        eq('old server: legacy id posted', posts().map(p => p.source_id), ['m2']);
        eq('old server: active label from the inventory', ext.ctl.view().switchLabel, 'Microphone: USB headset');
        await ext.ctl.toggle(false, null);
        fake.mics = [{id: 'm1', label: 'Built-in'}, {id: 'm9', label: 'USB headset'}];
        fake.requests = [];
        eq('old server: stale legacy id -> missing, no fallback', await ext.ctl.toggle(true, null), 'missing');
        eq('old server: nothing posted', posts(), []);
    }

    // --- stale poll: the session page turned the mic off since; a pick only saves ------
    {
        reset([BUILTIN, USB('202')]);
        const ext = extension({'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        eq('stale: on', await ext.ctl.toggle(true, null), 'on');
        await ext.poll();
        fake.status.mic = {available: true, on: false, source_id: null, stable_id: null, label: null, state: 'off', remembered: false};
        fake.requests = [];
        eq('stale: pick the built-in -> saved', await ext.ctl.choose(ext.ctl.view().sources[0], null), 'saved');
        eq('stale: fresh status read, nothing posted', [fake.requests.filter(r => r.path === '/control/v1/status').length, posts()], [1, []]);
        eq('stale: choice saved, mic still off', [ext.store['microphone-stable-id'], fake.status.mic.on], ['pci-builtin', false]);
    }

    // --- starting / stopping: a pick only saves ----------------------------------------
    for (const state of ['starting', 'stopping']) {
        reset([BUILTIN, USB('202')]);
        const ext = extension({'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        await ext.ctl.toggle(true, null);
        fake.status.state = state;
        await ext.poll();
        fake.requests = [];
        eq(`${state}: pick another device while on -> saved`, await ext.ctl.choose(ext.ctl.view().sources[0], null), 'saved');
        eq(`${state}: nothing posted`, posts(), []);
        fake.status.state = 'recording';
    }

    // --- polling never sends a mic request --------------------------------------------
    {
        reset([BUILTIN, USB('202')]);
        const ext = extension({'microphone-stable-id': 'usb-x', 'microphone-id': '101', 'microphone-label': 'USB headset'});
        await ext.openMenu();
        fake.status.mic = {available: true, on: true, source_id: null, stable_id: 'usb-x', label: 'USB headset', state: 'waiting_for_device', remembered: true};
        for (let i = 0; i < 3; i++)
            await ext.poll();
        eq('waiting: shown', ext.ctl.view().switchLabel, 'Microphone: USB headset (waiting for device)');
        fake.status.mic = {available: true, on: false, source_id: null, stable_id: null, label: null, state: 'off', remembered: true};
        await ext.openMenu();
        eq('polling and menu opens sent no POST', fake.requests.filter(r => r.method === 'POST'), []);
    }

    client.destroy();
    fake.stop();
    removeControlFile(runtimeDir);
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
