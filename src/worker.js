import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { LANGUAGES } from './text.js';
import { Transcriber, TranscribeError } from './transcriber.js';

// The bundle lives in dist/, the helper script in scripts/.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'transcribe.py');
const DATA = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const DEVICES = new Set(['auto', 'cuda', 'cpu']);
const DEFAULT_KEEP_LOADED_MINUTES = 15;
// One day; longer waits overflow the timer.
const MAX_KEEP_LOADED_MINUTES = 24 * 60;

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// The environments that scripts/install-models.sh makes.
const ENV = path.join(DATA, 'paperclip-voice', 'parakeet');
const WHISPER_ENV = path.join(DATA, 'paperclip-voice', 'whisper');

// Transcriber options from the plugin settings, with defaults for anything left empty.
export function resolveOptions(config = {}, exists = fs.existsSync) {
  const minutes = Number(config.keepLoadedMinutes);
  const whisperPython = text(config.whisperPython) ?? path.join(WHISPER_ENV, 'bin', 'python');
  return {
    python: text(config.python) ?? path.join(ENV, 'bin', 'python'),
    modelsDir: text(config.modelsDir) ?? path.join(ENV, 'models'),
    device: DEVICES.has(config.device) ? config.device : 'auto',
    script: SCRIPT,
    keepLoadedMs: Math.min(Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_KEEP_LOADED_MINUTES, MAX_KEEP_LOADED_MINUTES) * 60_000,
    expectedLanguage: LANGUAGES.includes(config.expectedLanguage) ? config.expectedLanguage : 'auto',
    fillers: config.removeFillers !== false,
    whisper: exists(whisperPython)
      ? { python: whisperPython, modelsDir: text(config.whisperModelsDir) ?? path.join(WHISPER_ENV, 'models'), model: 'small' }
      : null,
  };
}

export const DEFAULT_NOTE = 'Voice message, transcribed automatically: some words may be wrong.';

// The line put at the start of a dictated message, or null when the setting is off.
export function noteFor(config = {}) {
  if (config.voiceNote === false) return null;
  return text(config.voiceNoteText)?.replace(/\s+/g, ' ') ?? DEFAULT_NOTE;
}

let current = null; // { key, transcriber }

// One transcriber for the current settings, so the loaded model and the one-at-a-time guard are shared.
function transcriberFor(options) {
  const key = JSON.stringify(options);
  if (current?.key !== key) {
    current?.transcriber.retire();
    current = { key, transcriber: new Transcriber(options) };
  }
  return current.transcriber;
}

const plugin = definePlugin({
  async setup(ctx) {
    // Params are { audio: { value: <base64> }, mimeType }. The host redacts fields named `value` when it logs a failed
    // request body, which keeps the audio out of its logs. Expected failures come back as { error } for the same reason.
    // Called when a recording starts, so the model loads while the user speaks.
    ctx.actions.register('warmup', async () => {
      let config = {};
      try {
        config = (await ctx.config.get()) ?? {};
      } catch {
        // No saved settings: the defaults apply.
      }
      transcriberFor(resolveOptions(config)).warmup();
      return {};
    });

    ctx.actions.register('transcribe', async (params) => {
      const audioBase64 = params?.audio?.value;
      const mimeType = params?.mimeType;
      if (typeof audioBase64 !== 'string' || typeof mimeType !== 'string') return { error: 'audio and mimeType are required' };
      let config = {};
      try {
        config = (await ctx.config.get()) ?? {};
      } catch {
        // No saved settings: the defaults apply.
      }
      const started = Date.now();
      try {
        const result = await transcriberFor(resolveOptions(config)).transcribe(Buffer.from(audioBase64, 'base64'), mimeType);
        ctx.logger.info('transcribed a recording', { ms: Date.now() - started, chars: result.text.length, rechecked: result.rechecked });
        const note = noteFor(config);
        return note ? { text: result.text, note } : { text: result.text };
      } catch (err) {
        const message = err instanceof TranscribeError ? err.message : 'transcription failed';
        ctx.logger.warn('transcription failed', { reason: message });
        return { error: message };
      }
    });
  },

  async onShutdown() {
    current?.transcriber.stop();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
