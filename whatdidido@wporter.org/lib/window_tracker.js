import GLib from 'gi://GLib';

import {FocusWatch, MonitorSet, WindowReporter, windowMonitors} from './window_model.js';

// Glue only: watches the focused window (focus, title, wm-class, position,
// size), the monitor layout, the window settings, and GLib timers, and feeds
// WindowReporter (window_model.js), which decides what is sent and when.
// Frame rects and monitor geometries are both Mutter logical layout
// coordinates (AT_REST_GUARD.md section 6).
export class WindowTracker {
    // send(payload) -> Promise (ControlClient.postWindow); log(message);
    // onUnavailable(): the server answered 409 (re-render the menu);
    // apps: Shell.WindowTracker; display: the shell's MetaDisplay;
    // monitorManager: its MetaMonitorManager (injected so
    // tests/window_tracker_test.js runs this glue against fakes).
    constructor({settings, send, log, onUnavailable, apps, display = global.display,
        monitorManager = global.backend.get_monitor_manager()}) {
        this._settings = settings;
        this._tracker = apps;
        this._display = display;
        this._monitorManager = monitorManager;
        this._timers = new Set();

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
            titleRules: settings.get_value('window-title-rules').deep_unpack(),
            ignoreDigitChanges: settings.get_boolean('window-title-ignore-digit-changes'),
        });

        this._settingsIds = [
            settings.connect('changed::report-active-window',
                () => this._reporter.setEnabled(settings.get_boolean('report-active-window'))),
            settings.connect('changed::window-title-excluded-apps',
                () => this._reporter.setExcluded(settings.get_strv('window-title-excluded-apps'))),
            settings.connect('changed::window-title-rules',
                () => this._reporter.setTitleRules(settings.get_value('window-title-rules').deep_unpack())),
            settings.connect('changed::window-title-ignore-digit-changes',
                () => this._reporter.setIgnoreDigitChanges(settings.get_boolean('window-title-ignore-digit-changes'))),
        ];
        // Title/wm-class/position/size signals follow the focused window
        // only. A move, resize or layout change is reported only when it
        // changes the window's monitor set (not on every pixel of a drag).
        this._monitorSet = new MonitorSet(() => this._readMonitors(), () => this._reporter.changed());
        this._focusWatch = new FocusWatch(() => this._reporter.changed(), () => this._monitorSet.update());
        this._focusId = display.connect('notify::focus-window', () => this._onFocus());
        this._monitorsId = monitorManager.connect('monitors-changed', () => this._monitorSet.update());
        this._focusWatch.watch(display.focus_window);
        this._monitorSet.reset();
    }

    get unavailable() {
        return this._reporter.unavailable;
    }

    // Poll at poll-active while paused or stopped too (WindowReporter.watching).
    get watching() {
        return this._reporter.watching;
    }

    // After every status poll (status null when the server is not running).
    updateStatus(status, running) {
        this._reporter.updateStatus(status, running);
    }

    // Only called by the reporter while reporting is active.
    _readFocus() {
        const win = this._display.focus_window;
        if (!win)
            return null;
        const app = this._tracker.get_window_app(win);
        return {
            appId: app?.get_id() ?? null,
            appName: app?.get_name() ?? null,
            wmClass: win.get_wm_class(),
            title: win.get_title(),
            frame: win.get_frame_rect(),
            layout: this._layout(),
        };
    }

    _layout() {
        const display = this._display;
        return Array.from({length: display.get_n_monitors()}, (_, i) => display.get_monitor_geometry(i));
    }

    _readMonitors() {
        const win = this._display.focus_window;
        return windowMonitors(win ? win.get_frame_rect() : null, this._layout());
    }

    _onFocus() {
        this._focusWatch.watch(this._display.focus_window);
        this._monitorSet.reset();
        this._reporter.changed(true);
    }

    destroy() {
        this._reporter.destroy();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        this._display.disconnect(this._focusId);
        this._monitorManager.disconnect(this._monitorsId);
        this._focusWatch.clear();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settings = null;
    }
}
