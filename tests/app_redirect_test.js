// AppClient never follows a redirect on the day and Assign requests
// (POPOVER.md 3.1/3.2, Amendment 1, Amendment 2.1): a 3xx from the loopback
// app-server port is an ordinary failure ('HTTP 302'), so neither the client
// nor the Assign body (ticket, client) reaches another host. 127.0.0.2
// stands in for "any other host" so nothing leaves this machine.
// Run: gjs -m tests/app_redirect_test.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import {AppClient} from '../whatdidido@wporter.org/lib/app_client.js';
import {sampleDay} from './fake_app.js';

let failed = 0;
function check(name, ok, detail) {
    if (ok) {
        print(`ok   ${name}`);
    } else {
        failed++;
        print(`FAIL ${name}: ${detail}`);
    }
}

// The "other host": records what reaches it.
const elsewhere = [];
const other = new Soup.Server({});
other.add_handler(null, (_s, msg, path) => {
    const bytes = msg.get_request_body().flatten().get_data();
    elsewhere.push({method: msg.get_method(), path, body: bytes ? new TextDecoder().decode(bytes) : ''});
    msg.set_status(200, null);
    const day = {...sampleDay()};
    msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(JSON.stringify(path.includes('assign') ? {assignment: {ticket: 'x'}} : day)));
});
other.listen(Gio.InetSocketAddress.new_from_string('127.0.0.2', 0), 0);
const otherPort = other.get_uris()[0].get_port();

// The loopback app-server port answers every request with a redirect away.
const app = new Soup.Server({});
app.add_handler(null, (_s, msg, path) => {
    msg.set_status(path.includes('assign') ? 307 : 302, null);
    msg.get_response_headers().append('Location', `http://127.0.0.2:${otherPort}${path}`);
    msg.set_response('text/plain', Soup.MemoryUse.COPY, new TextEncoder().encode(''));
});
app.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const appPort = app.get_uris()[0].get_port();

const client = new AppClient({control: null, settings: {get: () => `http://127.0.0.1:${appPort}`}});

async function main() {
    let dayError = null;
    try {
        await client.day('2026-10-15', null);
    } catch (e) {
        dayError = e;
    }
    check('day: a redirect off 127.0.0.1 is not followed', !elsewhere.some(r => r.method === 'GET'),
        `GET reached 127.0.0.2:${otherPort}: ${JSON.stringify(elsewhere.filter(r => r.method === 'GET').map(r => r.path))}`);
    check('day: a 302 rejects with HTTP 302', dayError?.status === 302 && dayError.message === 'HTTP 302',
        `${dayError?.message} (status ${dayError?.status})`);
    let assignError = null;
    try {
        await client.assign({start: 'a', end: 'b', ticket: '#4101', client: 'Contoso', category: '', note: '', billable: true}, null);
    } catch (e) {
        assignError = e;
    }
    const post = elsewhere.find(r => r.method === 'POST');
    check('assign: a 307 off 127.0.0.1 is not followed', !post, `POST body reached 127.0.0.2: ${post?.body}`);
    check('assign: a 307 rejects with HTTP 307', assignError?.status === 307, `${assignError?.message}`);
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    failed++;
    print(`FAIL uncaught: ${e}`);
}).finally(() => loop.quit());
loop.run();
client.destroy();
app.disconnect();
other.disconnect();
if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
print('all passed');
