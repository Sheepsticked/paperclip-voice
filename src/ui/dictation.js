// Adds a mic button next to the "+" of Paperclip's composers, and a floating one for other text fields.
// Recording goes to `transcribe`, and the text is typed in at the cursor of the field it belongs to.

// Buttons the mic is placed after; each sits in a composer together with its text field.
export const ANCHORS = [
  '[data-testid="task-chat-composer-add"]',
  '[data-testid="issue-chat-composer-add"]',
  'button[aria-label="Attach files"]',
];
const FIELD = '[contenteditable="true"], textarea';
export const MAX_RECORDING_MS = 3 * 60 * 1000;
const MESSAGE_MS = 4000;
const TICK_MS = 100;
const MIC_CLASS = 'pcv-mic';

const MIC_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v4"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const BUSY_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="pcv-spin"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>';

const STYLE = `
.${MIC_CLASS}{display:inline-grid;place-items:center;flex-shrink:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.${MIC_CLASS}[data-state="recording"]{color:#ef4444!important;animation:pcv-pulse 1.2s ease-in-out infinite}
.${MIC_CLASS}[data-state="working"]{cursor:progress}
.pcv-floating{position:fixed;z-index:2147483000;width:32px;height:32px;border-radius:9999px;border:1px solid rgba(127,127,127,.35);background:var(--background,#1f1f1f);color:var(--muted-foreground,#a1a1aa);box-shadow:0 2px 8px rgba(0,0,0,.25)}
.pcv-floating:hover{color:var(--foreground,#fafafa)}
.pcv-message{position:fixed;z-index:2147483001;max-width:min(320px,calc(100vw - 16px));padding:6px 10px;border-radius:8px;background:#27272a;color:#fafafa;font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none}
.pcv-status{position:fixed;z-index:2147483001;display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:9999px;background:#27272a;color:#fafafa;font:12px/1.4 system-ui,sans-serif;font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none;white-space:nowrap}
.pcv-act{pointer-events:auto;display:grid;place-items:center;width:26px;height:26px;margin:-6px 0;border:0;border-radius:9999px;background:transparent;color:#d4d4d8;font:16px/1 system-ui,sans-serif;cursor:pointer}
.pcv-act:last-child{margin-right:-6px}
.pcv-act:hover{background:rgba(255,255,255,.12);color:#fff}
.pcv-stop{color:#ef4444}
.pcv-dot{width:8px;height:8px;border-radius:9999px;background:#ef4444;animation:pcv-pulse 1.2s ease-in-out infinite}
.pcv-level{width:48px;height:4px;border-radius:2px;background:rgba(255,255,255,.2);overflow:hidden}
.pcv-level>i{display:block;height:100%;width:0;background:#22c55e;transition:width 80ms linear}
.pcv-spin{animation:pcv-spin 1s linear infinite}
@keyframes pcv-pulse{50%{opacity:.45}}
@keyframes pcv-spin{to{transform:rotate(360deg)}}
`;

const isField = (node) => node instanceof Element && node.matches(FIELD);

// The text field that shares a composer with `anchor`: the first field in the closest ancestor that has one.
export function fieldFor(anchor) {
  for (let node = anchor.parentElement; node && node !== anchor.ownerDocument.body; node = node.parentElement) {
    const field = node.querySelector(FIELD);
    if (field) return field;
  }
  return null;
}

// The text with spaces added where it would otherwise run into the words around the cursor.
export function withSpacing(text, before = '', after = '') {
  const head = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
  return `${head}${text}${tail}`;
}

// "m:ss" for a duration in milliseconds.
export function formatClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Whether a key event is the dictation hotkey: Ctrl+Shift+Space, or Cmd+Shift+Space on a Mac.
export const isHotkey = (event) => event.code === 'Space' && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey;

// A short message for a failure; never holds audio or transcript text.
export function describeError(err) {
  const name = err?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The browser blocked the microphone. Allow it for this site and try again.';
  if (name === 'NotFoundError') return 'No microphone found.';
  if (name === 'InsecureContext') return 'The browser only allows the microphone over HTTPS here. See the plugin notes for the browser setting.';
  const message = typeof err?.message === 'string' && err.message ? err.message : 'Something went wrong.';
  return `Transcription failed: ${message.slice(0, 160)}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function pickMimeType(Recorder) {
  const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
  return types.find((type) => Recorder.isTypeSupported?.(type)) ?? '';
}

export function startDictation({ transcribe, warmup = null, doc = document, maxRecordingMs = MAX_RECORDING_MS }) {
  const win = doc.defaultView;
  const ranges = new WeakMap();
  const composerFields = new WeakSet();
  let session = null; // { button, field, recorder, stream, chunks, timer, cancelled }
  let floating = null;
  let floatingField = null;
  let messageNode = null;
  let messageTimer = null;
  let statusNode = null;
  let statusTimer = null;
  let scheduled = false;

  const style = doc.createElement('style');
  style.dataset.pcv = '';
  style.textContent = STYLE;
  doc.head.appendChild(style);

  function setState(button, state) {
    button.dataset.state = state;
    button.innerHTML = state === 'recording' ? STOP_ICON : state === 'working' ? BUSY_ICON : MIC_ICON;
    const label = state === 'recording' ? 'Stop dictation (Ctrl+Shift+Space)' : state === 'working' ? 'Transcribing…' : 'Dictate (Ctrl+Shift+Space)';
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function makeButton(className) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `${className} ${MIC_CLASS}`.trim();
    setState(button, 'idle');
    // Keeps the cursor in the text field while the button is pressed.
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const field = button.pcvField ?? (button.pcvAnchor?.isConnected ? fieldFor(button.pcvAnchor) : null);
      toggle(button, field || null);
    });
    return button;
  }

  // Places a fixed bubble just above `button`, or below it when there is no room.
  // Whether a box at (left, top) of the node's size would hide a button or link of the page.
  function hidesControl(node, left, top) {
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    for (const x of [left + 2, left + width / 2, left + width - 2]) {
      for (const y of [top + 2, top + height - 2]) {
        const hit = doc.elementsFromPoint(x, y).find((element) => !node.contains(element));
        if (hit?.closest('button, a[href], [role="button"], summary, select, input:not([type="hidden"])')) return true;
      }
    }
    return false;
  }

  // Puts the node next to the mic, inside the visible part of the screen, preferring a spot that hides no
  // other button: above the mic, above it aligned to its right edge, then below it.
  function placeNear(node, button) {
    const rect = button.getBoundingClientRect();
    const view = win.visualViewport;
    const viewTop = view ? view.offsetTop : 0;
    const viewBottom = view ? view.offsetTop + view.height : win.innerHeight;
    const viewLeft = view ? view.offsetLeft : 0;
    const viewRight = view ? view.offsetLeft + view.width : win.innerWidth;
    const clampLeft = (left) => Math.max(viewLeft + 8, Math.min(left, viewRight - node.offsetWidth - 8));
    const clampTop = (top) => Math.max(viewTop + 8, Math.min(top, viewBottom - node.offsetHeight - 8));
    const above = rect.top - node.offsetHeight - 8;
    const below = rect.bottom + 8;
    const spots = [
      [clampLeft(rect.left), clampTop(above >= viewTop + 8 ? above : below)],
      [clampLeft(rect.right - node.offsetWidth), clampTop(above >= viewTop + 8 ? above : below)],
      [clampLeft(rect.left), clampTop(below)],
      [clampLeft(rect.right - node.offsetWidth), clampTop(below)],
    ];
    const [left, top] = spots.find(([x, y]) => !hidesControl(node, x, y)) ?? spots[0];
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  function showMessage(button, text) {
    hideMessage();
    messageNode = doc.createElement('div');
    messageNode.className = 'pcv-message';
    messageNode.setAttribute('role', 'status');
    messageNode.textContent = text;
    doc.body.appendChild(messageNode);
    placeNear(messageNode, button);
    messageTimer = win.setTimeout(hideMessage, MESSAGE_MS);
  }

  // A live bubble by the mic: recording time and voice level, then the time spent transcribing.
  function showStatus(current) {
    hideStatus();
    statusNode = doc.createElement('div');
    statusNode.className = 'pcv-status';
    statusNode.setAttribute('aria-live', 'polite');
    const label = doc.createElement('span');
    // Buttons that keep the cursor in the field, so the text still goes where it was.
    const action = (className, html, title, run) => {
      const node = doc.createElement('button');
      node.type = 'button';
      node.className = `pcv-act ${className}`;
      node.innerHTML = html;
      node.title = title;
      node.setAttribute('aria-label', title.replace(/ \(.*\)$/, ''));
      node.addEventListener('pointerdown', (event) => event.preventDefault());
      node.addEventListener('mousedown', (event) => event.preventDefault());
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        run();
      });
      return node;
    };
    const stop = action('pcv-stop', STOP_ICON, 'Stop and insert the text', () => {
      if (session === current && current.state === 'recording') current.recorder.stop();
    });
    const cancel = action('pcv-cancel', '×', 'Cancel dictation (Esc)', () => cancelRecording(current));
    statusNode.append(label, stop, cancel);
    doc.body.appendChild(statusNode);
    const samples = current.analyser ? new Uint8Array(current.analyser.fftSize) : null;
    const render = () => {
      if (!current.button.isConnected) return hideStatus();
      const elapsed = Date.now() - current.phaseStarted;
      if (current.state === 'recording') {
        let level = 0;
        if (samples) {
          current.analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) sum += ((value - 128) / 128) ** 2;
          level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        }
        label.style.cssText = 'display:flex;align-items:center;gap:8px';
        label.innerHTML = `<span class="pcv-dot"></span><span>${formatClock(elapsed)} / ${formatClock(maxRecordingMs)}</span>${samples ? `<span class="pcv-level"><i style="width:${Math.round(level * 100)}%"></i></span>` : ''}`;
      } else {
        stop.remove();
        cancel.remove();
        label.textContent = `Transcribing… ${Math.floor(elapsed / 1000)} s`;
      }
      // Placed again only when the mic moves, so the bubble does not jump around.
      const rect = current.button.getBoundingClientRect();
      const key = `${rect.left},${rect.top},${statusNode.offsetWidth},${win.visualViewport?.height ?? win.innerHeight}`;
      if (key !== placedAt) {
        placedAt = key;
        placeNear(statusNode, current.button);
      }
    };
    let placedAt = '';
    render();
    statusTimer = win.setInterval(render, TICK_MS);
  }

  // Throws the recording away without transcribing it.
  function cancelRecording(current) {
    if (session !== current || current.state !== 'recording') return;
    current.cancelled = true;
    current.recorder.stop();
  }

  function hideStatus() {
    win.clearInterval(statusTimer);
    statusNode?.remove();
    statusNode = null;
  }

  function hideMessage() {
    win.clearTimeout(messageTimer);
    messageNode?.remove();
    messageNode = null;
  }

  function release(current) {
    win.clearTimeout(current.timer);
    current.stream?.getTracks().forEach((track) => track.stop());
    current.audioContext?.close().catch(() => {});
    current.audioContext = null;
    current.analyser = null;
  }

  // An analyser for the voice level; recording works without it when the browser refuses one.
  function attachLevel(current) {
    try {
      const context = new (win.AudioContext ?? win.webkitAudioContext)();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(current.stream).connect(analyser);
      // Some browsers start an audio context suspended; the level bar would then stay empty.
      context.resume?.().catch(() => {});
      current.audioContext = context;
      current.analyser = analyser;
    } catch {
      current.analyser = null;
    }
  }

  async function toggle(button, field) {
    if (session && session.button !== button) return;
    if (session?.state === 'recording') return session.recorder.stop();
    if (session) return;
    hideMessage();
    if (!field) return showMessage(button, 'Click into the text field first.');
    const media = win.navigator.mediaDevices;
    if (!media?.getUserMedia || !win.MediaRecorder) {
      return showMessage(button, describeError({ name: win.isSecureContext ? 'NotFoundError' : 'InsecureContext' }));
    }
    const current = { button, field, chunks: [], state: 'starting', cancelled: false };
    session = current;
    try {
      current.stream = await media.getUserMedia({ audio: true });
      const mimeType = pickMimeType(win.MediaRecorder);
      current.recorder = new win.MediaRecorder(current.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48000 });
    } catch (err) {
      release(current);
      session = null;
      return showMessage(button, describeError(err));
    }
    current.recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) current.chunks.push(event.data);
    });
    current.recorder.addEventListener('stop', () => finish(current));
    current.recorder.start();
    // The model loads while the user speaks; a failure here shows up when the recording is sent.
    Promise.resolve().then(() => warmup?.()).catch(() => {});
    current.state = 'recording';
    current.phaseStarted = Date.now();
    attachLevel(current);
    showStatus(current);
    current.timer = win.setTimeout(() => {
      if (current.recorder.state !== 'recording') return;
      current.hitLimit = true;
      current.recorder.stop();
    }, maxRecordingMs);
    setState(button, 'recording');
  }

  async function finish(current) {
    release(current);
    if (current.cancelled) {
      hideStatus();
      session = null;
      setState(current.button, 'idle');
      return;
    }
    current.state = 'working';
    current.phaseStarted = Date.now();
    setState(current.button, 'working');
    try {
      const type = current.recorder.mimeType || current.chunks[0]?.type || 'audio/webm';
      const blob = new win.Blob(current.chunks, { type });
      current.chunks = [];
      const result = await transcribe({ audio: { value: await blobToBase64(blob) }, mimeType: type });
      hideStatus();
      const text = typeof result?.text === 'string' ? result.text.trim() : '';
      if (typeof result?.error === 'string') showMessage(current.button, describeError({ message: result.error }));
      else if (!text) showMessage(current.button, 'No speech was recognised.');
      else if (!current.field?.isConnected) await copyInstead(current.button, text, 'The text field is gone.');
      else if (!(await insert(current.field, text, typeof result.note === 'string' ? result.note : null))) await copyInstead(current.button, text, 'Could not type into this field.');
      else if (current.hitLimit) showMessage(current.button, `Recording stopped at the ${Math.round(maxRecordingMs / 60000) || 1}-minute limit.`);
    } catch (err) {
      showMessage(current.button, describeError(err));
    } finally {
      if (session === current) hideStatus();
      session = null;
      if (current.button.isConnected) setState(current.button, 'idle');
    }
  }

  // Puts the text on the clipboard when it could not be typed in, so the dictation is not lost.
  async function copyInstead(button, text, reason) {
    try {
      await win.navigator.clipboard.writeText(text);
      showMessage(button, `${reason} The text is copied; paste it.`);
    } catch {
      showMessage(button, `${reason} Nothing was inserted.`);
    }
  }

  // Resolves after the editor has had a frame to apply input it handles itself.
  const nextFrame = () => new Promise((resolve) => win.requestAnimationFrame(() => resolve()));

  // Types `text` at the saved cursor of `field`, the way the browser inserts typed text, so editors see normal input.
  // When the field is still empty, `note` goes first on a line of its own. Resolves with whether the field's text changed.
  async function insert(field, text, note = null) {
    field.focus({ preventScroll: true });
    const lead = note && !(field.tagName === 'TEXTAREA' ? field.value : field.textContent).trim() ? note : null;
    if (field.tagName === 'TEXTAREA') {
      const piece = lead ? `${lead}\n${text}` : withSpacing(text, field.value.slice(0, field.selectionStart), field.value.slice(field.selectionEnd));
      if (!doc.execCommand('insertText', false, piece)) {
        field.setRangeText(piece, field.selectionStart, field.selectionEnd, 'end');
        field.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: piece }));
      }
      return true;
    }
    const selection = win.getSelection();
    const saved = ranges.get(field);
    if (saved && field.contains(saved.startContainer)) {
      selection.removeAllRanges();
      selection.addRange(saved);
    } else if (!field.contains(selection.anchorNode)) {
      selection.selectAllChildren(field);
      selection.collapseToEnd();
    }
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    let before = '';
    let after = '';
    if (range) {
      const head = doc.createRange();
      head.selectNodeContents(field);
      head.setEnd(range.startContainer, range.startOffset);
      before = head.toString();
      const tail = doc.createRange();
      tail.selectNodeContents(field);
      tail.setStart(range.endContainer, range.endOffset);
      after = tail.toString();
    }
    const previous = field.textContent;
    // Rich editors drop line breaks typed by script but keep the lines of pasted text.
    if (lead && pasteText(field, `${lead}\n${text}`)) {
      if (field.textContent !== previous) return true;
      await nextFrame();
      if (!field.isConnected) return false;
      if (field.textContent !== previous) return true;
    }
    // Without a paste the note shares the line with the text.
    doc.execCommand('insertText', false, lead ? `${lead} ${text}` : withSpacing(text, before, after));
    if (field.textContent !== previous) return true;
    await nextFrame();
    return field.isConnected && field.textContent !== previous;
  }

  // Offers `text` to the field's editor as a paste; returns whether the editor took it.
  function pasteText(field, text) {
    try {
      const data = new win.DataTransfer();
      data.setData('text/plain', text);
      const event = new win.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    } catch {
      return false;
    }
  }

  function onSelectionChange() {
    const selection = win.getSelection();
    if (!selection?.rangeCount) return;
    const field = selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement)?.closest(FIELD);
    if (field) ranges.set(field, selection.getRangeAt(0).cloneRange());
  }

  // The mic that belongs to `field`: the one next to its composer's "+", or the floating one.
  function micFor(field) {
    for (const mic of doc.querySelectorAll(`.${MIC_CLASS}:not(.pcv-floating)`)) {
      if (mic.pcvAnchor?.isConnected && fieldFor(mic.pcvAnchor) === field) return mic;
    }
    if (floatingField !== field) {
      floatingField = field;
      placeFloating();
    }
    return floating;
  }

  function onKeyDown(event) {
    if (isHotkey(event)) {
      if (session) {
        event.preventDefault();
        if (session.state === 'recording') session.recorder.stop();
        return;
      }
      const field = doc.activeElement?.closest?.(FIELD);
      if (!field || field.readOnly || field.disabled) return;
      event.preventDefault();
      const mic = micFor(field);
      if (mic) toggle(mic, field);
      return;
    }
    if (event.key === 'Escape' && session?.state === 'recording') cancelRecording(session);
  }

  // Composer fields get the mic next to their "+"; any other focused field gets a floating one.
  function onFocusIn(event) {
    const field = event.target;
    if (!isField(field) || composerFields.has(field)) return;
    if (field.readOnly || field.disabled) return;
    floatingField = field;
    placeFloating();
  }

  function onFocusOut() {
    win.setTimeout(() => {
      if (session?.button === floating) return;
      const active = doc.activeElement;
      if (active !== floatingField && active !== floating) hideFloating();
    }, 150);
  }

  function placeFloating() {
    if (!floatingField?.isConnected) return hideFloating();
    // Inside a modal the mic must live in the dialog, or the dialog blocks it and treats a press as a click outside.
    const host = floatingField.closest('[role="dialog"], [aria-modal="true"]') ?? doc.body;
    if (!floating) floating = makeButton('pcv-floating');
    if (floating.parentNode !== host) host.appendChild(floating);
    floating.pcvField = floatingField;
    const rect = floatingField.getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.right - 40, win.innerWidth - 40));
    const top = Math.max(4, Math.min(rect.bottom - 40, win.innerHeight - 40));
    // A transformed ancestor becomes the frame of a fixed element, so offsets are taken from it then.
    let frame = { left: 0, top: 0 };
    for (let node = host; node && node !== doc.body; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (style.transform !== 'none' || style.filter !== 'none' || style.contain.includes('paint')) {
        const box = node.getBoundingClientRect();
        frame = { left: box.left + node.clientLeft, top: box.top + node.clientTop };
        break;
      }
    }
    floating.style.left = `${left - frame.left}px`;
    floating.style.top = `${top - frame.top}px`;
  }

  function hideFloating() {
    if (session?.button === floating) return;
    floating?.remove();
    floating = null;
    floatingField = null;
  }

  function scan() {
    scheduled = false;
    for (const anchor of doc.querySelectorAll(ANCHORS.join(','))) {
      const field = fieldFor(anchor);
      if (!field) continue;
      composerFields.add(field);
      // The field may have had the cursor before its "+" appeared; its own mic replaces the floating one.
      if (floatingField === field) hideFloating();
      if (anchor.nextElementSibling?.classList.contains(MIC_CLASS)) continue;
      const button = makeButton(anchor.tagName === 'BUTTON' ? anchor.className : '');
      button.pcvAnchor = anchor;
      anchor.after(button);
    }
    for (const mic of doc.querySelectorAll(`.${MIC_CLASS}:not(.pcv-floating)`)) {
      if (!mic.previousElementSibling?.matches(ANCHORS.join(',')) && session?.button !== mic) mic.remove();
    }
    if (floatingField) placeFloating();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(scan);
  }

  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('selectionchange', onSelectionChange);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  win.addEventListener('resize', schedule);
  win.addEventListener('scroll', schedule, true);
  scan();

  return function stop() {
    observer.disconnect();
    doc.removeEventListener('selectionchange', onSelectionChange);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('focusout', onFocusOut);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('scroll', schedule, true);
    if (session) {
      session.cancelled = true;
      if (session.recorder?.state === 'recording') session.recorder.stop();
      else release(session);
    }
    hideMessage();
    hideStatus();
    hideFloating();
    floating?.remove();
    for (const mic of doc.querySelectorAll(`.${MIC_CLASS}`)) mic.remove();
    style.remove();
  };
}
