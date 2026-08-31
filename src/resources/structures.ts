import type { HttpTransport } from '../transport/http.js';
import type {
  AssignDocumentRequest,
  AssignDocumentResponse,
  CorpusStructure,
  RerunStructureRequest,
  RerunStructureResponse,
  StructurePack,
  StructureTray,
} from '../types/structures.js';

/**
 * Pack Builder: the structure of a corpus organised into packs.
 *
 * Requires Sercha 0.16.3 or newer, and every method here is admin-gated: a
 * default service account receives 403 on all of them. An application that
 * embeds pack review should degrade gracefully on 403 — hide the surface —
 * rather than surface it as a fault, because the same application often runs
 * under both admin and non-admin credentials.
 *
 * A corpus that does not organise by structure answers 409 (as an ordinary
 * SerchaHttpError with the envelope's code). That is a property of the corpus,
 * not a transient fault: do not retry it, route the user elsewhere.
 */
export class StructuresResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * The corpus's pack tree and overall state.
   *
   * Check `structure_state` before treating the counts as settled: `grouping`
   * means the agent is still placing documents, and a review UI rendered from
   * a moving structure shows numbers that are stale by the time they paint.
   */
  async structure(corpusId: string, signal?: AbortSignal): Promise<CorpusStructure> {
    const response = await this.http.request<CorpusStructure>(
      `/api/v1/corpuses/${encodeURIComponent(corpusId)}/structure`,
      signal ? { signal } : {},
    );
    // List endpoints return JSON null rather than [] when empty, and packs
    // nest recursively, so normalise the whole tree once here instead of
    // making every consumer null-check every level.
    return { ...response, packs: normalisePacks(response.packs) };
  }

  /**
   * Documents the agent could not place: the human review queue.
   *
   * `groupBy: 'candidate'` also returns the entries grouped by their candidate
   * pack, which is the shape a review UI renders; ungrouped entries remain in
   * `entries` either way, so consumers that ignore grouping keep working.
   */
  async structureTray(
    corpusId: string,
    opts?: { groupBy?: 'candidate' },
    signal?: AbortSignal,
  ): Promise<StructureTray> {
    const response = await this.http.request<StructureTray>(
      `/api/v1/corpuses/${encodeURIComponent(corpusId)}/structure/tray`,
      {
        ...(opts?.groupBy ? { query: { group_by: opts.groupBy } } : {}),
        ...(signal ? { signal } : {}),
      },
    );
    return {
      ...response,
      entries: response.entries ?? [],
      ...(response.groups !== undefined ? { groups: response.groups ?? [] } : {}),
    };
  }

  /**
   * Place a document in a pack, as the authenticated human.
   *
   * This locks the assignment: the agent will not move the document on a later
   * rerun, so a human decision is never silently undone. Another human can
   * re-assign it, which keeps the lock. The response's `partition_key` is the
   * `_folder` value the document's rows carry in queries from now on.
   */
  async assignDocument(
    corpusId: string,
    req: AssignDocumentRequest,
    signal?: AbortSignal,
  ): Promise<AssignDocumentResponse> {
    return this.http.request<AssignDocumentResponse>(
      `/api/v1/corpuses/${encodeURIComponent(corpusId)}/structure/assignments`,
      { method: 'POST', body: req, ...(signal ? { signal } : {}) },
    );
  }

  /**
   * Ask the agent to regroup, optionally scoped to specific documents.
   *
   * Locked (human-made) assignments are left untouched, so rerunning after a
   * review session cannot undo the review. Returns the queued run; poll it
   * with waitForRun() if completion matters.
   */
  async rerunStructure(
    corpusId: string,
    req: RerunStructureRequest = {},
    signal?: AbortSignal,
  ): Promise<RerunStructureResponse> {
    return this.http.request<RerunStructureResponse>(
      `/api/v1/corpuses/${encodeURIComponent(corpusId)}/structure/rerun`,
      { method: 'POST', body: req, ...(signal ? { signal } : {}) },
    );
  }
}

function normalisePacks(packs: StructurePack[] | null | undefined): StructurePack[] {
  return (packs ?? []).map((pack) => ({ ...pack, children: normalisePacks(pack.children) }));
}
