# @sercha-ai/client

TypeScript client for the [Sercha Enterprise](https://sercha.dev) API.

```bash
npm install @sercha-ai/client
```

Node 18+. ESM and CommonJS. No runtime dependencies.

## Quick start

```ts
import { SerchaClient } from '@sercha-ai/client';

const sercha = new SerchaClient({
  baseUrl: process.env.SERCHA_BASE_URL!,
  auth: {
    clientId: process.env.SERCHA_CLIENT_ID!,
    clientSecret: process.env.SERCHA_CLIENT_SECRET!,
  },
});

const { rows } = await sercha.query('SELECT _id, status FROM claims.Claim');
```

Credentials come from a Sercha service account: an admin creates one under
**Settings → Service Accounts**, and the secret is shown once. The client
exchanges them for a short-lived access token and refreshes it automatically.

Construct the client **once** and share it. It caches tokens, so building one
per request mints a new token every time.

## Querying

`query()` runs one SerchaQL statement.

```ts
interface Claim {
  _id: string;
  claim_id: string;
  status: string;
  days_open: number;
}

const { rows, stats, columns } = await sercha.query<Claim>(
  'SELECT _id, claim_id, status, days_open FROM claims.Claim WHERE status = "open"',
);
```

The type parameter asserts the row shape. It is not validated at runtime: the
server sends no schema, so there is nothing to check against. Use
`catalogue.entityProperties()` if you need the real schema.

### Large result sets

The API has no HTTP pagination and applies a 30-second deadline to the query
endpoint, so a single unbounded `SELECT` over a large entity will fail rather
than stream. `paginate()` pages in-language:

```ts
for await (const claim of sercha.paginate<Claim>(
  'SELECT _id, status FROM claims.Claim ORDER BY _id',
)) {
  await handle(claim);
}
```

**The statement must have an `ORDER BY`.** Paging with `OFFSET` over an
unordered result is not stable: rows move between pages, so some come back
twice and others never arrive. This is silent, so the client rejects an
unordered statement rather than letting it through. Order by something unique,
usually `_id`.

`all()` collects into an array; `one()` runs a statement expected to return
exactly one row and throws otherwise.

### Plugin confirmation

A statement calling an enrichment plugin may exceed a soft call limit. The
server answers 202 rather than running it, and the client raises:

```ts
import { PluginConfirmationRequiredError } from '@sercha-ai/client';

try {
  await sercha.query('SELECT enrich(abn) FROM suppliers.Supplier');
} catch (error) {
  if (error instanceof PluginConfirmationRequiredError) {
    console.log(`${error.estimate.uncached_calls} calls, about ` +
                `${error.estimate.estimated_wait_seconds}s`);
    await sercha.query('SELECT enrich(abn) FROM suppliers.Supplier', { confirm: true });
  }
}
```

Ignoring this error means the query silently never runs.

## Genie

Genie is the conversational agent. Turns stream over one held-open connection;
there is no run ID to poll.

```ts
const { id } = await sercha.genie.createConversation('Q3 review');

for await (const event of sercha.stream(id, 'which claims breached SLA?')) {
  if (event.type === 'thinking') process.stdout.write('.');
  if (event.type === 'answer') console.log(event.text);
}
```

`ask()` accumulates a whole turn when the progress is not needed:

```ts
const result = await sercha.ask(id, 'which claims breached SLA?');
console.log(result.text);
console.log(result.queries.map((q) => q.serchaql));
```

`result.kind` is `answer`, `question` or `error`. A `question` means Genie
needs clarification before it can answer — send another turn.

If the connection drops mid-turn the events are lost, but the turn is persisted
server-side; `getConversation()` recovers what it produced.

## Runs

```ts
const run = await sercha.waitForRun(runId, { timeoutMs: 900_000 });
if (run.status === 'failed') throw new Error(run.error);
```

`waitForRun()` returns a failed run rather than throwing, because failure is an
outcome to inspect. It throws `SerchaRunTimeoutError` only when the budget
expires, and the run keeps executing server-side in that case.

Triggering runs (`runs.trigger()`) requires an **admin** token. A default
service account can read runs but not start them.

## Discovery

```ts
const tree = await sercha.catalogueTree({ queryable: true });
console.log(tree.corpuses.map((c) => c.name));
```

With `queryable`, corpuses are filtered by the token's grants — the
authoritative answer to what this token can query. A corpus missing here will
fail at query time whether or not it exists.

## Testing

`@sercha-ai/client/testing` provides an in-memory implementation of the same
interface, for development without a running Sercha and for tests that should
not touch the network.

```ts
import type { Sercha } from '@sercha-ai/client';
import { StubSercha } from '@sercha-ai/client/testing';

const sercha: Sercha = new StubSercha({
  queries: {
    'SELECT _id, status FROM claims.Claim ORDER BY _id': [
      { _id: '1', status: 'open' },
      { _id: '2', status: 'closed' },
    ],
  },
});
```

An unconfigured statement throws rather than returning empty: an empty result
and a missing fixture are different situations, and conflating them lets a test
pass against a stub that was never asked what the code actually queries. Supply
`onQuery` for a catch-all. `stub.executed` records every statement run, for
asserting what the code queried.

Type your application against the `Sercha` interface rather than
`SerchaClient`, and the stub substitutes with no call-site changes.

## Configuration

```ts
new SerchaClient({
  baseUrl: 'https://api.acme.sercha.cloud',
  auth: { clientId, clientSecret, scopes: ['query:read', 'genie:use'] },
  timeoutMs: 35_000,        // per request; server deadline is 30s
  streamTimeoutMs: 300_000, // Genie turns; server budget is 5 min
  retry: { attempts: 3, baseDelayMs: 250, maxDelayMs: 10_000 },
  fetch: customFetch,       // defaults to globalThis.fetch
  headers: { 'X-Request-Id': id },
  userAgent: 'acme-app/1.2.3',
});
```

Pass `auth: { token }` instead if you manage the token lifecycle yourself.

Retries cover 429 and transient 5xx with exponential backoff and jitter, plus
one retry on 401 that re-mints the token first. 4xx and malformed responses are
not retried: replaying them cannot succeed and only delays the error.

## Errors

Everything extends `SerchaError`.

| Error | Meaning |
| --- | --- |
| `SerchaConfigError` | Unusable configuration; thrown from the constructor. |
| `SerchaAuthError` | Token exchange failed. Carries the OAuth error code. |
| `SerchaHttpError` | Non-2xx. Has `status`, and `code`/`objectRef` on query errors. |
| `SerchaDecodeError` | A 2xx whose body would not parse. |
| `SerchaTimeoutError` | Request exceeded its timeout. |
| `SerchaRunTimeoutError` | A run did not finish in the budget. It is still running. |
| `PluginConfirmationRequiredError` | Re-run with `confirm: true` to proceed. |

Query errors carry a structured reference to the object that failed:

```ts
catch (error) {
  if (error instanceof SerchaHttpError && error.code === 'corpus_not_found') {
    console.error(`No such corpus: ${error.objectRef?.ref}`);
  }
}
```

## Versioning

`0.x` — the Sercha API is still evolving and minor versions may contain
breaking changes. Pin exactly if that matters to you.

## Licence

[Apache 2.0](LICENSE). Copyright © 2026 Custodia Labs Pty Ltd
(ABN 89 688 480 391).

Support: support@sercha.dev
