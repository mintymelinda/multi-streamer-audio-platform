import { Injectable } from '@nestjs/common';
const SECRET_KEY = /(?:access.?token|refresh.?token|client.?secret|authorization|credential|ciphertext|private.?key|password|api.?key)/i;
const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
@Injectable()
export class ProviderSecretRedactionService {
  redact<T>(value: T): T {
    const seen = new WeakSet<object>();
    const visit = (input: unknown): unknown => {
      if (typeof input === 'string') return input.replace(/\\b(Bearer|OAuth)\\s+[^\\s,;]+/gi, '$1 [REDACTED]');
      if (input === null || typeof input !== 'object') return input;
      if (seen.has(input)) return CIRCULAR;
      seen.add(input);
      if (Array.isArray(input)) return input.map(visit);
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) output[key] = SECRET_KEY.test(key) ? REDACTED : visit(item);
      return output;
    };
    return visit(value) as T;
  }
  toBrowserDto<T>(value: T): T { return this.redact(value); }
  serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) return this.redact({ name: error.name, message: error.message, stack: error.stack }) as Record<string, unknown>;
    return this.redact({ error }) as Record<string, unknown>;
  }
}
