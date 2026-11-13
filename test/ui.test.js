// Drives the mic buttons in headless Chromium with a fake microphone that plays a speech sample.
// PCV_REAL=1 sends the recordings to the real transcriber instead of a stub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { formatClock, isHotkey, withSpacing } from '../src/ui/dictation.js';
import { Transcriber } from '../src/transcriber.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.PCV_SAMPLE ?? toneFile();
const REAL = process.env.PCV_REAL === '1';
const STUB_TEXT = 'dictated words';

// A two-second 16 kHz tone, enough for the stubbed tests.
function toneFile() {
  const rate = 16000;
  const samples = rate * 2;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  const file = path.join(os.tmpdir(), `pcv-tone-${process.pid}.wav`);
  fs.writeFileSync(file, data);
  process.on('exit', () => fs.rmSync(file, { force: true }));
  return file;
}

function findChromium() {
  if (process.env.PCV_CHROMIUM) return process.env.PCV_CHROMIUM;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse() : [];
  for (const dir of dirs) {
    const exe = path.join(cache, dir, 'chrome-linux64', 'chrome');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>
<div id="composer">
  <div data-testid="task-chat-composer-input"><div id="ce" contenteditable="true">Hello</div></div>
  <div class="row"><button data-testid="task-chat-composer-add" class="plus-class">+</button><button id="send">send</button></div>
</div>
<textarea id="desc">ab</textarea>
<div id="late" contenteditable="true">Late</div>
<div id="stubborn" contenteditable="true">Fixed</div>
<div id="rich" contenteditable="true" style="min-height:20px"></div>
<textarea id="empty-desc"></textarea>
<div id="deaf" contenteditable="true" style="min-height:20px"></div>
<div id="backdrop" style="position:fixed;inset:0;pointer-events:none"></div>
<div role="dialog" aria-modal="true" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:300px;padding:20px;background:#eee">
  <textarea id="modal-desc" style="width:100%;height:120px">x</textarea>
</div>
<script>
  // Like an editor that re-renders its own state: it undoes the browser's change and applies it a frame later.
  const late = document.querySelector('#late');
  late.addEventListener('input', () => {
    const text = late.textContent;
    late.textContent = 'Late';
    requestAnimationFrame(() => { late.textContent = text; });
  });
  // A field that rejects every change.
  const stubborn = document.querySelector('#stubborn');
  stubborn.addEventListener('input', () => { stubborn.textContent = 'Fixed'; });
  // An editor that swallows pastes it cannot read.
  document.querySelector('#deaf').addEventListener('paste', (event) => event.preventDefault());
  // Like a rich editor: it takes pasted text itself and makes a paragraph of each line.
  const rich = document.querySelector('#rich');
  rich.addEventListener('paste', (event) => {
    event.preventDefault();
    for (const line of event.clipboardData.getData('text/plain').split('\\n')) rich.appendChild(document.createElement('p')).textContent = line;
  });
</script>
<script src="/dictation.js"></script>
</body></html>`;

const chromiumPath = findChromium();
const skip = !chromiumPath ? 'no Chromium found' : !fs.existsSync(SAMPLE) ? `no speech sample at ${SAMPLE}` : false;

test('mic buttons in a browser', { skip, timeout: 120_000 }, async (t) => {
  const bundle = await build({ entryPoints: [path.join(ROOT, 'src/ui/dictation.js')], bundle: true, format: 'iife', globalName: 'PCV', write: false });
  const server = http.createServer((req, res) => {
    if (req.url === '/dictation.js') return res.end(bundle.outputFiles[0].text);
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${SAMPLE}`],
  });
  t.after(async () => {
    await browser.close();
    server.close();
  });

  const env = process.env.PCV_ENV || os.homedir() + '/.local/share/paperclip-voice/parakeet';
  const real = REAL && new Transcriber({ python: `${env}/bin/python`, modelsDir: `${env}/models`, script: path.join(ROOT, 'scripts/transcribe.py') });
  t.after(() => real && real.stop());

  async function openPage(context, { fail = false, delayMs = 0, note = null } = {}) {
    const page = await context.newPage();
    const calls = [];
    await page.exposeFunction('pcvTranscribe', async (params) => {
      const audio = Buffer.from(params.audio.value, 'base64');
      calls.push({ bytes: audio.length, mimeType: params.mimeType, keys: Object.keys(params).sort() });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (fail === 'throw') throw new Error('worker unavailable');
      if (fail) return { error: 'transcriber exited with 1: transcribe: RuntimeError: CUDA out of memory' };
      if (real) return real.transcribe(audio, params.mimeType);
      return note ? { text: STUB_TEXT, note } : { text: STUB_TEXT };
    });
    await page.goto(url);
    await page.evaluate(() => {
      window.pcvWarmups = 0;
      window.pcvStop = window.PCV.startDictation({ transcribe: (params) => window.pcvTranscribe(params), warmup: () => { window.pcvWarmups += 1; } });
    });
    return { page, calls };
  }

  async function caretAtEnd(page, selector) {
    await page.click(selector);
    await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (node.tagName === 'TEXTAREA') return node.setSelectionRange(node.value.length, node.value.length);
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, selector);
  }

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  await t.test('puts one mic right after the + with its look', async () => {
    const { page } = await openPage(desktop);
    const mic = page.locator('[data-testid="task-chat-composer-add"] + button.pcv-mic');
    await mic.waitFor();
    assert.equal(await page.locator('.pcv-mic').count(), 1);
    assert.match(await mic.getAttribute('class'), /plus-class/);
    assert.equal(await mic.getAttribute('aria-label'), 'Dictate (Ctrl+Shift+Space)');
    await page.close();
  });

  await t.test('types the dictation at the cursor of the composer', async () => {
    const { page, calls } = await openPage(desktop);
    await caretAtEnd(page, '#ce');
    const mic = page.locator('.pcv-mic');
    await mic.click();
    await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'recording');
    assert.equal(await page.evaluate(() => window.pcvWarmups), 1);
    await page.waitForTimeout(REAL ? 11_500 : 1500);
    await mic.click();
    await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'idle', null, { timeout: 30_000 });
    const text = await page.locator('#ce').textContent();
    if (REAL) assert.match(text, /^Hello .*ask not what your country can do for you/i);
    else assert.equal(text, `Hello ${STUB_TEXT}`);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].keys, ['audio', 'mimeType']);
    assert.match(calls[0].mimeType, /^audio\/webm/);
    assert.ok(calls[0].bytes > 1000, `recording has ${calls[0].bytes} bytes`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ce');
    await page.close();
  });

  await t.test('gives other fields a floating mic and inserts in the middle', { skip: REAL && 'checks the stub text' }, async () => {
    const { page } = await openPage(desktop);
    assert.equal(await page.locator('.pcv-floating').count(), 0);
    await page.click('#desc');
    await page.evaluate(() => document.querySelector('#desc').setSelectionRange(1, 1));
    const mic = page.locator('.pcv-floating');
    await mic.waitFor();
    await mic.click();
    await page.waitForTimeout(800);
    await mic.click();
    await page.waitForFunction(() => document.querySelector('.pcv-floating')?.dataset.state === 'idle');
    assert.equal(await page.inputValue('#desc'), `a ${STUB_TEXT} b`);
    await page.mouse.click(5, 700);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.pcv-floating').count(), 0);
    await page.close();
  });

  async function dictateInto(page, selector, mic = '.pcv-floating') {
    await caretAtEnd(page, selector);
    await page.locator(mic).waitFor();
    await page.locator(mic).click();
    await page.waitForTimeout(600);
    await page.locator(mic).click();
    await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.state === 'idle', mic);
  }

  await t.test('starts an empty field with the voice note on its own line', { skip: REAL && 'checks the stub text' }, async () => {
    const note = 'Dictated by voice.';
    const { page } = await openPage(desktop, { note });
    await dictateInto(page, '#rich');
    assert.deepEqual(await page.locator('#rich p').allTextContents(), [note, STUB_TEXT]);
    await dictateInto(page, '#empty-desc');
    assert.equal(await page.inputValue('#empty-desc'), `${note}\n${STUB_TEXT}`);
    // A field that already holds text, the note included, gets only the dictation.
    await dictateInto(page, '#empty-desc');
    assert.equal(await page.inputValue('#empty-desc'), `${note}\n${STUB_TEXT} ${STUB_TEXT}`);
    await dictateInto(page, '#desc');
    assert.equal(await page.inputValue('#desc'), `ab ${STUB_TEXT}`);
    await dictateInto(page, '#deaf');
    assert.equal(await page.locator('#deaf').textContent(), `${note} ${STUB_TEXT}`);
    await page.close();
  });

  await t.test('accepts an editor that applies the text itself a frame later', { skip: REAL && 'checks the stub text' }, async () => {
    const { page } = await openPage(desktop);
    await dictateInto(page, '#late');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#late').textContent(), `Late ${STUB_TEXT}`);
    assert.equal(await page.locator('.pcv-message').count(), 0);
    await page.close();
  });

  await t.test('copies the text when the field refuses it', { skip: REAL && 'checks the stub text' }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    const { page } = await openPage(context);
    await dictateInto(page, '#stubborn');
    await page.locator('.pcv-message').waitFor();
    assert.match(await page.locator('.pcv-message').textContent(), /Could not type into this field\. The text is copied/);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), STUB_TEXT);
    assert.equal(await page.locator('#stubborn').textContent(), 'Fixed');
    await context.close();
  });

  await t.test('puts the floating mic inside a transformed modal, over the field', { skip: REAL && 'checks the stub text' }, async () => {
    const { page } = await openPage(desktop);
    await page.click('#modal-desc');
    const mic = page.locator('[role="dialog"] > .pcv-floating');
    await mic.waitFor();
    const field = await page.locator('#modal-desc').boundingBox();
    const box = await mic.boundingBox();
    assert.ok(box.x >= field.x && box.x + box.width <= field.x + field.width + 1, `mic x ${box.x} within field`);
    assert.ok(box.y >= field.y && box.y + box.height <= field.y + field.height + 1, `mic y ${box.y} within field`);
    await dictateInto(page, '#modal-desc');
    assert.equal(await page.inputValue('#modal-desc'), `x ${STUB_TEXT}`);
    await page.close();
  });

  for (const [fail, pattern] of [['error', /^Transcription failed: .*CUDA out of memory/], ['throw', /^Transcription failed: .*worker unavailable/]]) {
    await t.test(`shows an error and leaves the field alone when transcription fails (${fail})`, async () => {
      const { page } = await openPage(desktop, { fail });
      await caretAtEnd(page, '#ce');
      await page.locator('.pcv-mic').click();
      await page.waitForTimeout(600);
      await page.locator('.pcv-mic').click();
      const message = page.locator('.pcv-message');
      await message.waitFor();
      assert.match(await message.textContent(), pattern);
      assert.equal(await page.locator('#ce').textContent(), 'Hello');
      await page.close();
    });
  }

  await t.test('shows the recording time and level, then the transcribing time', { skip: REAL && 'checks the stub text' }, async () => {
    const { page } = await openPage(desktop, { delayMs: 1500 });
    await caretAtEnd(page, '#ce');
    await page.locator('.pcv-mic').click();
    const status = page.locator('.pcv-status');
    await status.waitFor();
    await page.waitForTimeout(1200);
    assert.match(await status.textContent(), /^0:01 \/ 3:00×$/);
    assert.equal(await page.locator('.pcv-status .pcv-level').count(), 1);
    const level = await page.locator('.pcv-status .pcv-level > i').evaluate((node) => parseFloat(node.style.width));
    assert.ok(level > 0, `level ${level}% moves with the sound`);
    await page.locator('.pcv-mic').click();
    await page.waitForFunction(() => document.querySelector('.pcv-status')?.textContent.startsWith('Transcribing…'));
    await page.waitForTimeout(1100);
    assert.match(await status.textContent(), /^Transcribing… 1 s$/);
    await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'idle');
    assert.equal(await page.locator('.pcv-status').count(), 0);
    assert.equal(await page.locator('#ce').textContent(), `Hello ${STUB_TEXT}`);
    await page.close();
  });

  await t.test('Ctrl+Shift+Space starts and stops dictation in the focused field', { skip: REAL && 'checks the stub text' }, async () => {
    const { page } = await openPage(desktop);
    await caretAtEnd(page, '#ce');
    await page.locator('.pcv-mic').waitFor();
    await page.keyboard.press('Control+Shift+Space');
    await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'recording');
    await page.waitForTimeout(600);
    await page.keyboard.press('Control+Shift+Space');
    await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'idle');
    assert.equal(await page.locator('#ce').textContent(), `Hello ${STUB_TEXT}`);

    await page.click('#desc');
    await page.evaluate(() => document.querySelector('#desc').setSelectionRange(2, 2));
    await page.keyboard.press('Control+Shift+Space');
    await page.waitForFunction(() => document.querySelector('.pcv-floating')?.dataset.state === 'recording');
    await page.waitForTimeout(600);
    await page.keyboard.press('Control+Shift+Space');
    await page.waitForFunction(() => document.querySelector('.pcv-floating')?.dataset.state === 'idle');
    assert.equal(await page.inputValue('#desc'), `ab ${STUB_TEXT}`);
    await page.close();
  });

  await t.test('the × in the bubble cancels a recording, by mouse or touch', { skip: REAL && 'checks the stub text' }, async () => {
    for (const touch of [false, true]) {
      const context = await browser.newContext(touch ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
      const { page, calls } = await openPage(context);
      await caretAtEnd(page, '#ce');
      await page.locator('.pcv-mic').click();
      const cancel = page.locator('.pcv-status .pcv-cancel');
      await cancel.waitFor();
      await (touch ? cancel.tap() : cancel.click());
      await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'idle');
      assert.equal(calls.length, 0);
      assert.equal(await page.locator('.pcv-status').count(), 0);
      assert.equal(await page.locator('#ce').textContent(), 'Hello');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ce');
      await context.close();
    }
  });

  await t.test('the stop button in the bubble ends the recording and inserts the text, by mouse or touch', { skip: REAL && 'checks the stub text' }, async () => {
    for (const touch of [false, true]) {
      const context = await browser.newContext(touch ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
      const { page, calls } = await openPage(context);
      await caretAtEnd(page, '#ce');
      await page.locator('.pcv-mic').click();
      const stop = page.locator('.pcv-status .pcv-stop');
      await stop.waitFor();
      await page.waitForTimeout(600);
      await (touch ? stop.tap() : stop.click());
      await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'idle');
      assert.equal(calls.length, 1);
      assert.equal(await page.locator('#ce').textContent(), `Hello ${STUB_TEXT}`);
      await context.close();
    }
  });

  await t.test('the bubble moves off a button it would hide', { skip: REAL && 'checks the stub text' }, async () => {
    const { page } = await openPage(desktop);
    await caretAtEnd(page, '#ce');
    const mic = page.locator('.pcv-mic');
    await mic.waitFor();
    // A close button right where the bubble would go: above the mic, from its left edge.
    await page.evaluate(() => {
      const rect = document.querySelector('.pcv-mic').getBoundingClientRect();
      const close = document.createElement('button');
      close.id = 'close';
      close.textContent = 'x';
      close.style.cssText = `position:fixed;left:${rect.left + 20}px;top:${rect.top - 30}px;width:24px;height:24px;z-index:5`;
      document.body.append(close);
    });
    await mic.click();
    await page.locator('.pcv-status').waitFor();
    const [bubble, close] = await page.evaluate(() => ['.pcv-status', '#close'].map((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }));
    const overlaps = bubble.left < close.right && close.left < bubble.right && bubble.top < close.bottom && close.top < bubble.bottom;
    assert.equal(overlaps, false, JSON.stringify({ bubble, close }));
    await page.click('#close');
    assert.equal(await mic.getAttribute('data-state'), 'recording');
    await page.keyboard.press('Escape');
    await page.close();
  });

  await t.test('a field whose + appears later swaps the floating mic for its own', { skip: REAL && 'checks the stub text' }, async () => {
    const { page } = await openPage(desktop);
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'late-composer';
      box.innerHTML = '<div contenteditable="true" id="late-field">x</div><div class="row2"></div>';
      document.body.append(box);
    });
    await page.click('#late-field');
    await page.locator('.pcv-floating').waitFor();
    await page.evaluate(() => {
      const add = document.createElement('button');
      add.dataset.testid = 'task-chat-composer-add';
      document.querySelector('#late-composer .row2').append(add);
    });
    await page.locator('#late-composer .pcv-mic').waitFor();
    await page.waitForFunction(() => !document.querySelector('.pcv-floating'));
    await page.close();
  });

  await t.test('Escape cancels a recording without transcribing', async () => {
    const { page, calls } = await openPage(desktop);
    await caretAtEnd(page, '#ce');
    await page.locator('.pcv-mic').click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'idle');
    assert.equal(calls.length, 0);
    assert.equal(await page.locator('#ce').textContent(), 'Hello');
    await page.close();
  });

  await t.test('stops after the longest allowed recording', async () => {
    const page = await desktop.newPage();
    const calls = [];
    await page.exposeFunction('pcvTranscribe', async () => {
      calls.push(1);
      return { text: STUB_TEXT };
    });
    await page.goto(url);
    await page.evaluate(() => window.PCV.startDictation({ transcribe: (p) => window.pcvTranscribe(p), maxRecordingMs: 700 }));
    await caretAtEnd(page, '#ce');
    await page.locator('.pcv-mic').click();
    await page.waitForFunction(() => document.querySelector('#ce').textContent.includes('dictated'), null, { timeout: 5000 });
    assert.equal(calls.length, 1);
    assert.match(await page.locator('.pcv-message').textContent(), /stopped at the 1-minute limit/);
    await page.close();
  });

  await t.test('keeps exactly one mic when the composer is rendered again, and cleans up on stop', async () => {
    const { page } = await openPage(desktop);
    await page.locator('.pcv-mic').waitFor();
    await page.evaluate(() => {
      const row = document.querySelector('.row');
      row.querySelector('[data-testid="task-chat-composer-add"]').remove();
      const fresh = document.createElement('button');
      fresh.dataset.testid = 'task-chat-composer-add';
      row.prepend(fresh);
    });
    await page.waitForFunction(() => document.querySelector('[data-testid="task-chat-composer-add"] + .pcv-mic'));
    assert.equal(await page.locator('.pcv-mic').count(), 1);
    await page.evaluate(() => window.pcvStop());
    assert.equal(await page.locator('.pcv-mic, style[data-pcv]').count(), 0);
    await page.close();
  });

  await t.test('works by touch at phone width', { skip: REAL && 'checks the stub text' }, async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const { page } = await openPage(phone);
    await page.tap('#ce');
    await caretAtEnd(page, '#ce');
    const mic = page.locator('.pcv-mic');
    await mic.tap();
    await page.waitForTimeout(800);
    await mic.tap();
    await page.waitForFunction(() => document.querySelector('.pcv-mic')?.dataset.state === 'idle');
    assert.equal(await page.locator('#ce').textContent(), `Hello ${STUB_TEXT}`);
    const box = await mic.boundingBox();
    assert.ok(box.x + box.width <= 390, 'mic fits on screen');
    await phone.close();
  });
});

test('spacing around inserted text', () => {
  assert.equal(withSpacing('hi', '', ''), 'hi');
  assert.equal(withSpacing('hi', 'a', 'b'), ' hi ');
  assert.equal(withSpacing('hi', 'a ', '.'), 'hi');
  assert.equal(withSpacing('hi', 'a\n', ' b'), 'hi');
});

test('clock format and hotkey', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65_400), '1:05');
  assert.equal(isHotkey({ code: 'Space', shiftKey: true, ctrlKey: true }), true);
  assert.equal(isHotkey({ code: 'Space', shiftKey: true, metaKey: true }), true);
  assert.equal(isHotkey({ code: 'Space', shiftKey: false, ctrlKey: true }), false);
  assert.equal(isHotkey({ code: 'Space', shiftKey: true, ctrlKey: true, altKey: true }), false);
});
