## Summary

<!-- What does this PR do and why? 1–3 sentences. -->

> Use a clear, descriptive PR title. Conventional Commits are welcome but not required unless a maintainer asks for that style.

## Changes

-

## Testing

<!-- How was this verified? Commands run, manual steps, screenshots. -->

- [ ] `pnpm test` passes
- [ ] `pnpm exec tsc --noEmit` passes
- [ ] `pnpm test:types` passes (if public types changed)
- [ ] `pnpm --filter @0xsequence/oms-wallet-wagmi-connector test` passes (if connector behavior changed)
- [ ] `pnpm --filter @0xsequence/oms-wallet-wagmi-connector build` passes (if connector types/build changed)
- [ ] Relevant example builds pass: `pnpm build:example`, `pnpm build:trails-actions-example`, `pnpm build:wagmi-example`, `pnpm build:node-example`, or `pnpm build:node-contract-deploy-example`
- [ ] `pnpm build` succeeds (if touching exports, package output, or release behavior)

## Related

<!-- Linked issues or follow-ups. e.g. Closes #123 -->
