import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  const value = Array.isArray(header) ? header.join(';') : header;
  if (!value) return result;
  for (const segment of value.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const key = segment.slice(0, separator).trim();
    const cookieValue = segment.slice(separator + 1).trim();
    if (key && cookieValue && !result.has(key)) result.set(key, cookieValue);
  }
  return result;
}

export function isSafeLocalReturnPath(value: string | undefined): string {
  if (!value || value.length > 2_048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return '/';
  }
  return value;
}

export function cookiesAreSecure(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.SESSION_COOKIE_SECURE === 'true';
}

export function sessionCookieName(): string {
  return cookiesAreSecure() ? '__Host-platform_session' : 'platform_session';
}

export function serializeSessionCookies(sessionToken: string, csrfToken: string): string[] {
  const secure = cookiesAreSecure() ? '; Secure' : '';
  return [
    `${sessionCookieName()}=${sessionToken}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax${secure}`,
    `platform_csrf=${csrfToken}; Path=/; Max-Age=604800; SameSite=Strict${secure}`,
  ];
}

export function clearSessionCookies(): string[] {
  const secure = cookiesAreSecure() ? '; Secure' : '';
  return [
    `${sessionCookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
    `platform_csrf=; Path=/; Max-Age=0; SameSite=Strict${secure}`,
  ];
}
