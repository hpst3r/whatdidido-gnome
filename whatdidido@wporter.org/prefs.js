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
            description: 'Choose the microphone from the top-bar menu → Microphone source. ' +
                'Only that microphone is ever turned on; if it is not connected the microphone stays off.',
        });
        page.add(mic);
        // Forget writes one key at a time: the stable id last, so the extension's
        // migration never re-adopts it from a legacy id not yet cleared.
        const MIC_KEYS = ['microphone-id', 'microphone-label', 'microphone-stable-id'];
        const preferred = new Adw.ActionRow({title: 'Chosen microphone'});
        const forget = new Gtk.Button({label: 'Forget microphone', valign: Gtk.Align.CENTER});
        forget.connect('clicked', () => {
            for (const key of MIC_KEYS)
                settings.set_string(key, '');
        });
        preferred.add_suffix(forget);
        mic.add(preferred);
        const sync = () => {
            const chosen = !!(settings.get_string('microphone-stable-id') || settings.get_string('microphone-id'));
            const label = settings.get_string('microphone-label');
            preferred.subtitle = chosen ? label || 'Unnamed microphone' : 'None chosen';
            forget.sensitive = MIC_KEYS.some(key => settings.get_string(key));
        };
        const ids = MIC_KEYS.map(key => settings.connect(`changed::${key}`, sync));
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
            description: 'Counted from when the extension first saw the pause, or the microphone on without speech.',
        });
        page.add(reminders);
        const pauseReminder = new Adw.SpinRow({
            title: 'Remind while paused (minutes)',
            subtitle: 'A notification after this long paused, then again every this many minutes; 0 = off',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 240, step_increment: 1, page_increment: 10}),
        });
        settings.bind('pause-reminder-minutes', pauseReminder, 'value', Gio.SettingsBindFlags.DEFAULT);
        reminders.add(pauseReminder);
        const micReminder = new Adw.SpinRow({
            title: 'Remind to check the microphone after (minutes)',
            subtitle: 'A notification when the microphone is on but no speech was transcribed for this long, ' +
                'then again every this many minutes; 0 = never',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 240, step_increment: 1, page_increment: 10}),
        });
        settings.bind('mic-reminder-minutes', micReminder, 'value', Gio.SettingsBindFlags.DEFAULT);
        reminders.add(micReminder);

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
