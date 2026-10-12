// The speech models file the Daylight Apps "Voice Typing" app installs next to
// its helper (apps/voice-typing/models). Shared by voice.js (in the shell) and
// prefs.js (in the preferences process), so it imports nothing from the shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const VOICE_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'daylight-apps', 'voice-typing']);

// [{id, name, description, bytes, size, file}] in the file's order; empty
// when Voice Typing isn't installed or predates the file
export function readModels() {
    try {
        const [, contents] = GLib.file_get_contents(GLib.build_filenamev([VOICE_DIR, 'models']));
        return new TextDecoder().decode(contents).split('\n')
            .filter(line => line.trim() && !line.startsWith('#'))
            .map(line => {
                const [id, , , bytes, , name, description, url] = line.split('|');
                return {
                    id, name, description, bytes: Number(bytes),
                    size: `${Math.round(Number(bytes) / 1e6)} MB`,
                    file: url?.split('/').pop(),
                };
            })
            .filter(m => m.id && m.file);
    } catch {
        return [];
    }
}

// Size of a file in VOICE_DIR, or -1 when it doesn't exist
export function voiceFileSize(name) {
    try {
        return Gio.File.new_for_path(GLib.build_filenamev([VOICE_DIR, name]))
            .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    } catch {
        return -1;
    }
}
