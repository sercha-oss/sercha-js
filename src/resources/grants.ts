import type { HttpTransport } from '../transport/http.js';
import type {
  CheckGrantRequest,
  CheckGrantResponse,
  CreateGrantRequest,
  Grant,
  ListGrantsFilter,
} from '../types/grants.js';

/**
 * Grants: who may do what to which corpus, partition, source, binding,
 * pipeline or ledger.
 *
 * Creating, listing, reading and deleting grants are **admin** operations: a
 * default service account receives 403 on all four, and an application that
 * embeds a grant editor should hide it on 403 rather than fault. `check()`
 * needs only an authenticated token and always answers for the caller
 * itself.
 *
 * Object kinds: `corpus`, `binding`, `pipeline`, `ledger`, `partition`
 * (object id `<corpus id>:<key>`, see `partitionObjectId()`) and `source`.
 * Actions: `select`, `use`, `admin`, `annotate`, `curate` and `write`. A
 * value outside either vocabulary answers 400, never a silently dead grant.
 */
export class GrantsResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Create a grant. Requires the **admin** role.
   *
   * For a partition grant, build the object id with `partitionObjectId()`:
   * a grant on the whole corpus wins over any partition grant, and a subject
   * holding only partition grants sees those partitions plus the global
   * documents (key `''`).
   */
  async create(req: CreateGrantRequest, signal?: AbortSignal): Promise<Grant> {
    return this.http.request<Grant>('/api/v1/grants', {
      method: 'POST',
      body: req,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List grants matching the filter. Requires the **admin** role.
   *
   * Every filter field is optional; an empty filter lists every grant.
   */
  async list(filter: ListGrantsFilter = {}, signal?: AbortSignal): Promise<Grant[]> {
    const query: Record<string, string> = {};
    if (filter.subject_kind !== undefined) query.subject_kind = filter.subject_kind;
    if (filter.subject_id !== undefined) query.subject_id = filter.subject_id;
    if (filter.action !== undefined) query.action = filter.action;
    if (filter.object_kind !== undefined) query.object_kind = filter.object_kind;
    if (filter.object_id !== undefined) query.object_id = filter.object_id;
    const grants = await this.http.request<Grant[] | null>('/api/v1/grants', {
      ...(Object.keys(query).length ? { query } : {}),
      ...(signal ? { signal } : {}),
    });
    // List endpoints return JSON null rather than [] when empty.
    return grants ?? [];
  }

  /** One grant by id. Requires the **admin** role; 404 when absent. */
  async get(id: string, signal?: AbortSignal): Promise<Grant> {
    return this.http.request<Grant>(`/api/v1/grants/${encodeURIComponent(id)}`, {
      ...(signal ? { signal } : {}),
    });
  }

  /** Delete a grant by id. Requires the **admin** role; 404 when absent. */
  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<void>(`/api/v1/grants/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Does the calling token hold the action on the object, directly or through
   * a group? Any authenticated token; the subject is always the caller, so
   * this cannot probe another user's grants.
   */
  async check(req: CheckGrantRequest, signal?: AbortSignal): Promise<CheckGrantResponse> {
    return this.http.request<CheckGrantResponse>('/api/v1/grants/check', {
      query: { action: req.action, object_kind: req.object_kind, object_id: req.object_id },
      ...(signal ? { signal } : {}),
    });
  }
}
