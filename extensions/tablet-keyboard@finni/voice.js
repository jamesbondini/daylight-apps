// Voice typing through the Daylight Apps "Voice Typing" helper.
//
// The helper (installed by apps/voice-typing) records from the microphone
// until its stdin closes, then prints the transcription from whisper.cpp's
// Whisper or Parakeet engine. The keyboard commits that text itself, so no
// virtual input device is needed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'daylight-apps', 'voice-typing']);
const HELPER = GLib.build_filenamev([DIR, 'dictate']);

// Keep in sync with model_file in apps/voice-typing/dictate
const MODELS = {
    whisper: {name: 'Whisper', file: 'ggml-base.en.bin', size: '142 MB'},
    parakeet: {name: 'Parakeet', file: 'ggml-parakeet-tdt-0.6b-v3-q4_k.bin', size: '416 MB'},
};

function modelPresent(engine) {
    const path = GLib.build_filenamev([DIR, MODELS[engine].file]);
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

// Model downloads outlive the keyboard, which the shell rebuilds when touch
// mode or the monitor changes, and the extension, which the lock screen
// disables (the module stays loaded).
const downloads = new Map(); // engine -> Gio.Subprocess
const downloadListeners = new Set();

function notifyDownloads() {
    for (const listener of downloadListeners)
        listener();
}

function download(engine) {
    if (downloads.has(engine))
        return;

    const {name, size} = MODELS[engine];
    let proc;
    try {
        proc = Gio.Subprocess.new([HELPER, '--download', engine],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        logError(e, 'tablet-keyboard: cannot download voice model');
        return;
    }

    downloads.set(engine, proc);
    Main.notify('Voice typing', `Downloading the ${name} model (${size})…`);
    notifyDownloads();
    proc.wait_async(null, () => {
        downloads.delete(engine);
        if (proc.get_successful() && modelPresent(engine))
            Main.notify('Voice typing', `${name} is ready. Hold the microphone key to talk.`);
        else
            Main.notify('Voice typing', `Downloading the ${name} model failed. Tap the microphone key to retry.`);
        notifyDownloads();
    });
}

export class Dictation {
    // onChanged(): availability or state changed; onText(text): a transcription
    constructor({engine, onChanged, onText}) {
        this._engine = engine;
        this._onChanged = onChanged;
        this._onText = onText;
        this._proc = null;
        this._recording = false;
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

        this._downloadListener = () => this._onChanged();
        downloadListeners.add(this._downloadListener);
    }

    _probe() {
        return GLib.file_test(HELPER, GLib.FileTest.IS_EXECUTABLE);
    }

    // 'idle' | 'downloading' | 'recording' | 'transcribing'
    get state() {
        if (this._proc)
            return this._recording ? 'recording' : 'transcribing';
        return downloads.has(this._engine) ? 'downloading' : 'idle';
    }

    // Switching to an engine without its model fetches it straight away
    setEngine(engine) {
        if (!(engine in MODELS) || engine === this._engine)
            return;
        this.cancel();
        this._engine = engine;
        if (this.available && !modelPresent(engine))
            download(engine);
        this._onChanged();
    }

    start() {
        if (this.state !== 'idle' || !this.available)
            return;

        if (!modelPresent(this._engine)) {
            download(this._engine);
            return;
        }

        let proc;
        try {
            proc = Gio.Subprocess.new([HELPER, this._engine],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'tablet-keyboard: cannot start voice typing');
            return;
        }

        this._proc = proc;
        this._recording = true;
        this._onChanged();

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
                    this._onChanged();

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
        this._recording = false;
        this._onChanged();
    }

    cancel() {
        if (!this._proc)
            return;

        const proc = this._proc;
        this._proc = null;
        proc.send_signal(15);
        this._onChanged();
    }

    destroy() {
        downloadListeners.delete(this._downloadListener);
        this._onChanged = () => {};
        this._onText = () => {};
        this.cancel();
        this._monitor.cancel();
    }
}
