// Run: gjs -m tests/model_test.js
import {
    STATES, INTERVAL_CHOICES, NOT_RUNNING_TEXT,
    allowedActions, panelState, stateLabel, formatInterval, headerText,
    intervalItems, chooseMicrophone, micSourceItems, micSwitch, micRequest,
    pollPeriod, parseControlFile, pageUrl, lastErrorText, errorText, buildView,
} from '../whatdidido@wporter.org/lib/model.js';

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
function throws(name, fn, check = () => true) {
    try {
        fn();
    } catch (e) {
        if (check(e)) {
            print(`ok   ${name}`);
        } else {
            failed++;
            print(`FAIL ${name}: wrong error ${e.message}`);
        }
        return;
    }
    failed++;
    print(`FAIL ${name}: did not throw`);
}

// --- states and actions -------------------------------------------------
eq('states', STATES, ['stopped', 'starting', 'recording', 'paused', 'recovering', 'stopping', 'failed']);
const acts = s => Object.entries(allowedActions(s)).filter(([, v]) => v).map(([k]) => k);
eq('stopped -> start', acts('stopped'), ['start']);
eq('failed -> start', acts('failed'), ['start']);
eq('starting -> stop', acts('starting'), ['stop']);
eq('recording -> pause/stop', acts('recording'), ['pause', 'stop']);
eq('paused -> resume/stop', acts('paused'), ['resume', 'stop']);
eq('recovering -> stop', acts('recovering'), ['stop']);
eq('stopping -> nothing', acts('stopping'), []);
eq('not running -> nothing', acts(null), []);
eq('unknown state -> nothing', acts('exploded'), []);
eq('actions has all four keys', Object.keys(allowedActions('paused')), ['start', 'pause', 'resume', 'stop']);

// --- panel icon: shape differs per state, never colour alone ---------------
eq('recording icon', panelState('recording', true), {icon: 'media-record-symbolic', styleClass: 'wdi-recording', label: 'Recording'});
eq('paused icon', panelState('paused', true), {icon: 'media-playback-pause-symbolic', styleClass: 'wdi-paused', label: 'Paused'});
eq('recovering icon', panelState('recovering', true), {icon: 'view-refresh-symbolic', styleClass: 'wdi-recovering', label: 'Reconnecting…'});
eq('stopped icon', panelState('stopped', true).icon, 'media-playback-stop-symbolic');
eq('failed icon', panelState('failed', true), {icon: 'dialog-error-symbolic', styleClass: 'wdi-failed', label: 'Failed'});
eq('starting icon', panelState('starting', true).icon, 'content-loading-symbolic');
eq('stopping icon', panelState('stopping', true).styleClass, 'wdi-busy');
eq('not running icon', panelState('recording', false), {icon: 'network-offline-symbolic', styleClass: 'wdi-offline', label: 'whatdidido not running'});
eq('unknown state icon', panelState('exploded', true).icon, 'dialog-error-symbolic');
const icons = new Set(['stopped', 'recording', 'paused', 'recovering', 'failed'].map(s => panelState(s, true).icon));
icons.add(panelState(null, false).icon);
eq('distinct shapes for the 6 main states', icons.size, 6);
eq('NOT_RUNNING_TEXT', NOT_RUNNING_TEXT, 'whatdidido not running');

eq('label recording', stateLabel('recording'), 'Recording');
eq('label starting', stateLabel('starting'), 'Starting…');
eq('label stopping', stateLabel('stopping'), 'Stopping…');
eq('label unknown', stateLabel('weird'), 'Unknown state');

// --- interval formatting -------------------------------------------------
eq('fmt 5', formatInterval(5), '5s');
eq('fmt 30', formatInterval(30), '30s');
eq('fmt 60', formatInterval(60), '60s');
eq('fmt 90', formatInterval(90), '90s');
eq('fmt 120', formatInterval(120), '2 min');
eq('fmt 3600', formatInterval(3600), '60 min');
eq('fmt null', formatInterval(null), '?');
eq('fmt NaN', formatInterval('x'), '?');

// --- header --------------------------------------------------------------
eq('header plural', headerText({state: 'recording', samples: 12, interval_seconds: 30, monitors: 2}),
    {title: 'Recording', detail: '12 screenshots, every 30s, 2 monitors'});
eq('header singular', headerText({state: 'paused', samples: 1, interval_seconds: 5, monitors: 1}),
    {title: 'Paused', detail: '1 screenshot, every 5s, 1 monitor'});
eq('header missing counts', headerText({state: 'stopped'}),
    {title: 'Stopped', detail: '0 screenshots, every ?, 0 monitors'});

// --- interval submenu ----------------------------------------------------
eq('choices', INTERVAL_CHOICES, [5, 10, 30, 60]);
eq('interval items mark current', intervalItems(30).map(i => [i.seconds, i.label, i.current]),
    [[5, '5s', false], [10, '10s', false], [30, '30s', true], [60, '60s', false]]);
eq('interval off-menu current is inserted sorted', intervalItems(45).map(i => [i.seconds, i.current]),
    [[5, false], [10, false], [30, false], [45, true], [60, false]]);
eq('interval large current at end', intervalItems(300).map(i => i.seconds), [5, 10, 30, 60, 300]);
eq('interval unknown current marks nothing', intervalItems(null).filter(i => i.current).length, 0);
eq('interval items are not shared', intervalItems(5) !== intervalItems(5), true);

// --- microphone choice ---------------------------------------------------
const mics = [{id: 'm1', label: 'Built-in'}, {id: 'm2', label: 'USB headset'}];
eq('preferred mic present', chooseMicrophone(mics, 'm2'), 'm2');
eq('preferred mic gone -> first', chooseMicrophone(mics, 'gone'), 'm1');
eq('no preference -> first', chooseMicrophone(mics, ''), 'm1');
eq('no mics -> null', chooseMicrophone([], 'm1'), null);
eq('null list -> null', chooseMicrophone(null, ''), null);
eq('source items radio', micSourceItems(mics, 'm2'), [
    {id: 'm1', label: 'Built-in', checked: false}, {id: 'm2', label: 'USB headset', checked: true}]);
eq('source items default marks effective', micSourceItems(mics, '').map(i => i.checked), [true, false]);
eq('source items label fallback', micSourceItems([{id: 'x', label: ''}], '')[0].label, 'x');

eq('mic request off', micRequest(false, mics, 'm2', 'inv1'), {on: false});
eq('mic request on preferred', micRequest(true, mics, 'm2', 'inv1'), {on: true, source_id: 'm2', inventory: 'inv1'});
eq('mic request on default', micRequest(true, mics, '', 'inv1'), {on: true, source_id: 'm1', inventory: 'inv1'});
eq('mic request no mics', micRequest(true, [], '', 'inv1'), null);

const st = (state, mic) => ({state, mic});
eq('mic switch available', micSwitch(st('recording', {available: true, on: true, source_id: 'm1'}), true), {sensitive: true, on: true});
eq('mic switch unavailable', micSwitch(st('recording', {available: false, on: false, source_id: null}), true), {sensitive: false, on: false});
eq('mic switch stopped (selects for next start)', micSwitch(st('stopped', {available: true, on: false}), true), {sensitive: true, on: false});
eq('mic switch while starting', micSwitch(st('starting', {available: true, on: true}), true).sensitive, false);
eq('mic switch while stopping', micSwitch(st('stopping', {available: true, on: true}), true).sensitive, false);
eq('mic switch not running', micSwitch(null, false), {sensitive: false, on: false});
eq('mic switch missing mic object', micSwitch({state: 'recording'}, true), {sensitive: false, on: false});

// --- polling ---------------------------------------------------------------
for (const s of ['starting', 'recording', 'recovering', 'stopping'])
    eq(`poll fast while ${s}`, pollPeriod(s, false, 2, 10), 2);
for (const s of ['stopped', 'paused', 'failed', null])
    eq(`poll slow while ${s}`, pollPeriod(s, false, 2, 10), 10);
eq('poll fast while menu open', pollPeriod('stopped', true, 2, 10), 2);
eq('poll defaults', pollPeriod('paused', false), 10);
eq('poll never below 1s', pollPeriod('recording', false, 0, 10), 1);

// --- control file ----------------------------------------------------------
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const cf = o => JSON.stringify({version: 1, base_url: 'http://127.0.0.1:8123', token: TOKEN, ...o});
eq('control file ok', parseControlFile(cf()), {baseUrl: 'http://127.0.0.1:8123', token: TOKEN});
eq('control file ipv6', parseControlFile(cf({base_url: 'http://[::1]:9000'})).baseUrl, 'http://[::1]:9000');
eq('control file strips trailing slash', parseControlFile(cf({base_url: 'http://127.0.0.1:8123/'})).baseUrl, 'http://127.0.0.1:8123');
const noToken = e => !e.message.includes(TOKEN);
throws('control file bad json', () => parseControlFile('{'), noToken);
throws('control file wrong version', () => parseControlFile(cf({version: 2})), noToken);
throws('control file non-loopback', () => parseControlFile(cf({base_url: 'http://example.com:8123'})), noToken);
throws('control file loopback lookalike', () => parseControlFile(cf({base_url: 'http://127.0.0.1.evil.com:80'})), noToken);
throws('control file https', () => parseControlFile(cf({base_url: 'https://127.0.0.1:8123'})), noToken);
throws('control file path', () => parseControlFile(cf({base_url: 'http://127.0.0.1:8123/x'})), noToken);
throws('control file no port', () => parseControlFile(cf({base_url: 'http://127.0.0.1'})), noToken);
throws('control file userinfo', () => parseControlFile(cf({base_url: 'http://a@127.0.0.1:8123'})), noToken);
throws('control file token with CRLF', () => parseControlFile(cf({token: `${TOKEN}\r\nX: y`})), e => !e.message.includes('X: y'));
throws('control file empty token', () => parseControlFile(cf({token: ''})));
throws('control file numeric token', () => parseControlFile(cf({token: 42})));
throws('control file array', () => parseControlFile('[]'));

eq('page url', pageUrl('http://127.0.0.1:8123', '/session'), 'http://127.0.0.1:8123/session');
eq('page url trailing slash', pageUrl('http://127.0.0.1:8123/', '/day'), 'http://127.0.0.1:8123/day');

// --- errors ------------------------------------------------------------------
eq('last error none', lastErrorText({state: 'recording', last_error: null, reason: null}), null);
eq('last error', lastErrorText({state: 'recovering', last_error: 'ocr', reason: null}), 'Last error: ocr');
eq('last error with reason', lastErrorText({state: 'failed', last_error: 'portal', reason: 'cancelled'}), 'Last error: portal (cancelled)');
eq('failed without last_error shows reason', lastErrorText({state: 'failed', last_error: null, reason: 'denied'}), 'Failed: denied');
eq('reason alone while recording is not an error', lastErrorText({state: 'recording', last_error: null, reason: 'x'}), null);
eq('last error null status', lastErrorText(null), null);

eq('err not running', errorText({notRunning: true, message: 'connection refused'}), 'whatdidido not running');
eq('err not allowed', errorText({status: 409, code: 'not_allowed'}), 'Not allowed in the current state');
eq('err inventory', errorText({status: 409, code: 'inventory_changed'}), 'Microphones changed; try again');
eq('err unavailable', errorText({status: 409, code: 'unavailable'}), 'Microphone capture is not enabled on the server');
eq('err forbidden', errorText({status: 403, code: 'forbidden'}), 'Control token rejected');
eq('err failed', errorText({status: 500, code: 'failed'}), 'The command failed');
eq('err invalid', errorText({status: 400, code: 'invalid'}), 'Request rejected as invalid');
eq('err other http', errorText({status: 502, code: null}), 'HTTP 502');
eq('err plain', errorText(new Error('boom')), 'boom');

// --- whole view --------------------------------------------------------------
const status = {
    state: 'recording', samples: 3, interval_seconds: 10, monitors: 2,
    last_error: null, reason: null,
    mic: {available: true, on: true, source_id: 'm1'},
};
const v = buildView(status, {running: true, showMic: true});
eq('view panel', v.panel.icon, 'media-record-symbolic');
eq('view mic indicator on', v.micIndicator, true);
eq('view header', v.header, {title: 'Recording', detail: '3 screenshots, every 10s, 2 monitors'});
eq('view actions', v.actions, {start: false, pause: true, resume: false, stop: true});
eq('view mic', v.mic, {sensitive: true, on: true});
eq('view interval current', v.intervals.find(i => i.current).seconds, 10);
eq('view interval sensitive', v.intervalSensitive, true);
eq('view pages', v.pagesSensitive, true);
eq('view last error', v.lastError, null);
eq('view mic indicator hidden by setting', buildView(status, {running: true, showMic: false}).micIndicator, false);
eq('view mic indicator hidden when off', buildView({...status, mic: {available: true, on: false}}, {running: true, showMic: true}).micIndicator, false);

const off = buildView(null, {running: false, showMic: true});
eq('offline panel', off.panel.styleClass, 'wdi-offline');
eq('offline header', off.header, {title: 'whatdidido not running', detail: ''});
eq('offline actions all off', Object.values(off.actions).some(x => x), false);
eq('offline mic', off.mic, {sensitive: false, on: false});
eq('offline mic indicator', off.micIndicator, false);
eq('offline intervals insensitive', off.intervalSensitive, false);
eq('offline pages insensitive', off.pagesSensitive, false);
eq('offline header shows poll error detail', buildView(null, {running: false, pollError: 'Control token rejected'}).header,
    {title: 'whatdidido not running', detail: 'Control token rejected'});
eq('poll error ignored while running', buildView(status, {running: true, pollError: 'x'}).header.detail, '3 screenshots, every 10s, 2 monitors');
eq('offline running=true with null status is offline', buildView(null, {running: true}).running, false);

if (failed) {
    print(`${failed} failed`);
    (await import('system')).default.exit(1);
}
print('all passed');
