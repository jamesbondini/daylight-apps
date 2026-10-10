// Voice typing through the Daylight Apps "Voice Typing" helper.
//
// The helper (installed by apps/voice-typing) records from the microphone
// until its stdin closes, then prints the whisper.cpp transcription. The
// keyboard commits that text itself, so no virtual input device is needed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const HELPER = GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'daylight-apps', 'voice-typing', 'dictate']);

export class Dictation {
    // onChanged(): availability or state changed; onText(text): a transcription
    constructor({onChanged, onText}) {
        this._onChanged = onChanged;
        this._onText = onText;
        this._proc = null;
        this.state = 'idle'; // 'idle' | 'recording' | 'transcribing'
        this.available = this._probe();

        // Follows install and removal while the shell runs
        this._monitor = Gio.File.new_for_path(HELPER)
            .monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => {
            const available = this._probe();
            if (available !== this.available) {
                this.available = available;
                if (!available)
                    this.cancel();
                this._onChanged();
            }
        });
    }

    _probe() {
        return GLib.file_test(HELPER, GLib.FileTest.IS_EXECUTABLE);
    }

    _setState(state) {
        this.state = state;
        this._onChanged();
    }

    start() {
        if (this.state !== 'idle' || !this.available)
            return;

        let proc;
        try {
            proc = Gio.Subprocess.new([HELPER],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'tablet-keyboard: cannot start voice typing');
            return;
        }

        this._proc = proc;
        this._setState('recording');

        // Collect stdout until the helper exits
        const output = Gio.MemoryOutputStream.new_resizable();
        output.splice_async(proc.get_stdout_pipe(),
            Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT, null, (o, result) => {
                try {
                    o.splice_finish(result);
                } catch (e) {
                    logError(e, 'tablet-keyboard: voice typing failed');
                }
                proc.wait_async(null, () => {
                    // A cancelled or replaced run must not type anything
                    if (this._proc !== proc)
                        return;
                    this._proc = null;
                    this._setState('idle');

                    const bytes = o.steal_as_bytes().toArray();
                    const text = proc.get_successful()
                        ? new TextDecoder().decode(bytes).trim() : '';
                    if (text)
                        this._onText(text);
                });
            });
    }

    // Stop recording and transcribe what was said
    stop() {
        if (this.state !== 'recording')
            return;

        // End of input tells the helper to stop recording
        try {
            this._proc.get_stdin_pipe().close(null);
        } catch (e) {
            logError(e, 'tablet-keyboard: cannot stop voice typing');
        }
        this._setState('transcribing');
    }

    cancel() {
        if (!this._proc)
            return;

        const proc = this._proc;
        this._proc = null;
        proc.send_signal(15);
        this._setState('idle');
    }

    destroy() {
        this._onChanged = () => {};
        this._onText = () => {};
        this.cancel();
        this._monitor.cancel();
    }
}
