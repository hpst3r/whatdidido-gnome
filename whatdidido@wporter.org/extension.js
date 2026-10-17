import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {AppClient} from './lib/app_client.js';
import {ControlClient} from './lib/client.js';
import {localDate} from './lib/day_model.js';
import {MicController} from './lib/mic_model.js';
import {MicReminder, MIC_REMINDER_TITLE} from './lib/mic_reminder.js';
import {buildView, errorText, pollPeriod} from './lib/model.js';
import {PauseReminder, REMINDER_TITLE, timerDelay} from './lib/pause_reminder.js';
import {Popover} from './lib/popover.js';
import {assignErrorText, popoverView} from './lib/popover_model.js';
import {windowSwitchView} from './lib/window_model.js';
import {WindowTracker} from './lib/window_tracker.js';

const STATE_CLASSES = ['wdi-stopped', 'wdi-busy', 'wdi-recording', 'wdi-paused', 'wdi-recovering', 'wdi-failed', 'wdi-offline'];
const DAY_REFRESH_S = 15;   // the day is fetched again this often while the menu is open

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function monotonicMs() {
    return GLib.get_monotonic_time() / 1000;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'whatdidido');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._client = new ControlClient();
        this._cancellable = null;                       // the in-flight poll
        this._actionCancellable = new Gio.Cancellable(); // commands; cancelled on destroy
        this._timer = 0;
        this._status = null;
        this._running = false;
        this._pollError = null;
        this._notice = null;        // last failed action, shown in the menu
        this._noticeSeen = false;
        this._lastLogged = null;
        this._destroyed = false;
        this._reminder = new PauseReminder({minutes: this._settings.get_uint('pause-reminder-minutes')});
        this._reminderTimer = 0;
        this._reminderSource = null;
        this._reminderNotification = null;
        this._resumeLogged = null;
        this._micReminder = new MicReminder({minutes: this._settings.get_uint('mic-reminder-minutes')});
        this._micReminderTimer = 0;
        this._micReminderSource = null;
        this._micReminderNotification = null;
        this._chooseMicIdleId = 0;  // the mic reminder's "Choose microphone"
        this._commandBusy = false;  // a start/pause/resume/stop in flight
        this._intervalBusy = false;
        this._app = new AppClient({control: this._client, settings: {get: key => this._settings.get_string(key)}});
        this._appBase = null;       // the app server's origin, or null
        this._day = null;           // the last TimesheetDay, or null
        this._dayCancellable = null;
        this._dayTimer = 0;
        this._dayLogged = null;
        this._assignBusy = false;
        this._assignError = null;
        this._mic = new MicController({
            settings: {
                get: key => this._settings.get_string(key),
                set: (key, value) => this._settings.set_string(key, value),
            },
            setMicOn: (on, preferred, c) => this._client.setMicOn(on, preferred, c),
            readStatus: c => this._client.status(c),
            openSources: () => this._popover.expand('input'),
            changed: () => this._render(),
        });

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box wdi-panel-box'});
        this._stateIcon = new St.Icon({
            icon_name: 'network-offline-symbolic',
            style_class: 'system-status-icon wdi-state-icon wdi-offline',
        });
        this._micIcon = new St.Icon({
            icon_name: 'microphone-sensitivity-high-symbolic',
            style_class: 'system-status-icon wdi-mic-icon',
            visible: false,
        });
        box.add_child(this._stateIcon);
        box.add_child(this._micIcon);
        this.add_child(box);

        this._popover = new Popover({
            path: ext.path,
            onAction: action => this._onAction(action),
            onLink: link => this._openLink(link),
            changed: () => this._render(),
        });
        this.menu.box.add_child(this._popover.actor);
        // Light or dark like the shell's own style (POPOVER.md Amendment 1.4).
        St.Settings.get().connectObject('notify::color-scheme', () => this._render(), this);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interface.connectObject('changed::clock-format', () => this._render(), this);

        this._windowTracker = new WindowTracker({
            settings: this._settings,
            send: payload => this._client.postWindow(payload, this._actionCancellable),
            log: message => console.warn(message),
            onUnavailable: () => this._render(),
        });

        this._settingsIds = [
            this._settings.connect('changed::poll-active', () => this._schedule()),
            this._settings.connect('changed::poll-idle', () => this._schedule()),
            this._settings.connect('changed::show-mic-indicator', () => this._render()),
            ...['microphone-stable-id', 'microphone-id', 'microphone-label'].map(key =>
                this._settings.connect(`changed::${key}`, () => this._render())),
            this._settings.connect('changed::app-url', () => {
                this._appBase = null;
                this._day = null;
                this._render();
                if (this.menu.isOpen)
                    this._loadDay();
            }),
            this._settings.connect('changed::report-active-window', () => this._render()),
            this._settings.connect('changed::pause-reminder-minutes', () => this._applyReminder(
                this._reminder.setMinutes(this._settings.get_uint('pause-reminder-minutes'), monotonicMs()))),
            this._settings.connect('changed::mic-reminder-minutes', () => this._applyMicReminder(
                this._micReminder.setMinutes(this._settings.get_uint('mic-reminder-minutes'), monotonicMs()))),
        ];
        this.menu.connect('open-state-changed', (_m, open) => {
            this._popover.setOpen(open);
            if (open) {
                this._refresh();
                this._loadMics();
                this._loadDay();
            } else {
                this._mic.menuClosed();
                if (this._noticeSeen)
                    this._notice = null;
                this._noticeSeen = false;
                this._assignError = null;
                this._stopDay();
                this._schedule();
                this._render();
            }
        });

        this._render();
        this._refresh();
    }

    _schedule() {
        if (this._destroyed)
            return;
        if (this._timer)
            GLib.source_remove(this._timer);
        const period = pollPeriod(this._running ? this._status?.state : null, this.menu.isOpen,
            this._settings.get_uint('poll-active'), this._settings.get_uint('poll-idle'));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, period, () => {
            this._timer = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        if (this._destroyed)
            return;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        let observed = true;  // false: the poll failed, the state is unknown
        try {
            this._status = await this._client.status(cancellable);
            this._running = true;
            this._pollError = null;
            this._lastLogged = null;
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            this._status = null;
            this._running = false;
            observed = e.notRunning === true;
            // "Not running" is the normal idle case: never logged. Anything
            // else is logged once per distinct message (no token in messages).
            this._pollError = e.notRunning ? null : errorText(e);
            if (this._pollError && this._pollError !== this._lastLogged)
                console.warn(`whatdidido: status poll failed: ${e.message}`);
            this._lastLogged = this._pollError;
        }
        if (this._cancellable !== cancellable)
            return;
        // Only a status or "not running" says whether the session is still
        // paused (or the microphone quiet); any other poll failure leaves the
        // reminders as they were.
        if (observed) {
            this._applyReminder(this._reminder.observe(this._running ? this._status.state : null, monotonicMs()));
            this._applyMicReminder(this._micReminder.observe(this._running ? this._status : null, monotonicMs()));
        }
        this._windowTracker.updateStatus(this._status, this._running);
        this._mic.updateStatus(this._status, this._running);
        this._render();
        this._schedule();
    }

    // Run a control request, then refresh. Failures are shown in the menu.
    // Resolves to true when fn succeeded.
    async _act(fn) {
        let ok = false;
        try {
            await fn(this._actionCancellable);
            this._notice = null;
            ok = true;
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return false;
            this._notice = errorText(e);
        }
        this._refresh();
        return ok;
    }

    _command(action) {
        this._commandBusy = true;
        this._render();
        return this._act(c => this._client.command(action, c)).finally(() => {
            this._commandBusy = false;
            this._render();
        });
    }

    // The reminder's Resume: the menu's path, plus a log line once per
    // distinct failure (the menu shows it too).
    _resumeFromReminder() {
        this._act(async c => {
            try {
                await this._client.command('resume', c);
                this._resumeLogged = null;
            } catch (e) {
                if (!isCancelled(e)) {
                    const text = errorText(e);
                    if (text !== this._resumeLogged)
                        console.warn(`whatdidido: resume from the pause reminder failed: ${e.message}`);
                    this._resumeLogged = text;
                }
                throw e;
            }
        });
    }

    // effect from PauseReminder: {show: body or null, withdraw}. Then (re)arm
    // the one timeout for the next due reminder.
    _applyReminder({show, withdraw}) {
        if (this._destroyed)
            return;
        if (withdraw)
            this._withdrawReminder();
        if (show)
            this._showReminder(show);
        if (this._reminderTimer)
            GLib.source_remove(this._reminderTimer);
        this._reminderTimer = 0;
        const delay = timerDelay(this._reminder.dueAt, monotonicMs());
        if (delay === null)
            return;
        this._reminderTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reminderTimer = 0;
            this._applyReminder(this._reminder.fire(monotonicMs()));
            return GLib.SOURCE_REMOVE;
        });
    }

    // A Source destroys itself when its last notification goes (and the user
    // can dismiss it), so it is created on demand.
    _ensureReminderSource() {
        if (this._reminderSource)
            return this._reminderSource;
        const source = new MessageTray.Source({title: 'whatdidido', iconName: 'media-playback-pause-symbolic'});
        source.connect('destroy', () => {
            if (this._reminderSource === source)
                this._reminderSource = null;
        });
        Main.messageTray.add(source);
        this._reminderSource = source;
        return source;
    }

    // Replaces the previous reminder, so the banner shows again instead of
    // stacking. The new one is added first: removing the source's only
    // notification would destroy the source.
    _showReminder(body) {
        const source = this._ensureReminderSource();
        const old = this._reminderNotification;
        const notification = new MessageTray.Notification({
            source,
            title: REMINDER_TITLE,
            body,
            urgency: MessageTray.Urgency.HIGH,
        });
        // The shell destroys a notification after any of its actions runs,
        // so forget it first and never destroy it twice.
        notification.addAction('Resume', () => {
            this._forgetReminder(notification);
            this._resumeFromReminder();
        });
        notification.addAction('Stop reminding', () => {
            this._forgetReminder(notification);
            this._applyReminder(this._reminder.suppress());
        });
        notification.connect('destroy', () => this._forgetReminder(notification));
        this._reminderNotification = notification;
        source.addNotification(notification);
        old?.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
    }

    _forgetReminder(notification) {
        if (this._reminderNotification === notification)
            this._reminderNotification = null;
    }

    _withdrawReminder() {
        const notification = this._reminderNotification;
        this._reminderNotification = null;
        notification?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    }

    // The microphone reminder, like the pause reminder but independent: its
    // own timeout, source and notification. It never sends a control request.
    _applyMicReminder({show, withdraw}) {
        if (this._destroyed)
            return;
        if (withdraw)
            this._withdrawMicReminder();
        if (show)
            this._showMicReminder(show);
        if (this._micReminderTimer)
            GLib.source_remove(this._micReminderTimer);
        this._micReminderTimer = 0;
        const delay = timerDelay(this._micReminder.dueAt, monotonicMs());
        if (delay === null)
            return;
        this._micReminderTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._micReminderTimer = 0;
            this._applyMicReminder(this._micReminder.fire(monotonicMs()));
            return GLib.SOURCE_REMOVE;
        });
    }

    _ensureMicReminderSource() {
        if (this._micReminderSource)
            return this._micReminderSource;
        const source = new MessageTray.Source({title: 'whatdidido', iconName: 'audio-input-microphone-symbolic'});
        source.connect('destroy', () => {
            if (this._micReminderSource === source)
                this._micReminderSource = null;
        });
        Main.messageTray.add(source);
        this._micReminderSource = source;
        return source;
    }

    // Replaces the previous one, never stacks (see _showReminder).
    _showMicReminder(body) {
        const source = this._ensureMicReminderSource();
        const old = this._micReminderNotification;
        const notification = new MessageTray.Notification({
            source,
            title: MIC_REMINDER_TITLE,
            body,
            urgency: MessageTray.Urgency.HIGH,
        });
        notification.addAction('Choose microphone', () => {
            this._forgetMicReminder(notification);
            this._showMicSourcesFromReminder();
        });
        notification.addAction('Stop reminding', () => {
            this._forgetMicReminder(notification);
            this._applyMicReminder(this._micReminder.suppress());
        });
        notification.connect('destroy', () => this._forgetMicReminder(notification));
        this._micReminderNotification = notification;
        source.addNotification(notification);
        old?.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
    }

    _forgetMicReminder(notification) {
        if (this._micReminderNotification === notification)
            this._micReminderNotification = null;
    }

    _withdrawMicReminder() {
        const notification = this._micReminderNotification;
        this._micReminderNotification = null;
        notification?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    }

    // "Choose microphone" only shows the menu, with the input list expanded
    // if the session offers one; picking a source is the popover's own path.
    // On idle, once the banner or the calendar has handled the click.
    _showMicSourcesFromReminder() {
        if (this._destroyed || this._chooseMicIdleId)
            return;
        this._chooseMicIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._chooseMicIdleId = 0;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            if (!this.menu.isOpen)
                this.menu.open();
            this._popover.expand('input');
            return GLib.SOURCE_REMOVE;
        });
    }

    // User actions only: the mic tile and the input list. Polling never
    // sends a mic request. With no saved choice the controller expands the
    // input list instead (openSources) and the menu stays open.
    _setMic(on) {
        this._act(c => this._mic.toggle(on, c)).finally(() => this._loadMics());
    }

    _setInterval(seconds) {
        this._intervalBusy = true;
        this._render();
        return this._act(c => this._client.setInterval(seconds, c)).finally(() => {
            this._intervalBusy = false;
            this._render();
        });
    }

    // Saves the choice; turns the mic on after "Choose a microphone", or
    // switches a live microphone over to another device.
    _chooseMic(item) {
        this._act(c => this._mic.choose(item, c)).finally(() => this._loadMics());
    }

    // The popover's actions (lib/popover_model.js header). Promises go back
    // to the popover for 'interval' (it holds the dragged stop until then;
    // true: saved) and 'assign' (true: saved, so it forgets the picked ticket).
    _onAction(a) {
        switch (a.action) {
        case 'settings':
            this.menu.close();
            this._ext.openPreferences();
            return null;
        case 'command':
            return this._command(a.command);
        case 'mic':
            this._setMic(a.on);
            return null;
        case 'choose-mic':
            this._chooseMic(a.item);
            return null;
        case 'window':
            this._settings.set_boolean('report-active-window', a.on);
            return null;
        case 'interval':
            return this._setInterval(a.seconds);
        case 'assign':
            return this._assign(a.body);
        default:
            return null;
        }
    }

    // App links open in the default browser and close the menu.
    _openLink(link) {
        const url = this._app.url(link.view, link.params);
        if (!url)
            return;
        this.menu.close();
        try {
            Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
        } catch (e) {
            this._notice = errorText(e);
            this._render();
        }
    }

    // GET /api/v1/timesheet/day for this machine's date (POPOVER.md 3.3, 3.4):
    // on open, every DAY_REFRESH_S while open, after an Assign. A response
    // after the menu closed or a newer request started is dropped.
    async _loadDay() {
        if (this._destroyed || !this.menu.isOpen)
            return;
        this._dayCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._dayCancellable = cancellable;
        this._armDayTimer();
        let base = null, day = null;
        try {
            base = await this._app.base(cancellable);
            day = base ? await this._app.day(localDate(Date.now()), cancellable) : null;
            this._dayLogged = null;
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            // Nothing listening: hidden, found again next time. Anything
            // else: hidden and logged once per distinct message.
            if (!e.unreachable && e.message !== this._dayLogged)
                console.warn(`whatdidido: timesheet day failed: ${e.message}`);
            this._dayLogged = e.unreachable ? null : e.message;
        }
        if (this._dayCancellable !== cancellable || !this.menu.isOpen)
            return;
        this._dayCancellable = null;
        this._appBase = base;
        this._day = day;
        this._render();
    }

    _armDayTimer() {
        if (this._dayTimer)
            GLib.source_remove(this._dayTimer);
        this._dayTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DAY_REFRESH_S, () => {
            this._dayTimer = 0;
            this._loadDay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopDay() {
        this._dayCancellable?.cancel();
        this._dayCancellable = null;
        if (this._dayTimer)
            GLib.source_remove(this._dayTimer);
        this._dayTimer = 0;
    }

    // POST /api/v1/timesheet/assignments, then the day again either way.
    async _assign(body) {
        if (this._assignBusy)
            return false;
        this._assignBusy = true;
        this._assignError = null;
        this._render();
        let ok = false;
        try {
            await this._app.assign(body, this._actionCancellable);
            ok = true;
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return false;
            // Closing the menu clears the error (Amendment 2.6); one that
            // arrives after it closed is only logged.
            if (this.menu.isOpen)
                this._assignError = assignErrorText(e);
            console.warn(`whatdidido: assign failed: ${e.message}`);
        }
        this._assignBusy = false;
        this._render();
        this._loadDay();
        return ok;
    }

    async _loadMics() {
        if (this._destroyed)
            return;
        if (!this._running || !this._status?.mic?.available) {
            this._mic.setInventory(null);
            return;
        }
        let mics;
        try {
            mics = (await this._client.microphones(this._actionCancellable)).microphones ?? [];
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            mics = null;
        }
        if (!this._destroyed)
            this._mic.setInventory(mics);  // also migrates a legacy microphone-id
    }

    _render() {
        if (this._destroyed)
            return;
        const view = buildView(this._status, {
            running: this._running,
            showMic: this._settings.get_boolean('show-mic-indicator'),
            pollError: this._pollError,
            pausedMs: this._reminder.pausedFor(monotonicMs()),
        });

        this._stateIcon.icon_name = view.panel.icon;
        for (const c of STATE_CLASSES)
            this._stateIcon.remove_style_class_name(c);
        this._stateIcon.add_style_class_name(view.panel.styleClass);
        this._micIcon.visible = view.micIndicator;
        this.accessible_name = view.accessibleName;

        if (this._notice && this.menu.isOpen)
            this._noticeSeen = true;

        const variant = Main.getStyleVariant() === 'light' ? 'light' : 'dark';
        this._popover.update(popoverView(this._status, {
            running: this._running,
            pollError: this._pollError,
            notice: this._notice,
            pausedMs: this._reminder.pausedFor(monotonicMs()),
            mic: this._mic.view(),
            mics: this._mic.mics,
            micChoiceLabel: this._mic.preferred.label,
            window: windowSwitchView(this._status, {
                running: this._running,
                enabled: this._settings.get_boolean('report-active-window'),
                unavailable: this._windowTracker.unavailable,
            }),
            app: {base: this._appBase, day: this._day, invalidSetting: this._app.invalidSetting},
            use24h: this._interface.get_string('clock-format') === '24h',
            variant,
            ui: {
                ...this._popover.ui,
                assignBusy: this._assignBusy,
                assignError: this._assignError,
                intervalBusy: this._intervalBusy,
                commandBusy: this._commandBusy,
            },
        }));
    }

    destroy() {
        this._destroyed = true;
        this._stopDay();
        this._app.destroy();
        St.Settings.get().disconnectObject(this);
        this._interface.disconnectObject(this);
        this._interface = null;
        this._popover.destroy();
        this._windowTracker.destroy();
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (this._reminderTimer)
            GLib.source_remove(this._reminderTimer);
        this._reminderTimer = 0;
        this._reminderNotification = null;
        this._reminderSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._reminderSource = null;
        if (this._micReminderTimer)
            GLib.source_remove(this._micReminderTimer);
        this._micReminderTimer = 0;
        if (this._chooseMicIdleId)
            GLib.source_remove(this._chooseMicIdleId);
        this._chooseMicIdleId = 0;
        this._micReminderNotification = null;
        this._micReminderSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._micReminderSource = null;
        this._cancellable?.cancel();
        this._actionCancellable.cancel();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._client.destroy();
        this._settings = null;
        super.destroy();
    }
});

export default class WhatdididoExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
