# Recorded live WaaS responses

Attested responses recorded by `pnpm test:live` (`scripts/live-acceptance.ts`). Copy the files you want to keep from `.data/live-fixtures/` into this directory; `tests/live-fixtures.test.ts` verifies each one's attestation offline, bound to its recorded request and response. Calls that carry the ID token are never recorded.
