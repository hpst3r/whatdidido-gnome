import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {formatExcludedApps, parseExcludedApps} from './lib/window_model.js';

export default class WhatdididoPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const polling = new Adw.PreferencesGroup({
            title: 'Polling',
            description: 'The status is also refreshed whenever the menu opens.',
        });
        page.add(polling);
        const active = new Adw.SpinRow({
            title: 'While active (seconds)',
            subtitle: 'Menu open, or starting, recording, reconnecting or stopping',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
        });
        settings.bind('poll-active', active, 'value', Gio.SettingsBindFlags.DEFAULT);
        polling.add(active);
        const idle = new Adw.SpinRow({
            title: 'While idle (seconds)',
            subtitle: 'Stopped, paused, failed or not running',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 3600, step_increment: 5}),
        });
        settings.bind('poll-idle', idle, 'value', Gio.SettingsBindFlags.DEFAULT);
        polling.add(idle);

        const mic = new Adw.PreferencesGroup({
            title: 'Microphone',
            description: 'Choose the microphone from the top-bar menu → Microphone source.',
        });
        page.add(mic);
        const preferred = new Adw.ActionRow({title: 'Preferred microphone'});
        const reset = new Gtk.Button({label: 'Use first available', valign: Gtk.Align.CENTER});
        reset.connect('clicked', () => {
            settings.set_string('microphone-id', '');
            settings.set_string('microphone-label', '');
        });
        preferred.add_suffix(reset);
        mic.add(preferred);
        const sync = () => {
            const id = settings.get_string('microphone-id');
            preferred.subtitle = id ? settings.get_string('microphone-label') || id : 'First available (none chosen)';
            reset.sensitive = !!id;
        };
        const ids = [
            settings.connect('changed::microphone-id', sync),
            settings.connect('changed::microphone-label', sync),
        ];
        sync();

        const activity = new Adw.PreferencesGroup({
            title: 'Active window',
            description: 'Only sent to the local work session, only while it is recording ' +
                '(never while paused), and only if the server offers it (--window-activity).',
        });
        page.add(activity);
        const report = new Adw.SwitchRow({
            title: 'Record active window',
            subtitle: 'App, WM class and window title of the focused window, for time accounting',
        });
        settings.bind('report-active-window', report, 'active', Gio.SettingsBindFlags.DEFAULT);
        activity.add(report);
        const excluded = new Adw.EntryRow({
            title: 'Apps whose titles are never sent (comma-separated app ids)',
            show_apply_button: true,
        });
        excluded.connect('apply', () =>
            settings.set_strv('window-title-excluded-apps', parseExcludedApps(excluded.text)));
        activity.add(excluded);
        const syncExcluded = () => {
            excluded.text = formatExcludedApps(settings.get_strv('window-title-excluded-apps'));
        };
        ids.push(settings.connect('changed::window-title-excluded-apps', syncExcluded));
        syncExcluded();

        const reminders = new Adw.PreferencesGroup({
            title: 'Reminders',
            description: 'Counted from when the extension first saw the pause.',
        });
        page.add(reminders);
        const pauseReminder = new Adw.SpinRow({
            title: 'Remind while paused (minutes)',
            subtitle: 'A notification after this long paused, then again every this many minutes; 0 = off',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 240, step_increment: 1, page_increment: 10}),
        });
        settings.bind('pause-reminder-minutes', pauseReminder, 'value', Gio.SettingsBindFlags.DEFAULT);
        reminders.add(pauseReminder);

        window.connect('close-request', () => {
            for (const id of ids)
                settings.disconnect(id);
            return false;
        });

        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(bar);
        const showMic = new Adw.SwitchRow({
            title: 'Show microphone indicator',
            subtitle: 'A microphone icon next to the state icon while the microphone is on',
        });
        settings.bind('show-mic-indicator', showMic, 'active', Gio.SettingsBindFlags.DEFAULT);
        bar.add(showMic);

        window.add(page);
    }
}
