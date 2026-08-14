export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class WebhookVerificationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'WEBHOOK_SIGNATURE_INVALID', false, cause);
    this.name = 'WebhookVerificationError';
  }
}

export class WhatsAppApiError extends AppError {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly fbError?: { code?: number; subcode?: number; message?: string },
    retryable = false,
  ) {
    super(message, 'WHATSAPP_API_ERROR', retryable);
    this.name = 'WhatsAppApiError';
  }
}

export function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

export function messageFromError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
