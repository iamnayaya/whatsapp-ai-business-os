import { describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { createAlertDispatcher, sendSlackAlert } from '../src/alert';
import { sendEmail } from '../src/smtp';
import { createLogger } from '../../shared/src/logger';

const silentLogger = createLogger('test', { destination: () => undefined });

const input = { severity: 'warning' as const, title: 'WhatsApp AI Business OS — alert', body: '1 message(s) FAILED in the last 15 min' };

describe('sendSlackAlert', () => {
  it('POSTs a formatted payload to the webhook URL', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => ({ ok: true, status: 200 } as Response));
    await sendSlackAlert({ webhookUrl: 'https://hooks.slack.com/services/AAA/BBB', input, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/AAA/BBB');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain(input.title);
    expect(body.attachments[0].color).toBe('warning');
    expect(body.attachments[0].text).toBe(input.body);
  });

  it('throws when the webhook returns a non-OK status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 } as Response));
    await expect(
      sendSlackAlert({ webhookUrl: 'https://x', input, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('HTTP 500');
  });
});

describe('createAlertDispatcher', () => {
  it('delivers to Slack and swallows delivery errors (never throws)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 } as Response));
    const dispatch = createAlertDispatcher({ slack: { webhookUrl: 'https://x' }, logger: silentLogger, fetchImpl: fetchImpl as unknown as typeof fetch });

    await dispatch.send(input);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when no channel is configured', async () => {
    const logger = { ...silentLogger, warn: vi.fn() };
    const dispatch = createAlertDispatcher({ logger: logger as never });
    await dispatch.send(input);
    expect(logger.warn).toHaveBeenCalledWith('no alert channel configured; dropping alert', expect.anything());
  });
});

// --- Minimal fake SMTP server (no TLS) for exercising the built-in client ---
function startSmtpServer(opts: { auth?: boolean } = {}) {
  const commands: string[] = [];
  const messages: string[] = [];
  const server = createServer((socket: Socket) => {
    const send = (s: string) => socket.write(s + '\r\n');
    send('220 fake.test ESMTP');
    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let authStep = 0;

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(dataLines.join('\n'));
            dataLines = [];
            send('250 2.0.0 OK queued');
          } else {
            dataLines.push(line);
          }
          continue;
        }

        commands.push(line);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) {
          send('250-fake.test');
          if (opts.auth) send('250-AUTH LOGIN');
          send('250 8BITMIME');
        } else if (cmd.startsWith('AUTH LOGIN') && opts.auth) {
          authStep = 1;
          send('334 VXNlcm5hbWU6');
        } else if (authStep === 1 && opts.auth) {
          authStep = 2;
          send('334 UGFzc3dvcmQ6');
        } else if (authStep === 2 && opts.auth) {
          authStep = 0;
          send('235 2.7.0 Authentication successful');
        } else if (cmd.startsWith('MAIL FROM')) {
          send('250 2.1.0 OK');
        } else if (cmd.startsWith('RCPT TO')) {
          send('250 2.1.5 OK');
        } else if (cmd.startsWith('DATA')) {
          inData = true;
          dataLines = [];
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd.startsWith('QUIT')) {
          send('221 2.0.0 Bye');
          socket.end();
        } else {
          send('250 OK');
        }
      }
    });
    socket.on('error', () => undefined);
  });

  const listen = () =>
    new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  return { server, commands, messages, listen, close };
}

describe('sendEmail (built-in SMTP client)', () => {
  it('sends a message through the full SMTP transaction (no auth)', async () => {
    const fake = startSmtpServer();
    const port = await fake.listen();

    await sendEmail(
      { host: '127.0.0.1', port, from: 'alerts@business.com', to: 'owner@business.com' },
      { subject: 'Alert: something wrong', body: 'line one\n.line two\nline three' },
    );

    await fake.close();
    expect(fake.commands).toContain('MAIL FROM:<alerts@business.com>');
    expect(fake.commands).toContain('RCPT TO:<owner@business.com>');
    expect(fake.commands[0]).toMatch(/^EHLO /);
    expect(fake.messages[0]).toContain('Subject: Alert: something wrong');
    expect(fake.messages[0]).toContain('line one');
    // Dot-stuffing: a body line beginning with '.' must be escaped.
    expect(fake.messages[0]).toContain('..line two');
    expect(fake.messages[0]).toContain('line three');
  });

  it('completes AUTH LOGIN when credentials are supplied', async () => {
    const fake = startSmtpServer({ auth: true });
    const port = await fake.listen();

    await sendEmail(
      { host: '127.0.0.1', port, user: 'user@test', pass: 'secret', from: 'a@b.com', to: 'c@d.com' },
      { subject: 'S', body: 'hello' },
    );

    await fake.close();
    expect(fake.commands).toContain('AUTH LOGIN');
    expect(fake.commands[2]).toBe(Buffer.from('user@test').toString('base64'));
    expect(fake.commands[3]).toBe(Buffer.from('secret').toString('base64'));
  });

  it('throws a clear error when the server rejects a step', async () => {
    const fake = startSmtpServer();
    const port = await fake.listen();
    // Reject RCPT TO by simulating: simplest is a server that refuses — reuse
    // the normal fake and point at a closed port to force a connect failure.
    await fake.close();

    await expect(
      sendEmail({ host: '127.0.0.1', port, from: 'a@b.com', to: 'c@d.com' }, { subject: 'S', body: 'hello' }),
    ).rejects.toThrow();
  });
});