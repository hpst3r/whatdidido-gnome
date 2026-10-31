// tests/fake_control.js against the real control router's answers (whatdidido
// 5973c1ed, src/whatdidido/web/control_api.py, captured in-process by the
// outmon-ext review's router probe):
//   older server, /control/v1/outputs and /output -> 403 {"error":"forbidden"}
//     (the catch-all refusal for every unknown /control/ route), not 404
//   /outputs items                                -> keys id, label, stable_id
//   ungated /outputs and /output                  -> 409 unavailable, no output key
// Run: gjs -m tests/output_fakes_test.js
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {FakeControl} from './fake_control.js';

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

const session = new Soup.Session();
async function call(base, method, path, body = null) {
    const msg = Soup.Message.new(method, `${base}${path}`);
    msg.request_headers.append('Authorization', `Bearer ${TOKEN}`);
    if (body !== null)
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
    const bytes = await new Promise((resolve, reject) => session.send_and_read_async(msg, 0, null, (s, r) => {
        try {
            resolve(s.send_and_read_finish(r));
        } catch (e) {
            reject(e);
        }
    }));
    return {status: msg.get_status(), text: new TextDecoder().decode(bytes.get_data() ?? new Uint8Array())};
}

async function main() {
    const fake = new FakeControl({token: TOKEN});
    const base = fake.listen();

    // Older server (outputRoutes false): the real one answers the catch-all 403.
    const old = await call(base, 'GET', '/control/v1/outputs');
    eq('older server /outputs: real is 403 forbidden', [old.status, old.text], [403, '{"error":"forbidden"}']);
    const oldOff = await call(base, 'POST', '/control/v1/output', {on: false});
    eq('older server POST /output: 403 forbidden', [oldOff.status, oldOff.text], [403, '{"error":"forbidden"}']);
    const nonesuch = await call(base, 'GET', '/control/v1/nonesuch');
    eq('unknown /control/ route: 403 forbidden', [nonesuch.status, nonesuch.text], [403, '{"error":"forbidden"}']);
    const wrongMethod = await call(base, 'GET', '/control/v1/output');
    eq('known path, wrong method: 403 forbidden', [wrongMethod.status, wrongMethod.text], [403, '{"error":"forbidden"}']);

    fake.outputRoutes = true;
    fake.outputGate = false;
    const ung = await call(base, 'GET', '/control/v1/outputs');
    eq('ungated /outputs: 409 unavailable (real)', [ung.status, ung.text], [409, '{"error":"unavailable"}']);
    const ungOff = await call(base, 'POST', '/control/v1/output', {on: false});
    eq('ungated POST /output off: 409 unavailable (real)', [ungOff.status, ungOff.text], [409, '{"error":"unavailable"}']);
    const ungSt = JSON.parse((await call(base, 'GET', '/control/v1/status')).text);
    eq('ungated status: no output key (real)', 'output' in ungSt, false);

    fake.outputGate = true;
    const st = JSON.parse((await call(base, 'GET', '/control/v1/status')).text);
    eq('gated output object key order (real)', Object.keys(st.output),
        ['available', 'on', 'source_id', 'stable_id', 'label', 'state', 'remembered']);
    const list = JSON.parse((await call(base, 'GET', '/control/v1/outputs')).text);
    eq('/outputs item key order (real: id, label, stable_id)', Object.keys(list.outputs[0]), ['id', 'label', 'stable_id']);
    const noConsent = await call(base, 'POST', '/control/v1/output', {on: true, source_id: 'o1', inventory: 'inv1'});
    eq('on without consent: 400 invalid (real)', [noConsent.status, noConsent.text], [400, '{"error":"invalid"}']);
    const offExtra = await call(base, 'POST', '/control/v1/output', {on: false, consent: true});
    eq('off with consent key: 400 invalid (real)', [offExtra.status, offExtra.text], [400, '{"error":"invalid"}']);
    fake.stop();
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
