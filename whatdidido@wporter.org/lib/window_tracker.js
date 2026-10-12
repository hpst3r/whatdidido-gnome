import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {WindowReporter} from './window_model.js';

// Glue only: watches the focused window (focus, title, wm-class), the two
// settings, and GLib timers, and feeds WindowReporter (window_model.js),
// which decides what is sent and when.
export class WindowTracker {
    // send(payload) -> Promise (ControlClient.postWindow); log(message);
    // onUnavailable(): the server answered 409 (re-render the menu).
    constructor({settings, send, log, onUnavailable}) {
        this._settings = settings;
        this._tracker = Shell.WindowTracker.get_default();
        this._timers = new Set();
        this._window = null;
        this._windowIds = [];

        this._reporter = new WindowReporter({
            now: () => GLib.get_monotonic_time() / 1000,
            setTimer: (ms, fn) => {
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.ceil(ms)), () => {
                    this._timers.delete(id);
                    fn();
                    return GLib.SOURCE_REMOVE;
                });
                this._timers.add(id);
                return id;
            },
            clearTimer: id => {
                if (this._timers.delete(id))
                    GLib.source_remove(id);
            },
            readFocus: () => this._readFocus(),
            send,
            log,
            onUnavailable,
            enabled: settings.get_boolean('report-active-window'),
            excluded: settings.get_strv('window-title-excluded-apps'),
        });

        this._settingsIds = [
            settings.connect('changed::report-active-window',
                () => this._reporter.setEnabled(settings.get_boolean('report-active-window'))),
            settings.connect('changed::window-title-excluded-apps',
                () => this._reporter.setExcluded(settings.get_strv('window-title-excluded-apps'))),
        ];
        this._focusId = global.display.connect('notify::focus-window', () => this._onFocus());
        this._watch(global.display.focus_window);
    }

    get unavailable() {
        return this._reporter.unavailable;
    }

    // After every status poll (status null when the server is not running).
    updateStatus(status, running) {
        this._reporter.updateStatus(status, running);
    }

    // Only called by the reporter while reporting is active.
    _readFocus() {
        const win = global.display.focus_window;
        if (!win)
            return null;
        const app = this._tracker.get_window_app(win);
        return {
            appId: app?.get_id() ?? null,
            appName: app?.get_name() ?? null,
            wmClass: win.get_wm_class(),
            title: win.get_title(),
        };
    }

    _onFocus() {
        this._watch(global.display.focus_window);
        this._reporter.changed();
    }

    // Title/wm-class signals follow the focused window only.
    _watch(win) {
        this._unwatch();
        if (!win)
            return;
        this._window = win;
        this._windowIds = [
            win.connect('notify::title', () => this._reporter.changed()),
            win.connect('notify::wm-class', () => this._reporter.changed()),
        ];
    }

    _unwatch() {
        for (const id of this._windowIds)
            this._window.disconnect(id);
        this._window = null;
        this._windowIds = [];
    }

    destroy() {
        this._reporter.destroy();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        global.display.disconnect(this._focusId);
        this._unwatch();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settings = null;
    }
}
