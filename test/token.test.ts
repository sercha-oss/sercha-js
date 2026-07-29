import { describe, expect, it, vi } from 'vitest';
import { TokenManager } from '../src/auth/token.js';
import { resolveConfig } from '../src/config.js';
import { SerchaAuthError } from '../src/transport/errors.js';

function tokenResponse(token: string, expiresIn = 900): Response {
  return new Response(
    JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function managerWith(fetchImpl: ReturnType<typeof vi.fn>) {
  return new TokenManager(
    resolveConfig({
      baseUrl: 'https://sercha.test',
      auth: { clientId: 'id', clientSecret: 'secret' },
      fetch: fetchImpl as never,
    }),
  );
}

describe('TokenManager', () => {
  it('mints a token with the client_credentials grant', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    expect(await managerWith(fetchImpl).getToken()).toBe('tok-1');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sercha.test/oauth/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('id');
    expect(body.get('client_secret')).toBe('secret');
  });

  it('requests the default scopes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok'));
    await managerWith(fetchImpl).getToken();
    const body = new URLSearchParams(
      (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.get('scope')).toBe('query:read genie:use');
  });

  it('requests explicitly configured scopes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok'));
    const manager = new TokenManager(
      resolveConfig({
        baseUrl: 'https://sercha.test',
        auth: { clientId: 'id', clientSecret: 'secret', scopes: ['mcp:search'] },
        fetch: fetchImpl as never,
      }),
    );
    await manager.getToken();
    const body = new URLSearchParams(
      (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.get('scope')).toBe('mcp:search');
  });

  it('caches a token across calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok'));
    const manager = managerWith(fetchImpl);

    await manager.getToken();
    await manager.getToken();
    await manager.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Without single-flight, N concurrent callers each mint a token and the
  // responses race to overwrite the cache.
  it('coalesces concurrent refreshes into one request', async () => {
    let resolveResponse: (r: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchImpl = vi.fn().mockReturnValue(pending);
    const manager = managerWith(fetchImpl);

    const all = Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
    resolveResponse(tokenResponse('tok'));

    expect(await all).toEqual(['tok', 'tok', 'tok']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // A token whose remaining life is inside the 60s safety margin is treated as
  // already expired, so it is replaced before it can 401 in flight.
  it('refreshes proactively inside the expiry margin, without waiting for a 401', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('first', 30))
      .mockResolvedValueOnce(tokenResponse('second', 900));
    const manager = managerWith(fetchImpl);

    expect(await manager.getToken()).toBe('first');
    expect(await manager.getToken()).toBe('second');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a token whose remaining life is outside the margin', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('first', 900))
      .mockResolvedValueOnce(tokenResponse('second', 900));
    const manager = managerWith(fetchImpl);

    expect(await manager.getToken()).toBe('first');
    expect(await manager.getToken()).toBe('first');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a missing expires_in as a short life rather than an immortal token', async () => {
    // A fresh Response per call: a body can only be consumed once.
    const fetchImpl = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const manager = managerWith(fetchImpl);

    // 60s default minus the 60s margin clamps to 0, so the next call refreshes
    // rather than reusing a token of unknown validity.
    expect(await manager.getToken()).toBe('tok');
    expect(await manager.getToken()).toBe('tok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('mints a fresh token after invalidate()', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('first'))
      .mockResolvedValueOnce(tokenResponse('second'));
    const manager = managerWith(fetchImpl);

    expect(await manager.getToken()).toBe('first');
    manager.invalidate();
    expect(await manager.getToken()).toBe('second');
  });

  it('recovers after a failed refresh rather than caching the failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_client' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(tokenResponse('recovered'));
    const manager = managerWith(fetchImpl);

    await expect(manager.getToken()).rejects.toThrow(SerchaAuthError);
    expect(await manager.getToken()).toBe('recovered');
  });

  it('surfaces the OAuth error code and description', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'invalid_scope', error_description: 'unknown scope foo' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(managerWith(fetchImpl).getToken()).rejects.toMatchObject({
      oauthError: 'invalid_scope',
      status: 400,
      message: 'invalid_scope: unknown scope foo',
    });
  });

  it('rejects a 200 that carries no access_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(managerWith(fetchImpl).getToken()).rejects.toThrow(/no access_token/);
  });

  it('returns a static token without contacting the token endpoint', async () => {
    const fetchImpl = vi.fn();
    const manager = new TokenManager(
      resolveConfig({
        baseUrl: 'https://sercha.test',
        auth: { token: 'preexisting' },
        fetch: fetchImpl as never,
      }),
    );

    expect(await manager.getToken()).toBe('preexisting');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
