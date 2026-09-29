import type { HttpTransport } from '../transport/http.js';
import type {
  AppAccess,
  AppInviteResponse,
  AppShare,
  AppSharesResponse,
  CreateAppShareRequest,
  CreateAppShareResponse,
  CreateGuestLinkRequest,
  GuestLink,
  GuestLinksResponse,
  InviteAppUserRequest,
  OpenAppLinkParams,
  OpenAppLinkResponse,
  PromoteGuestRequest,
  SetAppAccessRequest,
} from '../types/apps.js';

function appPath(appId: string, suffix = ''): string {
  return `/api/v1/apps/${encodeURIComponent(appId)}${suffix}`;
}

/**
 * The end-user access switch of an app: team, invited, link or public.
 *
 * Every method needs the **edit** role on the app (the owner counts) and the
 * build entitlement; a use-role sharee gets 403. Link and public serve
 * nothing until the app is published.
 */
export class AppAccessResource {
  constructor(private readonly http: HttpTransport) {}

  /** The current switch, with the link token when in link mode. Edit role. */
  async get(appId: string, signal?: AbortSignal): Promise<AppAccess> {
    return this.http.request<AppAccess>(appPath(appId, '/access'), {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Set the mode and, for link mode, its password. Edit role.
   *
   * Switching to link for the first time mints a token, kept across later
   * mode changes so a shared link does not silently break. An empty or
   * omitted password clears any existing one.
   */
  async set(appId: string, req: SetAppAccessRequest, signal?: AbortSignal): Promise<AppAccess> {
    return this.http.request<AppAccess>(appPath(appId, '/access'), {
      method: 'PUT',
      body: req,
      ...(signal ? { signal } : {}),
    });
  }

  /** Replace the link token. The old one stops working immediately. Edit role. */
  async rotate(appId: string, signal?: AbortSignal): Promise<AppAccess> {
    return this.http.request<AppAccess>(appPath(appId, '/access/rotate'), {
      method: 'POST',
      body: {},
      ...(signal ? { signal } : {}),
    });
  }
}

/**
 * Guest links: invites an app makes to people with no Sercha account.
 *
 * Every read a guest makes runs as the app's owner narrowed by the link: the
 * owner's grants are the ceiling, the link's partition the floor. Minting,
 * listing, revoking and promoting need the **edit** role on the app.
 */
export class AppGuestsResource {
  constructor(private readonly http: HttpTransport) {}

  /** Every guest link of the app, revoked ones included. Edit role. */
  async list(appId: string, signal?: AbortSignal): Promise<GuestLink[]> {
    const response = await this.http.request<GuestLinksResponse>(appPath(appId, '/guests'), {
      ...(signal ? { signal } : {}),
    });
    return response.guests ?? [];
  }

  /**
   * Mint a guest link. Edit role; the app must be published.
   *
   * The returned `url` is relative (`/a/{app}?g=<token>`) and can be read
   * again from `list()`, so nothing is lost if this response is dropped.
   */
  async create(
    appId: string,
    req: CreateGuestLinkRequest,
    signal?: AbortSignal,
  ): Promise<GuestLink> {
    return this.http.request<GuestLink>(appPath(appId, '/guests'), {
      method: 'POST',
      body: req,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Revoke a guest link. Edit role.
   *
   * Session tokens minted from the link stop at their next request; the link
   * stays on record with `revoked_at` set.
   */
  async revoke(appId: string, linkId: string, signal?: AbortSignal): Promise<GuestLink> {
    return this.http.request<GuestLink>(appPath(appId, `/guests/${encodeURIComponent(linkId)}`), {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Turn a guest into a member. Edit role.
   *
   * The same outcome as `apps.invite()` with the link's scope: an app-user
   * seat (or the existing person, found by email), a use share on the app,
   * and a grant on the link's partition (a corpus grant when the link covered
   * the whole corpus). The link is revoked. No email is sent; pass
   * `set_password_url` on when it is non-null.
   */
  async promote(
    appId: string,
    linkId: string,
    req: PromoteGuestRequest,
    signal?: AbortSignal,
  ): Promise<AppInviteResponse> {
    return this.http.request<AppInviteResponse>(
      appPath(appId, `/guests/${encodeURIComponent(linkId)}/promote`),
      { method: 'POST', body: req, ...(signal ? { signal } : {}) },
    );
  }
}

/**
 * Shares: which users and groups hold edit or use on an app.
 *
 * Listing works for any role on the app. Creating needs the **edit** role;
 * deleting needs edit, except that a use sharee may remove their own share.
 */
export class AppSharesResource {
  constructor(private readonly http: HttpTransport) {}

  /** The app's shares with subject names. Any role on the app. */
  async list(appId: string, signal?: AbortSignal): Promise<AppShare[]> {
    const response = await this.http.request<AppSharesResponse>(appPath(appId, '/shares'), {
      ...(signal ? { signal } : {}),
    });
    return response.shares ?? [];
  }

  /**
   * Share the app with a user or group. Edit role. Sharing again with the
   * same subject changes its role.
   *
   * Read `warnings`: a share does not grant the app's corpus, and a subject
   * named there opens the app and sees no rows until they hold select on it
   * (see `grants.create()`).
   */
  async create(
    appId: string,
    req: CreateAppShareRequest,
    signal?: AbortSignal,
  ): Promise<CreateAppShareResponse> {
    const response = await this.http.request<CreateAppShareResponse>(appPath(appId, '/shares'), {
      method: 'POST',
      body: req,
      ...(signal ? { signal } : {}),
    });
    return { ...response, warnings: response.warnings ?? [] };
  }

  /** Remove a share. Edit role, or a use sharee removing their own. */
  async delete(appId: string, shareId: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<void>(appPath(appId, `/shares/${encodeURIComponent(shareId)}`), {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }
}

/**
 * The access surface of an app: who can open it and how.
 *
 * Grouped by concern: `access` is the end-user switch, `guests` the links
 * for people without an account, `shares` the members, and `invite()` the
 * by-email path that creates a seat. All of them are **edit**-role writes
 * on the app (listing shares is the exception, any role). `openLink()` is
 * the other side: what a viewer calls, with no token at all.
 */
export class AppsResource {
  readonly access: AppAccessResource;
  readonly guests: AppGuestsResource;
  readonly shares: AppSharesResource;

  constructor(private readonly http: HttpTransport) {
    this.access = new AppAccessResource(http);
    this.guests = new AppGuestsResource(http);
    this.shares = new AppSharesResource(http);
  }

  /**
   * Invite a person by email. Edit role.
   *
   * Creates an app-user seat when the email has no login (409 at the licence
   * cap), grants select on the app's corpus, shares the app with the role,
   * and returns a one-time set-password link valid 7 days for a created
   * person (null for someone who already had a login). No email is sent.
   */
  async invite(
    appId: string,
    req: InviteAppUserRequest,
    signal?: AbortSignal,
  ): Promise<AppInviteResponse> {
    return this.http.request<AppInviteResponse>(appPath(appId, '/invites'), {
      method: 'POST',
      body: req,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Open a link, guest or public app: GET /a/{id}. No bearer token is sent;
   * the credential is the query (`g` for a guest link, `k` and `p` for a
   * link, nothing for a public app).
   *
   * Returns the app at its served version and a 12-hour `session_token`
   * scoped to that app. A viewer runtime then constructs a client with
   * `auth: { token: session_token }` for the read-only app routes; every
   * other route refuses that token. A wrong token, wrong password or
   * unpublished app answers 404, deliberately indistinguishable from a
   * missing app.
   */
  async openLink(
    appId: string,
    params: OpenAppLinkParams = {},
    signal?: AbortSignal,
  ): Promise<OpenAppLinkResponse> {
    const query: Record<string, string> = {};
    if (params.g !== undefined) query.g = params.g;
    if (params.k !== undefined) query.k = params.k;
    if (params.p !== undefined) query.p = params.p;
    return this.http.request<OpenAppLinkResponse>(`/a/${encodeURIComponent(appId)}`, {
      auth: false,
      ...(Object.keys(query).length ? { query } : {}),
      ...(signal ? { signal } : {}),
    });
  }
}
