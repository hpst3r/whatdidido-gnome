// Output monitor client (CONTROL_API.md Amendment 5) against the loopback
// fake: GET /control/v1/outputs, POST /control/v1/output (consent only with
// on, the saved choice by stable id, one inventory_changed retry), feature
// detection on old and ungated servers, and the OutputController end to end.
// Run: gjs -m tests/output_client_test.js [runtime-dir]
import GLib from 'gi://GLib';
import System from 'system';

import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {OutputController, outputOffered} from '../whatdidido@wporter.org/lib/output_model.js';
import {FakeControl, writeControlFile, removeControlFile} from './fake_control.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const runtimeDir = ARGV[0] ?? GLib.build_filenamev([here, '..', 'build', 'test-runtime', 'output-client']);
GLib.mkdir_with_parents(runtimeDir, 0o700);
const TOKEN = 'tokenOUT_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let failed = 0;
function eq(name, got, want) {
    const g = String(JSON.stringify(got)), w = String(JSON.stringify(want));
    if (g !== w) {
        failed++;
        print(`FAIL ${name}: got ${g.slice(0, 400)} want ${w.slice(0, 400)}`);
    } else {
        print(`ok   ${name}`);
    }
}
async function rejects(name, promise, check) {
    try {
        const v = await promise;
        failed++;
        print(`FAIL ${name}: resolved ${JSON.stringify(v)}`);
    } catch (e) {
        if (check(e)) {
            print(`ok   ${name}`);
        } else {
            failed++;
            print(`FAIL ${name}: wrong error ${JSON.stringify({message: e.message, status: e.status, code: e.code})}`);
        }
    }
}

const DOCK = {stableId: 'alsa_output.usb-dock', id: 'o2', label: 'Dock Headphones'};

async function main() {
    try {
        removeControlFile(runtimeDir);
    } catch {}
    const fake = new FakeControl({token: TOKEN});
    writeControlFile(runtimeDir, fake.listen(), TOKEN);
    const client = new ControlClient({runtimeDir});
    const sent = () => fake.requests.filter(r => r.path.startsWith('/control/v1/output')).map(r => `${r.method} ${r.path} ${r.body}`);

    // --- feature detection --------------------------------------------------------
    const old = await client.status(null);
    eq('old server: no output key', 'output' in old, false);
    eq('old server: not offered', outputOffered(old, true), false);
    // The real router's catch-all refusal (the client re-reads control.json once on a 403).
    await rejects('old server: /outputs 403 forbidden', client.outputs(null), e => e.status === 403 && e.code === 'forbidden');
    fake.requests = [];
    await rejects('old server: off -> 403 forbidden', client.setOutputOn(false, DOCK, null), e => e.status === 403 && e.code === 'forbidden');

    fake.outputRoutes = true;
    fake.outputGate = false;
    eq('ungated server: no output key', 'output' in await client.status(null), false);
    await rejects('ungated: /outputs 409 unavailable', client.outputs(null), e => e.status === 409 && e.code === 'unavailable');
    fake.requests = [];
    await rejects('ungated: off -> 409 unavailable', client.setOutputOn(false, DOCK, null), e => e.status === 409 && e.code === 'unavailable');
    eq('ungated: off body', sent(), ['POST /control/v1/output {"on":false}']);

    fake.outputGate = true;
    const st = await client.status(null);
    eq('gated: output right after mic', Object.keys(st).slice(Object.keys(st).indexOf('mic'), Object.keys(st).indexOf('mic') + 2), ['mic', 'output']);
    eq('gated: offered', outputOffered(st, true), true);

    // --- GET /outputs ------------------------------------------------------------------
    fake.requests = [];
    const inv = await client.outputs(null);
    eq('outputs list', inv, {inventory: 'inv1', outputs: [
        {id: 'o1', label: 'Built-in Speakers', stable_id: 'alsa_output.pci'},
        {id: 'o2', label: 'Dock Headphones', stable_id: 'alsa_output.usb-dock'}]});
    const r0 = fake.requests[0];
    eq('outputs request: GET, bearer, no body', r0 && [r0.method, r0.path, r0.headers.authorization, r0.body],
        ['GET', '/control/v1/outputs', `Bearer ${TOKEN}`, '']);

    // --- POST /output -------------------------------------------------------------------
    fake.requests = [];
    const on = await client.setOutputOn(true, DOCK, null);
    eq('on -> output object', on, {output: {available: true, on: true, source_id: 'o2', stable_id: 'alsa_output.usb-dock',
        label: 'Dock Headphones', state: 'capturing', remembered: false}});
    eq('on: GET then POST with consent true', sent(), [
        'GET /control/v1/outputs ',
        'POST /control/v1/output {"on":true,"source_id":"o2","inventory":"inv1","consent":true}']);
    fake.requests = [];
    await client.setOutputOn(false, DOCK, null);
    eq('off: exactly {on:false}, no consent, no inventory read', sent(), ['POST /control/v1/output {"on":false}']);
    fake.requests = [];
    await client.setOutputOn(false, {}, null);
    eq('off without a choice is still sent', sent(), ['POST /control/v1/output {"on":false}']);

    // Reconnect: the dock re-enumerated with a new serial, speakers first.
    fake.inventory = 'inv5';
    fake.outputs = [{id: 'o9', label: 'Built-in Speakers', stable_id: 'alsa_output.pci'},
        {id: 'o12', label: 'Dock Headphones', stable_id: 'alsa_output.usb-dock'}];
    fake.requests = [];
    eq('reconnected: re-resolved by stable id', (await client.setOutputOn(true, DOCK, null))?.output?.source_id, 'o12');
    eq('reconnected: posted the new serial', sent().at(-1), 'POST /control/v1/output {"on":true,"source_id":"o12","inventory":"inv5","consent":true}');

    // inventory_changed: re-read and retry once.
    fake.requests = [];
    fake.outputInventoryChanges = 1;
    eq('inventory_changed retried once', (await client.setOutputOn(true, DOCK, null))?.output?.on, true);
    eq('retry sequence', sent(), [
        'GET /control/v1/outputs ',
        'POST /control/v1/output {"on":true,"source_id":"o12","inventory":"inv5","consent":true}',
        'GET /control/v1/outputs ',
        'POST /control/v1/output {"on":true,"source_id":"o12","inventory":"inv6","consent":true}']);
    fake.requests = [];
    fake.outputInventoryChanges = 2;
    await rejects('inventory_changed twice -> error', client.setOutputOn(true, DOCK, null), e => e.status === 409 && e.code === 'inventory_changed');
    eq('only one retry', sent().length, 4);
    fake.outputInventoryChanges = 0;

    // Missing / unset: nothing posted, never another output.
    fake.outputs = [{id: 'o9', label: 'Built-in Speakers', stable_id: 'alsa_output.pci'}];
    fake.requests = [];
    await rejects('missing -> output_missing', client.setOutputOn(true, DOCK, null),
        e => e.code === 'output_missing' && e.message === 'Dock Headphones is not connected' &&
            JSON.stringify(e.outputs?.map(o => o.id)) === '["o9"]');
    eq('missing: nothing posted', sent(), ['GET /control/v1/outputs ']);
    fake.requests = [];
    await rejects('unset -> output_unset', client.setOutputOn(true, {}, null), e => e.code === 'output_unset');
    eq('unset: no request at all', fake.requests.length, 0);
    // Legacy id only when no stable id is known.
    fake.outputs = [{id: 'o3', label: 'HDMI', stable_id: null}];
    fake.requests = [];
    eq('legacy id without a stable id', (await client.setOutputOn(true, {stableId: '', id: 'o3', label: 'HDMI'}, null))?.output?.source_id, 'o3');
    await client.setOutputOn(false, {}, null);

    // The fake's own rule, so a client that forgot consent would be caught.
    fake.outputs = [{id: 'o9', label: 'Built-in Speakers', stable_id: 'alsa_output.pci'}];
    eq('fake refuses on without consent', await client._request('POST', '/control/v1/output',
        {on: true, source_id: 'o9', inventory: fake.inventory}, null).then(() => 'ok', e => e.code), 'invalid');
    eq('fake refuses consent false', await client._request('POST', '/control/v1/output',
        {on: true, source_id: 'o9', inventory: fake.inventory, consent: false}, null).then(() => 'ok', e => e.code), 'invalid');

    // --- the controller end to end: dialog, then consent ------------------------------
    fake.outputs = [{id: 'o9', label: 'Built-in Speakers', stable_id: 'alsa_output.pci'},
        {id: 'o12', label: 'Dock Headphones', stable_id: 'alsa_output.usb-dock'}];
    const store = {'output-stable-id': '', 'output-id': '', 'output-label': ''};
    const answers = [];
    let asked = 0;
    const ctl = new OutputController({
        settings: {get: k => store[k], set: (k, v) => {
            store[k] = v;
        }},
        setOutputOn: (o, p, c) => client.setOutputOn(o, p, c),
        readStatus: c => client.status(c),
        confirm: async () => {
            asked++;
            return answers.shift() ?? false;
        },
    });
    const poll = async () => ctl.updateStatus(await client.status(null), true);
    await poll();
    ctl.setInventory((await client.outputs(null)).outputs);
    fake.requests = [];
    eq('e2e: tile on without a choice -> choose', await ctl.toggle(true, null), 'choose');
    answers.push(false);
    eq('e2e: pick, cancel the dialog -> cancelled', await ctl.choose(ctl.view().sources[1], null), 'cancelled');
    eq('e2e: cancelled sent nothing to /output', sent(), []);
    eq('e2e: still off', (await client.status(null)).output.on, false);
    await ctl.toggle(true, null);  // the saved choice now: asks again
    eq('e2e: tile on asked again (and was cancelled)', [asked, sent()], [2, []]);
    answers.push(true);
    eq('e2e: tile on, agreed -> on', await ctl.toggle(true, null), 'on');
    eq('e2e: consent sent once, after the dialog', sent().filter(r => r.startsWith('POST')),
        ['POST /control/v1/output {"on":true,"source_id":"o12","inventory":"inv8","consent":true}']);
    await poll();
    fake.requests = [];
    eq('e2e: switch while on -> on, no dialog', [await ctl.choose(ctl.view().sources[0], null), asked], ['on', 3]);
    eq('e2e: switch posted the speakers with consent', sent().filter(r => r.startsWith('POST')),
        ['POST /control/v1/output {"on":true,"source_id":"o9","inventory":"inv8","consent":true}']);
    // A remembered output that is on: polls never ask or send.
    fake.output = {...fake.output, remembered: true};
    fake.requests = [];
    for (let i = 0; i < 3; i++)
        await poll();
    ctl.setInventory((await client.outputs(null)).outputs);
    eq('e2e: polling a remembered output: no dialog, no POST', [asked, fake.requests.filter(r => r.method === 'POST').length], [3, 0]);
    eq('e2e: tile off -> off', await ctl.toggle(false, null), 'off');
    eq('e2e: off at the server', (await client.status(null)).output.on, false);

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
