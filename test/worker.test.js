import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.js';
import plugin, { DEFAULT_NOTE, noteFor, resolveOptions } from '../src/worker.js';

// A fake Python that ignores the script and prints a fixed transcript, or fails when asked to.
function fakePython(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'python');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function harnessWith(config) {
  const harness = createTestHarness({ manifest, config });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

test('the transcribe action returns the text and logs no transcript', async (t) => {
  const python = fakePython(t, `echo '{"text": " secret words ", "seconds": 0.2}'`);
  const harness = await harnessWith({ python, keepLoadedMinutes: 0, voiceNote: false });
  const result = await harness.performAction('transcribe', { audio: { value: Buffer.from('audio').toString('base64') }, mimeType: 'audio/webm;codecs=opus' });
  assert.deepEqual(result, { text: 'secret words' });
  assert.doesNotMatch(JSON.stringify(harness.logs), /secret/);
});

// Failures are returned rather than thrown: the host logs the request body of failed actions.
test('the transcribe action returns a short failure reason', async (t) => {
  const python = fakePython(t, `echo 'transcribe: RuntimeError: CUDA out of memory' >&2; exit 1`);
  const harness = await harnessWith({ python, keepLoadedMinutes: 0 });
  const result = await harness.performAction('transcribe', { audio: { value: Buffer.from('audio').toString('base64') }, mimeType: 'audio/ogg' });
  assert.deepEqual(result, { error: 'transcriber exited with 1: transcribe: RuntimeError: CUDA out of memory' });
});

test('the transcribe action adds the voice note unless it is turned off', async (t) => {
  const python = fakePython(t, `echo '{"text": "words", "seconds": 0.2}'`);
  const audio = { audio: { value: Buffer.from('audio').toString('base64') }, mimeType: 'audio/ogg' };
  const plain = await harnessWith({ python, keepLoadedMinutes: 0 });
  assert.deepEqual(await plain.performAction('transcribe', audio), { text: 'words', note: DEFAULT_NOTE });
  const custom = await harnessWith({ python, keepLoadedMinutes: 0, voiceNoteText: '  By voice,\n may be off. ' });
  assert.deepEqual(await custom.performAction('transcribe', audio), { text: 'words', note: 'By voice, may be off.' });
});

test('the voice note setting', () => {
  assert.equal(noteFor({}), DEFAULT_NOTE);
  assert.equal(noteFor({ voiceNoteText: ' ' }), DEFAULT_NOTE);
  assert.equal(noteFor({ voiceNote: false, voiceNoteText: 'x' }), null);
});

test('the warmup action answers at once', async () => {
  const harness = await harnessWith({ python: '/nonexistent/python', keepLoadedMinutes: 0 });
  assert.deepEqual(await harness.performAction('warmup', {}), {});
});

test('the transcribe action refuses missing parameters', async () => {
  const harness = await harnessWith({});
  assert.deepEqual(await harness.performAction('transcribe', { mimeType: 'audio/ogg' }), { error: 'audio and mimeType are required' });
  assert.deepEqual(await harness.performAction('transcribe', { audioBase64: 'QUJD', mimeType: 'audio/ogg' }), { error: 'audio and mimeType are required' });
});

test('empty settings use the environments that the install script makes', () => {
  const options = resolveOptions({ python: '  ', device: 'gpu' }, () => false);
  assert.match(options.python, /paperclip-voice\/parakeet\/bin\/python$/);
  assert.match(options.modelsDir, /paperclip-voice\/parakeet\/models$/);
  const installed = resolveOptions({}, () => true);
  assert.match(installed.whisper.python, /paperclip-voice\/whisper\/bin\/python$/);
  assert.match(installed.whisper.modelsDir, /paperclip-voice\/whisper\/models$/);
  assert.equal(options.device, 'auto');
  assert.match(options.script, /scripts\/transcribe\.py$/);
  assert.equal(resolveOptions({ python: '/opt/py', device: 'cpu' }).python, '/opt/py');
  assert.equal(options.keepLoadedMs, 15 * 60_000);
  assert.equal(options.expectedLanguage, 'auto');
  assert.equal(resolveOptions({ expectedLanguage: 'de' }).expectedLanguage, 'de');
  assert.equal(resolveOptions({ expectedLanguage: 'xx' }).expectedLanguage, 'auto');
  assert.equal(options.fillers, true);
});

test('settings for keeping the model loaded, language, fillers and Whisper', () => {
  const options = resolveOptions({ keepLoadedMinutes: 0, expectedLanguage: 'en', removeFillers: false, whisperPython: '/w/py' }, () => true);
  assert.equal(options.keepLoadedMs, 0);
  assert.equal(options.expectedLanguage, 'en');
  assert.equal(options.fillers, false);
  assert.equal(options.whisper.python, '/w/py');
  assert.equal(resolveOptions({ keepLoadedMinutes: -3 }).keepLoadedMs, 15 * 60_000);
  assert.equal(resolveOptions({ keepLoadedMinutes: 99_999 }).keepLoadedMs, 24 * 60 * 60_000);
  assert.equal(resolveOptions({}, () => false).whisper, null);
});
