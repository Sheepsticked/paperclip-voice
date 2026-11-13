import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audioExtension, MAX_AUDIO_BYTES, Transcriber, TranscribeError } from '../src/transcriber.js';

// A stand-in for transcribe.py: its behaviour is picked by the first byte of the audio file.
const FAKE = `
import json, os, sys, time
audio = sys.argv[1]
data = open(audio, 'rb').read()
open(os.environ['FAKE_LOG'], 'w').write(json.dumps({'args': sys.argv[2:], 'audio': audio, 'mode': oct(os.stat(os.path.dirname(audio)).st_mode & 0o777)}))
kind = data[:1]
if kind == b'f':
    print('transcribe: RuntimeError: model missing', file=sys.stderr); sys.exit(1)
if kind == b's':
    time.sleep(5)
if kind == b'g':
    print('not json'); sys.exit(0)
print('noise from a library')
print(json.dumps({'text': '  hello world  ', 'language': None, 'seconds': 0.1}))
`;

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-test-'));
  const script = path.join(dir, 'fake.py');
  fs.writeFileSync(script, FAKE);
  const log = path.join(dir, 'log.json');
  process.env.FAKE_LOG = log;
  const transcriber = new Transcriber({ python: 'python3', script, modelsDir: '/models', keepLoadedMs: 0, fillers: false, ...options });
  return { transcriber, log: () => JSON.parse(fs.readFileSync(log, 'utf8')), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('maps browser MIME types to file extensions', () => {
  assert.equal(audioExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(audioExtension('Audio/OGG; codecs=opus'), 'ogg');
  assert.equal(audioExtension('audio/mp4'), 'm4a');
  assert.equal(audioExtension('video/webm'), null);
  assert.equal(audioExtension(undefined), null);
});

test('returns the trimmed text and removes the audio afterwards', async (t) => {
  const { transcriber, log, cleanup } = setup();
  t.after(cleanup);
  const result = await transcriber.transcribe(Buffer.from('ok audio'), 'audio/webm;codecs=opus');
  assert.deepEqual(result, { text: 'hello world', seconds: 0.1, rechecked: false });
  const call = log();
  assert.match(call.audio, /audio\.webm$/);
  assert.equal(call.mode, '0o700');
  assert.deepEqual(call.args, ['--engine', 'parakeet', '--device', 'auto', '--threads', '4', '--models-dir', '/models']);
  assert.equal(fs.existsSync(path.dirname(call.audio)), false);
});

test('reports the helper failure reason without its other output', async (t) => {
  const { transcriber, cleanup } = setup();
  t.after(cleanup);
  await assert.rejects(transcriber.transcribe(Buffer.from('fail'), 'audio/ogg'), (err) => {
    assert.ok(err instanceof TranscribeError);
    assert.equal(err.message, 'transcriber exited with 1: transcribe: RuntimeError: model missing');
    return true;
  });
});

test('rejects output that is not a result line', async (t) => {
  const { transcriber, cleanup } = setup();
  t.after(cleanup);
  await assert.rejects(transcriber.transcribe(Buffer.from('garbage'), 'audio/ogg'), /printed no result/);
});

test('kills a helper that runs too long and cleans up', async (t) => {
  const { transcriber, log, cleanup } = setup({ timeoutMs: 500 });
  t.after(cleanup);
  await assert.rejects(transcriber.transcribe(Buffer.from('slow'), 'audio/ogg'), /took too long/);
  assert.equal(fs.existsSync(path.dirname(log().audio)), false);
});

test('runs one transcription at a time', async (t) => {
  const { transcriber, cleanup } = setup({ timeoutMs: 2000 });
  t.after(cleanup);
  const first = transcriber.transcribe(Buffer.from('slow'), 'audio/ogg').catch(() => {});
  await assert.rejects(transcriber.transcribe(Buffer.from('ok'), 'audio/ogg'), /another recording/);
  await first;
  assert.equal((await transcriber.transcribe(Buffer.from('ok'), 'audio/ogg')).text, 'hello world');
});

test('refuses empty, oversized and non-audio input before starting the helper', async () => {
  const transcriber = new Transcriber({ python: '/nonexistent/python', script: 'x.py' });
  await assert.rejects(transcriber.transcribe(Buffer.alloc(0), 'audio/ogg'), /empty/);
  await assert.rejects(transcriber.transcribe(Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/ogg'), /too long/);
  await assert.rejects(transcriber.transcribe(Buffer.from('x'), 'text/plain'), /unsupported/);
});

test('reports a missing Python without a stack trace', async () => {
  const transcriber = new Transcriber({ python: '/nonexistent/python', script: 'x.py' });
  await assert.rejects(transcriber.transcribe(Buffer.from('x'), 'audio/ogg'), { message: 'could not start the transcriber: ENOENT' });
});

// A stand-in for `transcribe.py --serve` and for the Whisper re-check. It logs every start and request.
const SERVE_FAKE = `
import json, os, sys, time
log = open(os.environ['FAKE_LOG'], 'a')
args = sys.argv[1:]
if '--serve' not in args:
    log.write(json.dumps({'oneshot': args[1:]}) + '\\n'); log.flush()
    print(json.dumps({'text': 'Testing, uh, one two.', 'seconds': 0.3}))
    sys.exit(0)
log.write(json.dumps({'start': os.getpid(), 'args': args}) + '\\n'); log.flush()
if os.environ.get('FAKE_NO_READY'):
    time.sleep(30)
print(json.dumps({'ready': True, 'device': 'cuda'}), flush=True)
for line in sys.stdin:
    audio = json.loads(line)['audio']
    data = open(audio, 'rb').read()
    log.write(json.dumps({'request': os.getpid()}) + '\\n'); log.flush()
    if data[:1] == b'f':
        print(json.dumps({'error': 'RuntimeError: bad audio'}), flush=True); continue
    if data[:1] == b's':
        time.sleep(30)
    if data[:1] == b'r':
        print(json.dumps({'text': 'Тестинг', 'seconds': 0.1}), flush=True); continue
    print(json.dumps({'text': ' Um, hello, uh, world. ', 'seconds': 0.1}), flush=True)
`;

function setupServer(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-serve-'));
  const script = path.join(dir, 'fake.py');
  fs.writeFileSync(script, SERVE_FAKE);
  const log = path.join(dir, 'log.jsonl');
  process.env.FAKE_LOG = log;
  const transcriber = new Transcriber({ python: 'python3', script, modelsDir: '/models', keepLoadedMs: 60_000, ...options });
  t.after(() => {
    transcriber.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { transcriber, entries };
}

test('keeps one helper loaded across recordings and removes fillers', async (t) => {
  const { transcriber, entries } = setupServer(t);
  assert.equal(transcriber.loaded, false);
  const first = await transcriber.transcribe(Buffer.from('ok'), 'audio/webm');
  const second = await transcriber.transcribe(Buffer.from('ok'), 'audio/webm');
  assert.equal(first.text, 'Hello world.');
  assert.equal(second.text, 'Hello world.');
  assert.equal(transcriber.loaded, true);
  const log = entries();
  assert.equal(log.filter((entry) => entry.start).length, 1);
  assert.equal(log.filter((entry) => entry.request).length, 2);
  assert.ok(log[0].args.includes('--serve'));
});

test('a retired transcriber finishes its recording, then unloads', async (t) => {
  const { transcriber } = setupServer(t);
  await transcriber.transcribe(Buffer.from('ok'), 'audio/webm');
  const running = transcriber.transcribe(Buffer.from('ok'), 'audio/webm');
  transcriber.retire();
  assert.equal((await running).text, 'Hello world.');
  assert.equal(transcriber.loaded, false);
});

test('unloads the model after the idle time and loads it again when needed', async (t) => {
  const { transcriber, entries } = setupServer(t, { keepLoadedMs: 300 });
  await transcriber.transcribe(Buffer.from('ok'), 'audio/webm');
  assert.equal(transcriber.loaded, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(transcriber.loaded, false);
  await transcriber.transcribe(Buffer.from('ok'), 'audio/webm');
  assert.equal(entries().filter((entry) => entry.start).length, 2);
});

test('a warm-up loads the model once, and the next recording uses it', async (t) => {
  const { transcriber, entries } = setupServer(t);
  transcriber.warmup();
  transcriber.warmup();
  assert.equal(transcriber.loaded, true);
  assert.equal((await transcriber.transcribe(Buffer.from('ok'), 'audio/webm')).text, 'Hello world.');
  assert.equal(entries().filter((entry) => entry.start).length, 1);
});

test('a warm-up without a recording unloads after the idle time', async (t) => {
  const { transcriber } = setupServer(t, { keepLoadedMs: 300 });
  transcriber.warmup();
  assert.equal(transcriber.loaded, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(transcriber.loaded, false);
});

test('a warm-up that cannot start the helper leaves the error to the recording', async (t) => {
  const { transcriber } = setupServer(t, { python: '/nonexistent/python' });
  transcriber.warmup();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(transcriber.loaded, false);
  await assert.rejects(transcriber.transcribe(Buffer.from('ok'), 'audio/webm'), /could not start the transcriber: ENOENT/);
});

test('a warm-up does nothing when the model is not kept loaded', async (t) => {
  const { transcriber, entries } = setupServer(t, { keepLoadedMs: 0 });
  transcriber.warmup();
  assert.equal(transcriber.loaded, false);
  assert.equal(entries().length, 0);
});

test('a failed recording keeps the model loaded', async (t) => {
  const { transcriber, entries } = setupServer(t);
  await assert.rejects(transcriber.transcribe(Buffer.from('fail'), 'audio/webm'), { message: 'RuntimeError: bad audio' });
  assert.equal((await transcriber.transcribe(Buffer.from('ok'), 'audio/webm')).text, 'Hello world.');
  assert.equal(entries().filter((entry) => entry.start).length, 1);
});

test('a stuck helper is stopped and the next recording starts a fresh one', async (t) => {
  const { transcriber, entries } = setupServer(t, { timeoutMs: 1500 });
  await assert.rejects(transcriber.transcribe(Buffer.from('slow'), 'audio/webm'), /took too long/);
  assert.equal(transcriber.loaded, false);
  assert.equal((await transcriber.transcribe(Buffer.from('ok'), 'audio/webm')).text, 'Hello world.');
  assert.equal(entries().filter((entry) => entry.start).length, 2);
});

test('a helper that never finishes loading fails within the time limit', async (t) => {
  process.env.FAKE_NO_READY = '1';
  t.after(() => delete process.env.FAKE_NO_READY);
  const { transcriber } = setupServer(t, { timeoutMs: 800 });
  const started = Date.now();
  await assert.rejects(transcriber.transcribe(Buffer.from('ok'), 'audio/webm'), /loading the model took too long/);
  assert.ok(Date.now() - started < 3000);
  assert.equal(transcriber.loaded, false);
});

test('a result in another alphabet is transcribed again by Whisper in the set language', async (t) => {
  const { transcriber, entries } = setupServer(t, { expectedLanguage: 'en', whisper: { python: 'python3', modelsDir: '/whisper', model: 'small' } });
  const result = await transcriber.transcribe(Buffer.from('r-cyrillic'), 'audio/webm');
  assert.deepEqual(result, { text: 'Testing one two.', seconds: 0.3, rechecked: true });
  const oneshot = entries().find((entry) => entry.oneshot).oneshot;
  assert.deepEqual(oneshot.slice(0, 6), ['--engine', 'whisper', '--language', 'en', '--model', 'small']);
  assert.ok(oneshot.includes('/whisper'));
});

test('keeps the result when no language is set or Whisper is missing', async (t) => {
  const any = setupServer(t, { whisper: { python: 'python3' } });
  assert.equal((await any.transcriber.transcribe(Buffer.from('r-cyrillic'), 'audio/webm')).text, 'Тестинг');
  const none = setupServer(t, { expectedLanguage: 'en', whisper: null });
  assert.equal((await none.transcriber.transcribe(Buffer.from('r-cyrillic'), 'audio/webm')).rechecked, false);
});
