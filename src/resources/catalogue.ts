import type { HttpTransport } from '../transport/http.js';
import type {
  CatalogueEntityType,
  CatalogueNameItem,
  CatalogueProperty,
  CatalogueTree,
} from '../types/catalogue.js';

/**
 * Catalogue: discovery of queryable objects.
 *
 * This is how an application learns what it can actually reach, rather than
 * hardcoding corpus and entity names that may not exist or may not be granted
 * to its token.
 */
export class CatalogueResource {
  constructor(private readonly http: HttpTransport) {}

  async corpuses(signal?: AbortSignal): Promise<CatalogueNameItem[]> {
    return this.getList('/api/v1/catalogue/corpuses', undefined, signal);
  }

  async ontologies(signal?: AbortSignal): Promise<CatalogueNameItem[]> {
    return this.getList('/api/v1/catalogue/ontologies', undefined, signal);
  }

  /**
   * Entity types in a corpus.
   *
   * `name` is what goes in `FROM corpus.<name>`; `display_name` is for humans
   * and is not addressable.
   */
  async entityTypes(corpusId: string, signal?: AbortSignal): Promise<CatalogueEntityType[]> {
    return this.getList('/api/v1/catalogue/entity-types', { corpus_id: corpusId }, signal);
  }

  /**
   * Properties of an entity type.
   *
   * The only real schema this API exposes. Use it to validate that a column a
   * query depends on exists and is non-nullable, rather than discovering at
   * runtime that it is always absent.
   */
  async entityProperties(
    corpusId: string,
    entityType: string,
    signal?: AbortSignal,
  ): Promise<CatalogueProperty[]> {
    return this.getList(
      '/api/v1/catalogue/entity-properties',
      { corpus_id: corpusId, entity_type: entityType },
      signal,
    );
  }

  /**
   * The full catalogue tree.
   *
   * With `queryable` set, corpuses are filtered by the caller's grants, making
   * this the authoritative answer to "what can this token query" — a corpus
   * absent here will fail at query time regardless of whether it exists.
   */
  async tree(options: { queryable?: boolean } = {}, signal?: AbortSignal): Promise<CatalogueTree> {
    const response = await this.http.request<{
      ontologies: CatalogueTree['ontologies'] | null;
      corpuses: CatalogueTree['corpuses'] | null;
      pipelines: CatalogueTree['pipelines'] | null;
    }>('/api/v1/catalogue/tree', {
      ...(options.queryable ? { query: { queryable: 'true' } } : {}),
      ...(signal ? { signal } : {}),
    });

    return {
      ontologies: response.ontologies ?? [],
      corpuses: (response.corpuses ?? []).map((corpus) => ({
        ...corpus,
        bindings: corpus.bindings ?? [],
      })),
      pipelines: response.pipelines ?? [],
    };
  }

  /** Resolve a corpus name to its ID. Returns undefined when not found or not granted. */
  async findCorpus(name: string, signal?: AbortSignal): Promise<CatalogueNameItem | undefined> {
    const corpuses = await this.corpuses(signal);
    return corpuses.find((corpus) => corpus.name === name);
  }

  private async getList<T>(
    path: string,
    query?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const list = await this.http.request<T[] | null>(path, {
      ...(query ? { query } : {}),
      ...(signal ? { signal } : {}),
    });
    // These endpoints return JSON null rather than [] when empty.
    return list ?? [];
  }
}
