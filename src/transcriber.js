import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpeechServer, SpeechServerError } from './speech-server.js';
import { inOtherAlphabet, removeFillers } from './text.js';

// The host gives up on an action after 30 s, so the helper must finish before that.
export const DEFAULT_TIMEOUT_MS = 27_000;
export const DEFAULT_KEEP_LOADED_MS = 15 * 60 * 1000;
// A Whisper re-check is only started when at least this much of the time limit is left.
const MIN_RECHECK_MS = 4000;
// Base64 of this much audio still fits the host's 10 MB request limit.
export const MAX_AUDIO_BYTES = 7 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_REASON = 200;

const AUDIO_TYPES = new Map([
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
]);

// A transcription that failed; the message is short and never holds audio or transcript text.
export class TranscribeError extends Error {}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

// File extension for a MIME type such as "audio/webm;codecs=opus", or null when it is not audio we accept.
export function audioExtension(mimeType) {
  const base = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  return AUDIO_TYPES.get(base) ?? null;
}

// Runs scripts/transcribe.py for one recording at a time. The audio is written to a private temporary
// directory that is removed afterwards, and the helper is killed when it runs too long.
// With `keepLoadedMs` the Parakeet model stays loaded between recordings and is unloaded after that long idle.
// With `expectedLanguage` set to a language code, a result in another alphabet is transcribed again by Whisper set to that language.
export class Transcriber {
  #options;
  #server = null;
  #busy = false;
  #retired = false;

  constructor({
    python,
    script,
    modelsDir,
    engine = 'parakeet',
    device = 'auto',
    threads = 4,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    keepLoadedMs = DEFAULT_KEEP_LOADED_MS,
    expectedLanguage = 'auto',
    whisper = null,
    fillers = true,
  }) {
    this.#options = { python, script, modelsDir, engine, device, threads, timeoutMs, expectedLanguage, whisper, fillers };
    if (keepLoadedMs > 0 && engine === 'parakeet') {
      const args = [script, '--serve', '--engine', engine, '--device', device, '--threads', String(threads)];
      if (modelsDir) args.push('--models-dir', modelsDir);
      this.#server = new SpeechServer({ python, args, idleMs: keepLoadedMs });
    }
  }

  // Whether the model is loaded right now.
  get loaded() {
    return this.#server?.running ?? false;
  }

  // Starts loading the model ahead of a recording, when it is kept loaded.
  warmup() {
    if (!this.#retired && !this.#busy) this.#server?.warmup();
  }

  // Unloads the model.
  stop() {
    this.#server?.stop();
  }

  // Unloads the model once the recording in progress, if any, is done.
  retire() {
    this.#retired = true;
    if (!this.#busy) this.stop();
  }

  // Resolves with { text, seconds, rechecked }; rejects with a TranscribeError.
  async transcribe(audio, mimeType) {
    const extension = audioExtension(mimeType);
    if (!extension) throw new TranscribeError('unsupported audio type');
    if (!audio?.length) throw new TranscribeError('the recording is empty');
    if (audio.length > MAX_AUDIO_BYTES) throw new TranscribeError('the recording is too long');
    if (this.#busy) throw new TranscribeError('another recording is being transcribed, try again in a moment');
    this.#busy = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-voice-'));
    try {
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, `audio.${extension}`);
      fs.writeFileSync(file, audio, { mode: 0o600 });
      return await this.#transcribeFile(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      this.#busy = false;
      if (this.#retired) this.stop();
    }
  }

  async #transcribeFile(file) {
    const { python, script, modelsDir, engine, device, threads, timeoutMs, expectedLanguage, whisper, fillers } = this.#options;
    const deadline = Date.now() + timeoutMs;
    let result;
    if (this.#server) {
      try {
        result = await this.#server.transcribe(file, timeoutMs);
      } catch (err) {
        throw new TranscribeError(err instanceof SpeechServerError ? err.message : 'transcription failed');
      }
    } else {
      const args = [script, file, '--engine', engine, '--device', device, '--threads', String(threads)];
      if (modelsDir) args.push('--models-dir', modelsDir);
      result = await this.#run(python, args, timeoutMs);
    }
    let rechecked = false;
    if (expectedLanguage !== 'auto' && whisper && inOtherAlphabet(result.text, expectedLanguage) && deadline - Date.now() >= MIN_RECHECK_MS) {
      const args = [script, file, '--engine', 'whisper', '--language', expectedLanguage, '--model', whisper.model ?? 'small', '--device', device, '--threads', String(threads)];
      if (whisper.modelsDir) args.push('--models-dir', whisper.modelsDir);
      try {
        const second = await this.#run(whisper.python, args, deadline - Date.now());
        if (second.text) {
          result = second;
          rechecked = true;
        }
      } catch {
        // The first result is still better than none.
      }
    }
    const text = fillers ? removeFillers(result.text) : result.text;
    return { text, seconds: result.seconds, rechecked };
  }

  #run(python, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      const settle = (done, value) => {
        clearTimeout(timer);
        done(value);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk;
      });
      child.on('error', (err) => settle(reject, new TranscribeError(`could not start the transcriber: ${err.code ?? 'error'}`)));
      child.on('close', (code, signal) => {
        if (timedOut) return settle(reject, new TranscribeError('transcription took too long, try a shorter recording'));
        if (code !== 0) {
          const reason = oneLine(stderr.split('\n').filter((line) => line.startsWith('transcribe:')).at(-1) ?? '') || 'no message';
          return settle(reject, new TranscribeError(`transcriber ${signal ? `killed by ${signal}` : `exited with ${code}`}: ${reason}`));
        }
        try {
          return settle(resolve, parseResult(stdout));
        } catch (err) {
          return settle(reject, err);
        }
      });
    });
  }
}

// The helper prints one JSON line: { text, language, seconds }.
function parseResult(stdout) {
  const line = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1);
  let result;
  try {
    result = JSON.parse(line ?? '');
  } catch {
    throw new TranscribeError('the transcriber printed no result');
  }
  if (typeof result?.text !== 'string') throw new TranscribeError('the transcriber printed no text');
  return { text: result.text.trim(), seconds: Number(result.seconds) || 0 };
}
