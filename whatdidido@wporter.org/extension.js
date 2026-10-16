import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ControlClient} from './lib/client.js';
import {MicController} from './lib/mic_model.js';
import {MicReminder, MIC_REMINDER_TITLE} from './lib/mic_reminder.js';
import {buildView, errorText, pageUrl, pollPeriod} from './lib/model.js';
import {PauseReminder, REMINDER_TITLE, timerDelay} from './lib/pause_reminder.js';
import {windowSwitchView} from './lib/window_model.js';
import {WindowTracker} from './lib/window_tracker.js';

const STATE_CLASSES = ['wdi-stopped', 'wdi-busy', 'wdi-recording', 'wdi-paused', 'wdi-recovering', 'wdi-failed', 'wdi-offline'];
const ACTIONS = [['start', 'Start'], ['pause', 'Pause'], ['resume', 'Resume'], ['stop', 'Stop']];

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
        this._intervalKey = '';
        this._syncing = false;
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
        this._reopenMenuId = 0;     // 'menu-closed' handler showing the source list again
        this._reopenIdleId = 0;
        this._mic = new MicController({
            settings: {
                get: key => this._settings.get_string(key),
                set: (key, value) => this._settings.set_string(key, value),
            },
            setMicOn: (on, preferred, c) => this._client.setMicOn(on, preferred, c),
            readStatus: c => this._client.status(c),
            openSources: () => this._openMicSources(),
            changed: () => {
                this._render();
                this._renderMics();
            },
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

        this._buildMenu();

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
                this._settings.connect(`changed::${key}`, () => {
                    this._render();
                    this._renderMics();
                })),
            this._settings.connect('changed::report-active-window', () => this._render()),
            this._settings.connect('changed::pause-reminder-minutes', () => this._applyReminder(
                this._reminder.setMinutes(this._settings.get_uint('pause-reminder-minutes'), monotonicMs()))),
            this._settings.connect('changed::mic-reminder-minutes', () => this._applyMicReminder(
                this._micReminder.setMinutes(this._settings.get_uint('mic-reminder-minutes'), monotonicMs()))),
        ];
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                // Reopened during the close animation of the switch's own
                // close: 'menu-closed' never comes, so show the list now.
                if (this._reopenMenuId) {
                    this._cancelReopen();
                    this._micSourceMenu.setSubmenuShown(true);
                }
                this._refresh();
                this._loadMics();
            } else {
                // Not when the switch's own close is about to show the source list.
                if (!this._reopenMenuId)
                    this._mic.menuClosed();
                if (this._noticeSeen)
                    this._notice = null;
                this._noticeSeen = false;
                this._schedule();
            }
        });

        this._render();
        this._renderMics();
        this._refresh();
    }

    _buildMenu() {
        this._header = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._title = new St.Label({style_class: 'wdi-header-title'});
        this._detail = new St.Label({style_class: 'wdi-header-detail'});
        col.add_child(this._title);
        col.add_child(this._detail);
        this._header.add_child(col);
        this.menu.addMenuItem(this._header);

        this._errorItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._errorItem.label.add_style_class_name('wdi-error');
        this.menu.addMenuItem(this._errorItem);
        this._noticeItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._noticeItem.label.add_style_class_name('wdi-error');
        this.menu.addMenuItem(this._noticeItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._actionItems = {};
        for (const [action, label] of ACTIONS)
            this._actionItems[action] = this.menu.addAction(label, () => this._command(action));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._micItem = new PopupMenu.PopupSwitchMenuItem('Microphone', false);
        // setToggleState() also emits 'toggled' in Shell 50: ignore our own syncs.
        this._micItem.connect('toggled', (_item, on) => {
            if (!this._syncing)
                this._setMic(on);
        });
        this.menu.addMenuItem(this._micItem);
        // Why the mic is off: "Choose a microphone", "<label> is not connected".
        this._micHintItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._micHintItem.label.add_style_class_name('wdi-error');
        this.menu.addMenuItem(this._micHintItem);
        this._micSourceMenu = new PopupMenu.PopupSubMenuMenuItem('Microphone source');
        this.menu.addMenuItem(this._micSourceMenu);
        this._intervalMenu = new PopupMenu.PopupSubMenuMenuItem('Screenshot interval');
        this.menu.addMenuItem(this._intervalMenu);
        this._windowItem = new PopupMenu.PopupSwitchMenuItem('Record active window', false);
        this._windowItem.connect('toggled', (_item, on) => {
            if (!this._syncing)
                this._settings.set_boolean('report-active-window', on);
        });
        this.menu.addMenuItem(this._windowItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sessionItem = this.menu.addAction('Open session page', () => this._open('/session'));
        this._dayItem = this.menu.addAction('Open day view', () => this._open('/day'));
        this.menu.addAction('Settings', () => this._ext.openPreferences());
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
    async _act(fn) {
        try {
            await fn(this._actionCancellable);
            this._notice = null;
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            this._notice = errorText(e);
        }
        this._refresh();
    }

    _command(action) {
        this._act(c => this._client.command(action, c));
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

    // "Choose microphone" only shows the menu, with the source list open if
    // the session offers one; picking a source is the menu's own path. On
    // idle, once the banner or the calendar has handled the click.
    _showMicSourcesFromReminder() {
        if (this._destroyed || this._chooseMicIdleId)
            return;
        this._chooseMicIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._chooseMicIdleId = 0;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            if (!this.menu.isOpen)
                this.menu.open();
            if (this._micSourceMenu.visible)
                this._micSourceMenu.setSubmenuShown(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    // User actions only: the switch and the source submenu. Polling never
    // sends a mic request.
    _setMic(on) {
        this._act(c => this._mic.toggle(on, c)).finally(() => this._loadMics());
    }

    _setInterval(seconds) {
        this._act(c => this._client.setInterval(seconds, c));
    }

    // Saves the choice; turns the mic on after "Choose a microphone", or
    // switches a live microphone over to another device.
    _chooseMic(item) {
        this._act(c => this._mic.choose(item, c)).finally(() => this._loadMics());
    }

    // Turning the switch on without a saved choice. Activating the switch
    // item closes the menu (space on the keyboard does not), so show the menu
    // again once it has closed, with the source list open.
    _openMicSources() {
        if (this._destroyed || this._reopenMenuId)
            return;
        this._reopenMenuId = this.menu.connect('menu-closed', () => {
            this._cancelReopen();
            if (!this._destroyed) {
                this.menu.open();
                this._micSourceMenu.setSubmenuShown(true);
            }
        });
        this._reopenIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reopenIdleId = 0;
            if (this.menu.isOpen) {
                this._cancelReopen();
                this._micSourceMenu.setSubmenuShown(true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelReopen() {
        if (this._reopenMenuId)
            this.menu.disconnect(this._reopenMenuId);
        this._reopenMenuId = 0;
        if (this._reopenIdleId)
            GLib.source_remove(this._reopenIdleId);
        this._reopenIdleId = 0;
    }

    _open(path) {
        this._client.baseUrl(null).then(base => {
            Gio.AppInfo.launch_default_for_uri(pageUrl(base, path), global.create_app_launch_context(0, -1));
        }).catch(e => {
            this._notice = errorText(e);
            this._render();
        });
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

        this._title.text = view.header.title;
        this._detail.text = view.header.detail;
        this._detail.visible = !!view.header.detail;
        this._errorItem.label.text = view.lastError ?? '';
        this._errorItem.visible = !!view.lastError;
        this._noticeItem.label.text = this._notice ?? '';
        this._noticeItem.visible = !!this._notice;
        if (this._notice && this.menu.isOpen)
            this._noticeSeen = true;

        for (const [action] of ACTIONS)
            this._actionItems[action].setSensitive(view.actions[action]);

        const windowView = windowSwitchView(this._status, {
            running: this._running,
            enabled: this._settings.get_boolean('report-active-window'),
            unavailable: this._windowTracker.unavailable,
        });
        this._syncing = true;
        try {
            this._micItem.setToggleState(view.mic.on);
            this._windowItem.setToggleState(windowView.on);
        } finally {
            this._syncing = false;
        }
        this._micItem.setSensitive(view.mic.sensitive);
        const micView = this._mic.view();
        this._micItem.label.text = micView.switchLabel;
        this._micHintItem.label.text = micView.hint ?? '';
        this._micHintItem.visible = !!micView.hint;
        this._windowItem.label.text = windowView.label;
        this._windowItem.setSensitive(windowView.sensitive);
        this._micSourceMenu.visible = view.running && this._status.mic?.available === true;

        this._renderIntervals(view);
        this._intervalMenu.setSensitive(view.intervalSensitive);
        this._sessionItem.setSensitive(view.pagesSensitive);
        this._dayItem.setSensitive(view.pagesSensitive);
    }

    _renderIntervals(view) {
        const key = JSON.stringify(view.intervals);
        if (key === this._intervalKey)
            return;
        this._intervalKey = key;
        this._intervalMenu.menu.removeAll();
        for (const item of view.intervals) {
            const mi = new PopupMenu.PopupMenuItem(item.label);
            mi.setOrnament(item.current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
            mi.connect('activate', () => this._setInterval(item.seconds));
            this._intervalMenu.menu.addMenuItem(mi);
        }
    }

    _renderMics() {
        if (this._destroyed)
            return;
        this._micSourceMenu.menu.removeAll();
        const items = this._mic.view().sources;
        if (!items.length) {
            this._micSourceMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                this._mic.mics ? 'No microphones found' : 'Microphones unavailable', {reactive: false}));
            return;
        }
        for (const item of items) {
            const mi = new PopupMenu.PopupMenuItem(item.label);
            mi.setOrnament(item.checked ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
            mi.connect('activate', () => this._chooseMic(item));
            this._micSourceMenu.menu.addMenuItem(mi);
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancelReopen();
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
