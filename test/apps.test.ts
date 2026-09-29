import { describe, expect, it } from 'vitest';
import type { AppShare, GuestLink } from '../src/types/apps.js';
import {
  apiCalls,
  json,
  mockFetch,
  requestBody,
  requestHeaders,
  requestUrl,
  testClient as clientWith,
  tokenCalls,
} from './helpers.js';

function guestLink(over: Partial<GuestLink> = {}): GuestLink {
  return {
    id: 'gl-1',
    app_id: 'app-1',
    label: 'Tenant A reviewer',
    partition: 'room/tenant a',
    url: '/a/app-1?g=tok-guest',
    created_by: 'editor-1',
    created_at: '2026-09-01T00:00:00Z',
    active: true,
    ...over,
  };
}

function share(over: Partial<AppShare> = {}): AppShare {
  return {
    id: 'sh-1',
    subject_kind: 'user',
    subject_id: 'u-2',
    subject_name: 'Dana',
    role: 'use',
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

const access = { mode: 'link', link_token: 'tok-link', has_password: true, require_nda: false };

describe('apps.access', () => {
  it('reads the switch', async () => {
    const fetchImpl = mockFetch(json(access));
    const result = await clientWith(fetchImpl).apps.access.get('app-1');
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/access');
    expect(init?.method).toBe('GET');
    expect(result.link_token).toBe('tok-link');
  });

  it('puts the mode and password', async () => {
    const fetchImpl = mockFetch(json(access));
    await clientWith(fetchImpl).apps.access.set('app-1', { mode: 'link', password: 'hunter2' });
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/access');
    expect(init?.method).toBe('PUT');
    expect(requestBody(fetchImpl)).toEqual({ mode: 'link', password: 'hunter2' });
  });

  it('rotates the link token', async () => {
    const fetchImpl = mockFetch(json({ ...access, link_token: 'tok-new' }));
    const result = await clientWith(fetchImpl).apps.access.rotate('app-1');
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/access/rotate');
    expect(init?.method).toBe('POST');
    expect(result.link_token).toBe('tok-new');
  });
});

describe('apps.guests', () => {
  it('lists guest links from the envelope', async () => {
    const fetchImpl = mockFetch(json({ guests: [guestLink()] }));
    const links = await clientWith(fetchImpl).apps.guests.list('app-1');
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/api/v1/apps/app-1/guests');
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe('/a/app-1?g=tok-guest');
  });

  it('coalesces a null guest list', async () => {
    const fetchImpl = mockFetch(json({ guests: null }));
    expect(await clientWith(fetchImpl).apps.guests.list('app-1')).toEqual([]);
  });

  it('mints a guest link with label, partition and expiry', async () => {
    const fetchImpl = mockFetch(json(guestLink(), 201));
    const link = await clientWith(fetchImpl).apps.guests.create('app-1', {
      label: 'Tenant A reviewer',
      partition: 'room/tenant a',
      expires_in_days: 30,
    });
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/guests');
    expect(init?.method).toBe('POST');
    expect(requestBody(fetchImpl)).toEqual({
      label: 'Tenant A reviewer',
      partition: 'room/tenant a',
      expires_in_days: 30,
    });
    expect(link.active).toBe(true);
  });

  it('revokes a guest link and returns it on record', async () => {
    const fetchImpl = mockFetch(
      json(guestLink({ active: false, revoked_at: '2026-09-02T00:00:00Z' })),
    );
    const link = await clientWith(fetchImpl).apps.guests.revoke('app-1', 'gl-1');
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/guests/gl-1');
    expect(init?.method).toBe('DELETE');
    expect(link.active).toBe(false);
  });

  it('promotes a guest with email and name', async () => {
    const fetchImpl = mockFetch(
      json(
        {
          user: { id: 'u-9', email: 'a@x.com', name: 'A', seat_type: 'app_user', created: true },
          share: share({ subject_id: 'u-9' }),
          set_password_url: 'https://sercha.test/set-password/?token=t',
        },
        201,
      ),
    );
    const invite = await clientWith(fetchImpl).apps.guests.promote('app-1', 'gl-1', {
      email: 'a@x.com',
      name: 'A',
    });
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/guests/gl-1/promote');
    expect(init?.method).toBe('POST');
    expect(requestBody(fetchImpl)).toEqual({ email: 'a@x.com', name: 'A' });
    expect(invite.user.created).toBe(true);
    expect(invite.set_password_url).toContain('set-password');
  });
});

describe('apps.openLink', () => {
  it('opens a guest link with no bearer token and no token exchange', async () => {
    const fetchImpl = mockFetch(json({ app: { id: 'app-1' }, session_token: 'sess' }));
    const opened = await clientWith(fetchImpl).apps.openLink('app-1', { g: 'tok-guest' });

    const url = new URL(requestUrl(fetchImpl));
    expect(url.pathname).toBe('/a/app-1');
    expect(url.searchParams.get('g')).toBe('tok-guest');
    expect(url.searchParams.has('k')).toBe(false);
    expect(apiCalls(fetchImpl)[0]![1]?.method).toBe('GET');
    expect(requestHeaders(fetchImpl).Authorization).toBeUndefined();
    expect(tokenCalls(fetchImpl)).toHaveLength(0);
    expect(opened.session_token).toBe('sess');
  });

  it('passes a link token and password', async () => {
    const fetchImpl = mockFetch(json({ app: { id: 'app-1' }, session_token: 'sess' }));
    await clientWith(fetchImpl).apps.openLink('app-1', { k: 'tok-link', p: 'hunter2' });
    const url = new URL(requestUrl(fetchImpl));
    expect(url.searchParams.get('k')).toBe('tok-link');
    expect(url.searchParams.get('p')).toBe('hunter2');
  });

  it('opens a public app with no query at all', async () => {
    const fetchImpl = mockFetch(json({ app: { id: 'app-1' }, session_token: 'sess' }));
    await clientWith(fetchImpl).apps.openLink('app-1');
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/a/app-1');
  });
});

describe('apps.shares', () => {
  it('lists shares from the envelope', async () => {
    const fetchImpl = mockFetch(json({ shares: [share()] }));
    const shares = await clientWith(fetchImpl).apps.shares.list('app-1');
    expect(requestUrl(fetchImpl)).toBe('https://sercha.test/api/v1/apps/app-1/shares');
    expect(shares[0]?.subject_name).toBe('Dana');
  });

  it('creates a share and always returns a warnings array', async () => {
    const fetchImpl = mockFetch(json({ ...share(), warnings: null }, 201));
    const created = await clientWith(fetchImpl).apps.shares.create('app-1', {
      subject_kind: 'user',
      subject_id: 'u-2',
      role: 'use',
    });
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/shares');
    expect(init?.method).toBe('POST');
    expect(requestBody(fetchImpl)).toEqual({
      subject_kind: 'user',
      subject_id: 'u-2',
      role: 'use',
    });
    expect(created.warnings).toEqual([]);
  });

  it('deletes a share and resolves on 204', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    await expect(
      clientWith(fetchImpl).apps.shares.delete('app-1', 'sh-1'),
    ).resolves.toBeUndefined();
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/shares/sh-1');
    expect(init?.method).toBe('DELETE');
  });
});

describe('apps.invite', () => {
  it('posts email, name and role', async () => {
    const fetchImpl = mockFetch(
      json(
        {
          user: { id: 'u-3', email: 'b@x.com', name: 'B', seat_type: 'full', created: false },
          share: share({ subject_id: 'u-3', role: 'edit' }),
          set_password_url: null,
        },
        201,
      ),
    );
    const invite = await clientWith(fetchImpl).apps.invite('app-1', {
      email: 'b@x.com',
      name: 'B',
      role: 'edit',
    });
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/invites');
    expect(init?.method).toBe('POST');
    expect(requestBody(fetchImpl)).toEqual({ email: 'b@x.com', name: 'B', role: 'edit' });
    expect(invite.set_password_url).toBeNull();
  });
});

describe('apps.invite with a partition', () => {
  it('sends the partition so the person is confined instead of granted the corpus', async () => {
    const fetchImpl = mockFetch(
      json(
        {
          user: { id: 'u-4', email: 'c@x.com', name: 'C', seat_type: 'app_user', created: true },
          share: share({ subject_id: 'u-4' }),
          set_password_url: 'https://sercha.test/set-password/?token=t',
        },
        201,
      ),
    );
    await clientWith(fetchImpl).apps.invite('app-1', {
      email: 'c@x.com',
      name: 'C',
      role: 'use',
      partition: 'room/tenant a',
    });
    expect(requestBody(fetchImpl)).toEqual({
      email: 'c@x.com',
      name: 'C',
      role: 'use',
      partition: 'room/tenant a',
    });
  });
});

describe('apps.confined', () => {
  const person = {
    subject_kind: 'user',
    subject_id: 'u-2',
    name: 'Dana',
    email: 'dana@x.com',
    keys: [{ key: 'room/tenant a', grant_id: 'g-1' }],
  };

  it('lists confined people from the envelope', async () => {
    const fetchImpl = mockFetch(json({ confined: [person] }));
    const people = await clientWith(fetchImpl).apps.confined.list('app-1');
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/confined');
    expect(init?.method).toBe('GET');
    expect(people[0]?.keys[0]?.grant_id).toBe('g-1');
  });

  it('coalesces a null list and null keys', async () => {
    const fetchImpl = mockFetch(json({ confined: null }));
    expect(await clientWith(fetchImpl).apps.confined.list('app-1')).toEqual([]);
    const fetchKeys = mockFetch(json({ confined: [{ ...person, keys: null }] }));
    expect((await clientWith(fetchKeys).apps.confined.list('app-1'))[0]?.keys).toEqual([]);
  });

  it('confines a user to a key', async () => {
    const fetchImpl = mockFetch(json(person, 201));
    const result = await clientWith(fetchImpl).apps.confined.add('app-1', {
      user_id: 'u-2',
      key: 'room/tenant a',
    });
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/confined');
    expect(init?.method).toBe('POST');
    expect(requestBody(fetchImpl)).toEqual({ user_id: 'u-2', key: 'room/tenant a' });
    expect(result.subject_id).toBe('u-2');
  });

  it('releases a key as a query parameter, encoding slashes', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    await expect(
      clientWith(fetchImpl).apps.confined.remove('app-1', 'u-2', 'room/tenant a'),
    ).resolves.toBeUndefined();
    const [url, init] = apiCalls(fetchImpl)[0]!;
    expect(init?.method).toBe('DELETE');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/apps/app-1/confined/u-2');
    expect(parsed.searchParams.get('key')).toBe('room/tenant a');
  });

  it('still sends the key parameter when the key is empty (the global partition)', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    await clientWith(fetchImpl).apps.confined.remove('app-1', 'u-2', '');
    const url = requestUrl(fetchImpl);
    expect(url).toBe('https://sercha.test/api/v1/apps/app-1/confined/u-2?key=');
    expect(new URL(url).searchParams.has('key')).toBe(true);
  });
});
