import { spawn } from 'node:child_process';

const MAX_REASON = 200;
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

// An error from the long-running helper; the message is short and holds no transcript text.
export class SpeechServerError extends Error {}

// Keeps `transcribe.py --serve` running so the model stays loaded between recordings. The helper is
// started on the first request and stopped after `idleMs` without requests, which frees the GPU memory.
export class SpeechServer {
  #command;
  #args;
  #idleMs;
  #child = null;
  #ready = null; // Promise that resolves once the model is loaded.
  #lines = [];
  #waiters = [];
  #idleTimer = null;
  #stderr = '';

  constructor({ python, args, idleMs }) {
    this.#command = python;
    this.#args = args;
    this.#idleMs = idleMs;
  }

  get running() {
    return this.#child !== null;
  }

  // Transcribes one file and resolves with { text, seconds }. A request that takes longer than `timeoutMs`,
  // model loading included, stops the helper so the next request starts a fresh one.
  async transcribe(file, timeoutMs) {
    this.#clearIdle();
    const deadline = Date.now() + timeoutMs;
    let reply;
    try {
      await this.#withDeadline(this.#start(), deadline, 'loading the model took too long');
      this.#child.stdin.write(`${JSON.stringify({ audio: file })}\n`);
      reply = await this.#withDeadline(this.#nextLine(), deadline, 'transcription took too long, try a shorter recording');
    } catch (err) {
      // No answer: the helper is stuck or gone, so the next request starts a fresh one.
      this.stop();
      throw err instanceof SpeechServerError ? err : new SpeechServerError('transcription failed');
    } finally {
      if (this.#child) this.#idleTimer = setTimeout(() => this.stop(), this.#idleMs);
    }
    if (typeof reply.error === 'string') throw new SpeechServerError(oneLine(reply.error));
    if (typeof reply.text !== 'string') throw new SpeechServerError('the transcriber printed no text');
    return { text: reply.text.trim(), seconds: Number(reply.seconds) || 0 };
  }

  // Starts loading the model without a request, so a recording that follows finds it loaded or loading.
  // The idle timer runs from now, which unloads the model when no request comes.
  warmup() {
    if (!this.#child) this.#start().catch(() => {});
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => this.stop(), this.#idleMs);
  }

  // Stops the helper; a later request starts it again.
  stop() {
    this.#clearIdle();
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    this.#lines = [];
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new SpeechServerError('the transcriber stopped'));
    child?.kill('SIGKILL');
  }

  #clearIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #start() {
    if (this.#ready) return this.#ready;
    this.#stderr = '';
    const child = spawn(this.#command, this.#args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) this.#push(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-4096);
    });
    child.stdin.on('error', () => {});
    const failed = (reason) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#ready = null;
      this.#clearIdle();
      for (const waiter of this.#waiters.splice(0)) waiter.reject(new SpeechServerError(reason));
    };
    child.on('error', (err) => failed(`could not start the transcriber: ${err.code ?? 'error'}`));
    child.on('exit', (code, signal) => {
      const last = this.#stderr.split('\n').filter((line) => line.startsWith('transcribe:')).at(-1);
      failed(`transcriber exited${signal ? ` (${signal})` : ` with ${code}`}${last ? `: ${oneLine(last)}` : ''}`);
    });
    this.#ready = this.#nextLine().then((line) => {
      if (line.ready !== true) throw new SpeechServerError('the transcriber did not start');
    });
    return this.#ready;
  }

  #push(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Not a reply line.
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(parsed);
    else this.#lines.push(parsed);
  }

  #nextLine() {
    if (this.#lines.length) return Promise.resolve(this.#lines.shift());
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #withDeadline(promise, deadline, reason) {
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SpeechServerError(reason)), Math.max(0, deadline - Date.now()));
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  }
}
