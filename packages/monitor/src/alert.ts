import type { AppLogger } from '../../shared/src/logger';
import { messageFromError } from '../../shared/src/errors';
import { sendEmail, type SmtpConfig } from './smtp';

export type AlertSeverity = 'warning' | 'critical';

export interface AlertInput {
  severity: AlertSeverity;
  title: string;
  body: string;
}

export interface AlertDispatcher {
  send(input: AlertInput): Promise<void>;
}

export interface AlertDispatcherDeps {
  /** Slack incoming webhook URL. The primary, zero-dependency channel. */
  slack?: { webhookUrl: string };
  /** Optional SMTP channel; uses the built-in client (see ./smtp). */
  email?: SmtpConfig;
  logger: AppLogger;
  /** Injectable for tests; defaults to global fetch (Node >= 18). */
  fetchImpl?: typeof fetch;
}

export function createAlertDispatcher(deps: AlertDispatcherDeps): AlertDispatcher {
  return {
    async send(input) {
      const failures: string[] = [];
      if (deps.slack) {
        try {
          await sendSlackAlert({
            webhookUrl: deps.slack.webhookUrl,
            input,
            fetchImpl: deps.fetchImpl ?? fetch,
          });
        } catch (err) {
          failures.push(`slack: ${messageFromError(err)}`);
        }
      }
      if (deps.email) {
        try {
          await sendEmail(deps.email, { subject: input.title, body: `${input.severity.toUpperCase()}\n\n${input.body}` });
        } catch (err) {
          failures.push(`email: ${messageFromError(err)}`);
        }
      }
      if (failures.length > 0) {
        deps.logger.error('alert delivery failed', { title: input.title, failures });
      }
      if (!deps.slack && !deps.email) {
        deps.logger.warn('no alert channel configured; dropping alert', { title: input.title });
      }
    },
  };
}

export function sendSlackAlert(args: {
  webhookUrl: string;
  input: AlertInput;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { webhookUrl, input } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const color = input.severity === 'critical' ? 'danger' : 'warning';
  return fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `*${input.title}*`,
      attachments: [{ color, fallback: input.title, text: input.body }],
    }),
    signal: AbortSignal.timeout(10_000),
  }).then((res) => {
    if (!res.ok) {
      throw new Error(`Slack webhook returned HTTP ${res.status}`);
    }
  });
}