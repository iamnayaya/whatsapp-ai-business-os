import { describe, expect, it } from 'vitest';
import { AdminAuthService } from '../src/analytics/admin-auth.service';

function makeAuth() {
  return new AdminAuthService({
    password: 'correct-horse-battery',
    sessionSecret: 'top-secret-session-key',
    cookieName: 'wabiz_admin',
    maxAgeMs: 12 * 60 * 60 * 1000,
  });
}

describe('AdminAuthService', () => {
  it('verifies the password in constant time and rejects wrong/empty', () => {
    const auth = makeAuth();
    expect(auth.verifyPassword('correct-horse-battery')).toBe(true);
    expect(auth.verifyPassword('wrong')).toBe(false);
    expect(auth.verifyPassword(undefined)).toBe(false);
    expect(auth.verifyPassword('')).toBe(false);
  });

  it('creates a session that verifies and is not expired', () => {
    const auth = makeAuth();
    const session = auth.createSession(Date.now());
    expect(session).toContain('.');
    expect(auth.verifySession(session)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const auth = makeAuth();
    const session = auth.createSession(Date.now());
    const [payload] = session.split('.');
    // Flip a character in the payload so the signature no longer matches.
    const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    expect(auth.verifySession(`${tampered}.${session.split('.')[1]}`)).toBe(false);
  });

  it('rejects a session signed with the wrong secret', () => {
    const auth = makeAuth();
    const other = new AdminAuthService({
      password: 'x',
      sessionSecret: 'different-secret',
      cookieName: 'wabiz_admin',
      maxAgeMs: 1000,
    });
    const session = auth.createSession(Date.now());
    expect(other.verifySession(session)).toBe(false);
  });

  it('rejects an expired session', () => {
    const auth = makeAuth();
    const now = Date.now();
    const session = auth.createSession(now - 13 * 60 * 60 * 1000); // minted 13h ago > 12h lifetime
    expect(auth.verifySession(session)).toBe(false);
  });

  it('rejects malformed cookies', () => {
    const auth = makeAuth();
    expect(auth.verifySession('not-a-cookie')).toBe(false);
    expect(auth.verifySession('a.b.c')).toBe(false);
    expect(auth.verifySession(undefined)).toBe(false);
  });

  it('reads the cookie from a request and authenticates', () => {
    const auth = makeAuth();
    const session = auth.createSession(Date.now());
    const req = { headers: { cookie: `other=1; wabiz_admin=${session}; foo=2` } };
    expect(auth.authenticated(req as never)).toBe(true);
    expect(auth.authenticated({ headers: { cookie: 'wabiz_admin=forged' } } as never)).toBe(false);
    expect(auth.authenticated({ headers: {} } as never)).toBe(false);
  });
});