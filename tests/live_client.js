// Live smoke test against a running work-session server. Read-only: only
// GET /control/v1/status and /control/v1/microphones.
// Run: gjs -m tests/live_client.js [runtime-dir]   (default $XDG_RUNTIME_DIR)
import GLib from 'gi://GLib';
import System from 'system';

import {ControlClient} from '../whatdidido@wporter.org/lib/client.js';
import {buildView, errorText} from '../whatdidido@wporter.org/lib/model.js';

const client = new ControlClient(ARGV[0] ? {runtimeDir: ARGV[0]} : {});
const loop = new GLib.MainLoop(null, false);
let code = 0;
(async () => {
    const status = await client.status(null);
    print(JSON.stringify(buildView(status, {running: true}), null, 2));
    if (status.mic?.available)
        print(JSON.stringify(await client.microphones(null), null, 2));
})().catch(e => {
    print(`ERROR ${errorText(e)}`);
    code = e.notRunning ? 2 : 1;
}).finally(() => loop.quit());
loop.run();
System.exit(code);
