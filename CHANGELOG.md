# Changelog

## 1.0.0

Breaking: removed search(); the Sercha API no longer provides search.

- Removed `search()` from `SerchaClient`, the `Sercha` interface and `StubSercha`, along with the stub's `search` option.
- Removed the `SearchRequest`, `SearchResponse` and `SearchResultItem` types.
- `SearchResource` is renamed `DocumentsResource`. It keeps `getDocument`, `listSources`, `getSource` and `listSourceDocuments`, and is still available as `client.documents`.
- `Document`, `Source` and `SourceDocumentsPage` are unchanged and still exported from the package root.

Read extracted data with `query()` and SerchaQL instead.
