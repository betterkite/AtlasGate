# Contributing

## Development contract

Use Node.js 24 and Python 3.11+ (the project has zero npm runtime dependencies; `package.json` only declares scripts). Preserve the existing boundaries between protocol conversion, model routing, knowledge governance (Change → merge → immutable Master, ADR-015 query sedimentation / skills retrieval), the Agent runtime, and the LLM Wiki compilation pipeline. Do not add a capability claim to `REFERENCE_MATRIX.md` without an automated test and a documented production boundary.

Current test baseline: **Node 92 tests / Python 19 tests** (`npm test` passes fully, see [TEST_REPORT.md](TEST_REPORT.md)). When adding or modifying features, update the test count accordingly and note it in the PR.

## Workflow

1. Describe the business rule and the scope of the change first (does it touch the ADR-015 memory / sedimentation / skills chain?).
2. Add or update tests before changing an acceptance claim.
3. Use `npm run test:node` and `python3 -m unittest discover -s python/tests -v`, depending on the environment.
4. For container changes, run `docker compose config`, build the image, and execute the deployment smoke workflow.
5. Update API, configuration, operations, and both language editions of the documentation when behavior changes.

Never commit `.env`, databases, Provider keys, or request data.

## Reproducible verification flow

After a change, run the full gate and a runtime smoke at least once (default port 4310, default credentials):

```bash
# 1) Full gate: Node syntax check + Node tests + Python tests
npm run check          # expect all Node 92 tests and Python 19 tests to pass

# 2) Startup smoke: run in a separate terminal
npm start
# 3) Health check and login (admin APIs always require a login cookie first)
curl http://127.0.0.1:4310/health
curl -c cookies.txt -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"atlasgate-admin"}'
curl -b cookies.txt http://127.0.0.1:4310/api/overview
```

When focusing on one feature block, you can run only the relevant test files (e.g., ADR-015 sedimentation / heat / skills retrieval):

```bash
node --test test/wiki-phase7.test.js test/wiki-phase8.test.js
```

## Code conventions

- Prefer ESM and the Node.js standard library.
- Keep Python inputs and outputs JSON serializable and UTF-8.
- Preserve Master, version, and audit evidence; modifications must create a governed Change.
- Return stable error codes through `HttpError`.
- Bound queues, uploads, retries, timeouts, and result sizes.
