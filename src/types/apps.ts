/**
 * App access types: the end-user access switch, shares, invites and guest
 * links of a published app.
 *
 * Field names are the wire shape verbatim (snake_case), as everywhere else in
 * this client.
 *
 * Roles on an app: `owner` (whoever created it), `edit` and `use`. The access
 * switch, guest links, shares and invites are all edit-role writes (the owner
 * counts as an editor); a use-role sharee gets 403, and an application that
 * runs under both should hide the surface rather than fault.
 */

/** A share's role. `owner` is never granted through a share. */
export type AppShareRole = 'edit' | 'use';

/** The caller's role on an app, as `App.role` reports it. */
export type AppRole = 'owner' | AppShareRole;

/**
 * An app as the server returns it. Deliberately open: the definition and the
 * fields around it change between server versions, and a closed type would
 * hide them behind a client release. The named fields are the ones an
 * application can rely on.
 */
export interface App {
  id: string;
  name: string;
  corpus: string;
  status: string;
  /** The rendered definition at `served_version`. Shape is server-defined. */
  definition: unknown;
  definition_version: number;
  created_by: string;
  created_by_name: string;
  /** RFC3339. */
  created_at: string;
  /** RFC3339. */
  updated_at: string;
  role: AppRole;
  /** Who shared it with the caller; absent for the owner. */
  shared_by_name?: string;
  /** Null while unpublished. */
  published_version: number | null;
  /** The version of `definition` this caller was served. */
  served_version: number;
  is_published: boolean;
  /** Null while unset. */
  scope: { corpus: string; partitions: string[] } | null;
  [key: string]: unknown;
}

/**
 * The end-user access switch.
 *
 * - `team`: signed-in members with a share.
 * - `invited`: only people invited by email.
 * - `link`: anyone holding the link token (and its password, if set).
 * - `public`: anyone.
 *
 * Link and public serve nothing until the app is published.
 */
export type AppAccessMode = 'team' | 'invited' | 'link' | 'public';

/** GET/PUT /api/v1/apps/{id}/access. The password hash is never returned. */
export interface AppAccess {
  mode: AppAccessMode;
  /** Present in link mode: the `k` of `/a/{id}?k=<token>`. */
  link_token?: string;
  has_password: boolean;
  require_nda: boolean;
}

/** PUT /api/v1/apps/{id}/access. */
export interface SetAppAccessRequest {
  mode: AppAccessMode;
  /**
   * Link-mode password. An empty string (or omitting it) clears any existing
   * password; a password outside link mode is refused with 400.
   */
  password?: string;
  /**
   * Accepted by the server and echoed back, but not yet enforced: the NDA
   * gate is a future server feature. Setting it today changes nothing a
   * viewer sees.
   */
  require_nda?: boolean;
}

/**
 * A guest link: the invite an app makes to a person with no Sercha account.
 * `url` is relative (`/a/{app}?g=<token>`); prefix it with the app's origin.
 */
export interface GuestLink {
  id: string;
  app_id: string;
  /** Who the link is for. */
  label: string;
  /** The partition the link is scoped to; absent when it covers the corpus. */
  partition?: string;
  url: string;
  created_by: string;
  /** RFC3339. */
  created_at: string;
  /** RFC3339; absent when the link does not expire. */
  expires_at?: string;
  /** RFC3339; present once revoked. A revoked link stays on record. */
  revoked_at?: string;
  /** Not revoked and not expired. */
  active: boolean;
}

/** POST /api/v1/apps/{id}/guests. */
export interface CreateGuestLinkRequest {
  /** Who the link is for. Shown to editors, never to the guest. */
  label: string;
  /** A partition key of the app's corpus. Omit to scope the link to the whole corpus. */
  partition?: string;
  /** 0 or omitted means no expiry. At most 3650. */
  expires_in_days?: number;
}

/** GET /api/v1/apps/{id}/guests. */
export interface GuestLinksResponse {
  guests: GuestLink[];
}

/** POST /api/v1/apps/{id}/guests/{link_id}/promote. */
export interface PromoteGuestRequest {
  email: string;
  name: string;
}

/**
 * The query string of GET /a/{id}: a guest link token (`g`), or a link token
 * (`k`) with its password (`p`), or nothing for a public app.
 */
export interface OpenAppLinkParams {
  /** Link token: the access switch's `link_token`. */
  k?: string;
  /** Link password, when one is set. */
  p?: string;
  /** Guest link token: the `g` of a GuestLink's url. */
  g?: string;
}

/**
 * GET /a/{id}: the app at its served version and a 12-hour bearer token
 * scoped to that one app. Present the token as an ordinary Authorization
 * header (`auth: { token }`) on the read-only app routes; every other route
 * refuses it.
 */
export interface OpenAppLinkResponse {
  app: App;
  session_token: string;
}

/** A share as the server returns it. */
export interface AppShare {
  id: string;
  subject_kind: 'user' | 'group';
  subject_id: string;
  subject_name: string;
  role: AppShareRole;
  /** RFC3339. */
  created_at: string;
}

/** POST /api/v1/apps/{id}/shares. Sharing again with the same subject changes its role. */
export interface CreateAppShareRequest {
  subject_kind: 'user' | 'group';
  subject_id: string;
  role: AppShareRole;
}

/**
 * POST /api/v1/apps/{id}/shares response: the share plus warnings, which
 * name a subject that lacks select on the app's corpus. A share does not
 * grant the corpus; such a sharee opens the app and sees no rows.
 */
export interface CreateAppShareResponse extends AppShare {
  warnings: string[];
}

/** GET /api/v1/apps/{id}/shares. */
export interface AppSharesResponse {
  shares: AppShare[];
}

/** POST /api/v1/apps/{id}/invites. */
export interface InviteAppUserRequest {
  email: string;
  name: string;
  role: AppShareRole;
}

/** The invited person. */
export interface AppInviteUser {
  id: string;
  email: string;
  name: string;
  seat_type: string;
  /** True when the invite created the person (an app_user seat). */
  created: boolean;
}

/**
 * POST /api/v1/apps/{id}/invites and .../guests/{link_id}/promote response.
 *
 * No email is sent: `set_password_url` is a one-time link, valid 7 days, for
 * a person the invite created, and null for someone who already had a
 * login. Whoever invited passes it on.
 */
export interface AppInviteResponse {
  user: AppInviteUser;
  share: AppShare;
  set_password_url: string | null;
}
