// Review finding (gnome-mic-review): switch on, then off again before the on
// request has been sent (keyboard space twice keeps the menu open). Off is a
// single POST; on first GETs the inventory, so its POST arrives last and the
// microphone ends ON although the user's last action was off.
// Run: gjs -m tests/mic_review_toggle_race_test.js [runtime-dir]
import GLib from 'gi://GLib';
import System from 'system';

import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {MicController} from '../whatdidido@wporter.org/lib/mic_model.js';
import {FakeControl, writeControlFile, removeControlFile} from './fake_control.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const runtimeDir = ARGV[0] ?? GLib.build_filenamev([here, '..', 'build', 'test-runtime', 'mic-toggle-race']);
GLib.mkdir_with_parents(runtimeDir, 0o700);
const TOKEN = 'tokenREV_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

async function main() {
    const fake = new FakeControl({token: TOKEN});
    fake.micDetails = true;
    fake.mics = [{id: '7', label: 'Built-in', stable_id: 'pci-builtin'}, {id: '202', label: 'USB headset', stable_id: 'usb-x'}];
    writeControlFile(runtimeDir, fake.listen(), TOKEN);
    const client = new ControlClient({runtimeDir});
    const store = {'microphone-stable-id': 'usb-x', 'microphone-id': '202', 'microphone-label': 'USB headset'};
    const ctl = new MicController({
        settings: {get: k => store[k], set: (k, v) => {
            store[k] = v;
        }},
        setMicOn: (on, preferred, c) => client.setMicOn(on, preferred, c),
    });
    ctl.updateStatus(await client.status(null), true);
    ctl.setInventory((await client.microphones(null)).microphones);

    // User: on, then immediately off.
    const on = ctl.toggle(true, null);
    const off = ctl.toggle(false, null);
    await Promise.allSettled([on, off]);
    const order = fake.requests.filter(r => r.method === 'POST' && r.path === '/control/v1/mic').map(r => JSON.parse(r.body).on);
    print(`     POST /mic order at the server: ${JSON.stringify(order)}`);
    const status = await client.status(null);
    eq('last action was off -> microphone off', status.mic.on, false);

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
