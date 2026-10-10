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

// The helper records 16 kHz mono 16-bit WAV to
// $XDG_RUNTIME_DIR/dictate-<its pid>/speech.wav
const WAV_HEADER = 44;
const LEVEL_BYTES = 3200; // the last 100 ms
const LEVEL_FLOOR_DB = -55;
const LEVEL_CEIL_DB = -15;

// How long the mic key shows that voice typing failed
const ERROR_MS = 2000;

function modelPresent(engine) {
    // Non-empty, like the helper's own check
    const path = GLib.build_filenamev([DIR, MODELS[engine].file]);
    try {
        return Gio.File.new_for_path(path).query_info('standard::size',
            Gio.FileQueryInfoFlags.NONE, null).get_size() > 0;
    } catch {
        return false;
    }
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
        this._errorId = 0;
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

    get engineName() {
        return MODELS[this._engine].name;
    }

    // 'idle' | 'downloading' | 'recording' | 'transcribing' | 'error'
    get state() {
        if (this._proc)
            return this._recording ? 'recording' : 'transcribing';
        if (downloads.has(this._engine))
            return 'downloading';
        return this._errorId ? 'error' : 'idle';
    }

    // Shows the failure briefly, then goes back to idle
    _fail() {
        this._clearError();
        this._errorId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ERROR_MS, () => {
            this._errorId = 0;
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
        this._onChanged();
    }

    _clearError() {
        if (this._errorId) {
            GLib.source_remove(this._errorId);
            this._errorId = 0;
        }
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

    // Retrying straight after a failure is fine
    start() {
        if (!['idle', 'error'].includes(this.state) || !this.available)
            return;
        this._clearError();

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
            this._fail();
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
                    if (!proc.get_successful()) {
                        const status = proc.get_if_exited()
                            ? `exit status ${proc.get_exit_status()}`
                            : `signal ${proc.get_term_sig()}`;
                        console.warn(`tablet-keyboard: voice typing failed (${status})`);
                        this._fail();
                        return;
                    }
                    this._onChanged();

                    const bytes = o.steal_as_bytes().toArray();
                    const text = new TextDecoder().decode(bytes).trim();
                    if (text)
                        this._onText(text);
                });
            });
    }

    // Loudness of the last moment of the recording, 0 to 1, read from the
    // file the helper is writing; null when it can't be read
    level() {
        if (this.state !== 'recording')
            return null;
        const path = GLib.build_filenamev([GLib.get_user_runtime_dir(),
            `dictate-${this._proc.get_identifier()}`, 'speech.wav']);
        try {
            const file = Gio.File.new_for_path(path);
            const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
            if (size <= WAV_HEADER)
                return 0;
            const offset = WAV_HEADER + Math.max(0, Math.floor((size - WAV_HEADER - LEVEL_BYTES) / 2) * 2);
            const stream = file.read(null);
            stream.seek(offset, GLib.SeekType.SET, null);
            const bytes = stream.read_bytes(LEVEL_BYTES, null).toArray();
            stream.close(null);

            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let sum = 0;
            const count = Math.floor(bytes.byteLength / 2);
            for (let i = 0; i < count; i++)
                sum += view.getInt16(i * 2, true) ** 2;
            const rms = Math.sqrt(sum / Math.max(1, count)) / 32768;
            const db = 20 * Math.log10(Math.max(rms, 1e-6));
            return Math.clamp((db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB), 0, 1);
        } catch {
            return null;
        }
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
        this._clearError();
        this._monitor.cancel();
    }
}
