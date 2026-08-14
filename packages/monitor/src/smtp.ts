import { connect, type Socket } from 'net';
import { connect as tlsConnect, type TLSSocket } from 'tls';

/**
 * A minimal, dependency-free SMTP client (RFC 5321) used only to deliver alert
 * emails. Supports implicit TLS (port 465), STARTTLS upgrade (port 587), and
 * AUTH LOGIN. Chosen over a full library so the monitoring package ships with
 * zero new runtime dependencies.
 */

export interface SmtpConfig {
  host: string;
  /** Default 587 (STARTTLS). Use 465 with `secure: true` for implicit TLS. */
  port?: number;
  /** true = implicit TLS from the first byte (port 465). */
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
}

export interface SmtpMessage {
  subject: string;
  body: string;
}

export interface SmtpReply {
  code: number;
  lines: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const EOL = '\r\n';

/**
 * Sequential reader/writer over one socket: call `send(line)` and it resolves
 * with the next complete SMTP reply. `upgradeTls()` swaps the underlying
 * socket after a 220 STARTTLS response without losing buffered state.
 */
function createTransport(socket: Socket | TLSSocket, timeoutMs: number) {
  let current: Socket | TLSSocket = socket;
  let buffer = '';
  let code = 0;
  let lines: string[] = [];
  let waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null;
  let timer: NodeJS.Timeout | null = null;

  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const w = waiter;
      waiter = null;
      w?.reject(new Error(`SMTP timeout after ${timeoutMs}ms waiting for ${current.remoteAddress ?? 'server'}`));
    }, timeoutMs);
  };

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    drain();
  };

  const onError = (err: Error) => {
    const w = waiter;
    waiter = null;
    if (timer) clearTimeout(timer);
    w?.reject(err);
  };

  const bind = (sock: Socket | TLSSocket) => {
    sock.on('data', onData);
    sock.on('error', onError);
  };

  const drain = () => {
    while (true) {
      const idx = buffer.indexOf(EOL);
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + EOL.length);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) continue;
      const nextCode = Number(match[1]);
      if (nextCode !== code && lines.length > 0) {
        // Unexpected code mid-reply (e.g. a stray line) — treat it as a new reply.
        code = 0;
        lines = [];
      }
      code = nextCode;
      lines.push(match[3]);
      if (match[2] === ' ') {
        const reply = { code, lines };
        code = 0;
        lines = [];
        if (timer) clearTimeout(timer);
        const w = waiter;
        waiter = null;
        w?.resolve(reply);
      }
    }
  };

  bind(current);

  return {
    /** Wait for the next complete reply without writing anything (used for the greeting). */
    read(): Promise<SmtpReply> {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        armTimer();
      });
    },
    send(line: string): Promise<SmtpReply> {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        armTimer();
        current.write(line + EOL);
      });
    },
    upgradeTls(servername: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const upgraded = tlsConnect({ socket: current, servername });
        current.removeListener('data', onData);
        current.removeListener('error', onError);
        current = upgraded;
        bind(upgraded);
        upgraded.once('secureConnect', () => resolve());
        upgraded.once('error', reject);
      });
    },
    close() {
      if (timer) clearTimeout(timer);
      current.destroy();
    },
  };
}

function connectSocket(cfg: SmtpConfig, timeoutMs: number): Promise<Socket | TLSSocket> {
  const port = cfg.port ?? (cfg.secure ? 465 : 587);
  return new Promise((resolve, reject) => {
    const socket = cfg.secure
      ? tlsConnect({ port, host: cfg.host, servername: cfg.host })
      : connect({ port, host: cfg.host });
    socket.setTimeout(timeoutMs);
    socket.once('error', reject);
    socket.once(cfg.secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', reject);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function expect(reply: SmtpReply, codes: number[], step: string): void {
  if (!codes.includes(reply.code)) {
    throw new Error(`SMTP ${step} rejected with ${reply.code}: ${reply.lines.join(' ')}`);
  }
}

function b64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64');
}

/** B-encode a subject when it contains non-ASCII characters. */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]+$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** Dot-stuffing per RFC 5321: a leading '.' in a body line becomes '..'. */
function dotStuff(body: string): string {
  return body.replace(/^\./gm, '..');
}

export async function sendEmail(cfg: SmtpConfig, message: SmtpMessage): Promise<void> {
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  let socket: Socket | TLSSocket | undefined;
  try {
    socket = await connectSocket(cfg, timeoutMs);
    const transport = createTransport(socket, timeoutMs);

    expect(await transport.read(), [220], 'greeting');

    const ehlo = await transport.send('EHLO localhost');
    expect(ehlo, [250], 'EHLO');
    let capabilities = ehlo.lines.join(' ');

    if (!cfg.secure && capabilities.includes('STARTTLS')) {
      expect(await transport.send('STARTTLS'), [220], 'STARTTLS');
      await transport.upgradeTls(cfg.host);
      const ehlo2 = await transport.send('EHLO localhost');
      expect(ehlo2, [250], 'EHLO (TLS)');
      capabilities = ehlo2.lines.join(' ');
    }

    if (cfg.user && cfg.pass) {
      if (!capabilities.includes('AUTH')) {
        throw new Error('SMTP server does not advertise AUTH but user/pass were provided');
      }
      expect(await transport.send('AUTH LOGIN'), [334], 'AUTH LOGIN');
      expect(await transport.send(b64(cfg.user)), [334], 'AUTH username');
      expect(await transport.send(b64(cfg.pass)), [235], 'AUTH password');
    }

    expect(await transport.send(`MAIL FROM:<${cfg.from}>`), [250], 'MAIL FROM');
    expect(await transport.send(`RCPT TO:<${cfg.to}>`), [250, 251], 'RCPT TO');

    expect(await transport.send('DATA'), [354], 'DATA');

    const headers = [
      `From: ${cfg.from}`,
      `To: ${cfg.to}`,
      `Subject: ${encodeSubject(message.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      dotStuff(message.body),
      '.',
    ].join(EOL);
    expect(await transport.send(headers), [250], 'message body');

    try {
      await transport.send('QUIT');
    } catch {
      // QUIT reply is best-effort; the server may close before replying.
    }
    transport.close();
  } catch (err) {
    socket?.destroy();
    throw err;
  }
}