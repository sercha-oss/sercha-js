/** Catalogue types: discovery of what a token can query. */

export interface CatalogueNameItem {
  id?: string;
  name: string;
}

export interface CatalogueEntityType {
  /** What you write in `FROM corpus.<name>`. */
  name: string;
  display_name: string;
  is_root: boolean;
}

export interface CatalogueProperty {
  name: string;
  type: string;
  /** True for server-managed columns such as _id and _doc. */
  system: boolean;
  key?: boolean;
  required?: boolean;
  enum_values?: string[];
}

export interface CatalogueTreeOntology {
  id: string;
  name: string;
  has_children: boolean;
}

export interface CatalogueTreeCorpus {
  id: string;
  name: string;
  bindings: Array<{ ontology_id: string }>;
}

export interface CatalogueTreePipeline {
  id: string;
  name: string;
  type: string;
  corpus_id: string;
}

export interface CatalogueTree {
  ontologies: CatalogueTreeOntology[];
  corpuses: CatalogueTreeCorpus[];
  pipelines: CatalogueTreePipeline[];
}
