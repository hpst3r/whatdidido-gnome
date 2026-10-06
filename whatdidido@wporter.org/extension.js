import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ControlClient} from './lib/client.js';
import {buildView, errorText, micSourceItems, pageUrl, pollPeriod} from './lib/model.js';

const STATE_CLASSES = ['wdi-stopped', 'wdi-busy', 'wdi-recording', 'wdi-paused', 'wdi-recovering', 'wdi-failed', 'wdi-offline'];
const ACTIONS = [['start', 'Start'], ['pause', 'Pause'], ['resume', 'Resume'], ['stop', 'Stop']];

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
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
        this._mics = null;
        this._intervalKey = '';
        this._syncing = false;
        this._destroyed = false;

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

        this._settingsIds = [
            this._settings.connect('changed::poll-active', () => this._schedule()),
            this._settings.connect('changed::poll-idle', () => this._schedule()),
            this._settings.connect('changed::show-mic-indicator', () => this._render()),
            this._settings.connect('changed::microphone-id', () => this._renderMics()),
        ];
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._refresh();
                this._loadMics();
            } else {
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
        this._micSourceMenu = new PopupMenu.PopupSubMenuMenuItem('Microphone source');
        this.menu.addMenuItem(this._micSourceMenu);
        this._intervalMenu = new PopupMenu.PopupSubMenuMenuItem('Screenshot interval');
        this.menu.addMenuItem(this._intervalMenu);

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
            // "Not running" is the normal idle case: never logged. Anything
            // else is logged once per distinct message (no token in messages).
            this._pollError = e.notRunning ? null : errorText(e);
            if (this._pollError && this._pollError !== this._lastLogged)
                console.warn(`whatdidido: status poll failed: ${e.message}`);
            this._lastLogged = this._pollError;
        }
        if (this._cancellable !== cancellable)
            return;
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

    _setMic(on) {
        this._act(c => this._client.setMicOn(on, this._settings.get_string('microphone-id'), c))
            .finally(() => this._loadMics());
    }

    _setInterval(seconds) {
        this._act(c => this._client.setInterval(seconds, c));
    }

    _chooseMic(mic) {
        this._settings.set_string('microphone-label', mic.label);
        this._settings.set_string('microphone-id', mic.id);
        // Switch a live microphone over to the new choice.
        const live = this._status?.mic;
        if (this._running && live?.on && live.source_id !== mic.id)
            this._setMic(true);
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
            this._mics = null;
            this._renderMics();
            return;
        }
        try {
            this._mics = (await this._client.microphones(this._actionCancellable)).microphones ?? [];
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
            this._mics = null;
        }
        this._renderMics();
    }

    _render() {
        if (this._destroyed)
            return;
        const view = buildView(this._status, {
            running: this._running,
            showMic: this._settings.get_boolean('show-mic-indicator'),
            pollError: this._pollError,
        });

        this._stateIcon.icon_name = view.panel.icon;
        for (const c of STATE_CLASSES)
            this._stateIcon.remove_style_class_name(c);
        this._stateIcon.add_style_class_name(view.panel.styleClass);
        this._micIcon.visible = view.micIndicator;
        this.accessible_name = `whatdidido: ${view.panel.label}${view.mic.on ? ', microphone on' : ''}`;

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

        this._syncing = true;
        try {
            this._micItem.setToggleState(view.mic.on);
        } finally {
            this._syncing = false;
        }
        this._micItem.setSensitive(view.mic.sensitive);
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
        const items = micSourceItems(this._mics, this._settings.get_string('microphone-id'));
        if (!items.length) {
            this._micSourceMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                this._mics ? 'No microphones found' : 'Microphones unavailable', {reactive: false}));
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
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
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
