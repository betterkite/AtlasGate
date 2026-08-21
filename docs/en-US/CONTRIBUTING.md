# Contributing

## Development contract

Use Node.js 24 and Python 3.11+. Preserve the boundaries between protocol conversion, routing, knowledge governance, and Agent runtime. Do not add a capability claim to `REFERENCE_MATRIX.md` without an automated test and a documented production boundary.

## Workflow

1. Describe the business rule and focused scope.
2. Add or update tests before changing an acceptance claim.
3. Run Node tests and Python tests with the executable available in the environment.
4. For container changes, validate Compose, build the image, and run the deployment smoke workflow.
5. Update API, configuration, operations, and both language editions when behavior changes.

Never commit `.env`, databases, Provider keys, or request data.

## Code conventions

- Use ESM and Node standard-library APIs unless a dependency removes substantial risk.
- Keep Python inputs and outputs JSON serializable and UTF-8.
- Preserve immutable Master/version evidence; edits must create governed Changes.
- Return stable error codes through `HttpError`.
- Bound queues, uploads, retries, timeouts, and result sizes.

