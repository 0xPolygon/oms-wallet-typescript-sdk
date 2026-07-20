---
name: changeset-commit
description: >
  Use this skill for any changeset-related decision in this repo (managed by
  @changesets/cli). It covers deciding whether a commit needs a changeset,
  composing it correctly, and ensuring it lands in the same commit as the code
  (never a follow-up commit). Invoke it whenever you are about to run `git commit`.
  If you are unsure whether a changeset is needed, use this skill to work through
  the decision rather than skipping it.
---

# Changeset Commit

This skill exists because the most common failure mode is creating a changeset as
a separate follow-up commit. That makes the CHANGELOG record the hash of the
changeset commit rather than the code commit, so entries become untraceable. The
fix is never to add a changeset after the fact: always stage it alongside the
code. The release flow lives in **`PUBLISHING.md`**; this skill is the decision
procedure.

## This repo is a monorepo with a fixed version group

Two packages are published — **`@polygonlabs/oms-wallet`** (the SDK) and
**`@polygonlabs/oms-wallet-wagmi-connector`**. They are a `fixed` group in
`.changeset/config.json`, so **any release bumps both to the same version**,
regardless of which one changed. When you author a changeset you only need to
list **one** package (either one) — the fixed group carries the other along.

## What needs a changeset

`changeset status` is the source of truth — the CI gate
(`.github/workflows/changeset-check-trigger.yml` →
`0xPolygon/pipelines apps-changeset-check.yml`) runs it, so let it decide rather
than reasoning about file paths by hand:

```bash
pnpm exec changeset status --since=origin/master
```

- It reports packages to bump, or errors that packages changed → this PR needs a
  changeset. Decide real vs. empty (Step 2).
- It reports nothing to bump → no changeset needed.

`changeset status` only counts a changeset committed on the branch — an
uncommitted changeset file is invisible to the `--since` diff, so it will report
"no changesets" until you commit it. Files outside every workspace package
(`.github/`, root configs, top-level docs) don't require one.

## Step 1 — If this is an amend, check whether HEAD already has a changeset

When the commit command includes `--amend`, run:

```bash
git show --name-only HEAD | grep '^\.changeset/.*\.md$'
```

If a changeset file is present, the amend preserves it. Read its body and compare
it against the full set of changes in the amended commit:

- **Body still accurate** — no action needed; proceed to the commit.
- **Body no longer accurate** — update the existing changeset body in place and
  stage it alongside the other changes. Do not add a second changeset file.

If no changeset is found in HEAD, continue to Step 2.

## Step 2 — Decide: real changeset or empty

**Real changeset (patch / minor / major)** — the PR changes package *behaviour*:
anything a consumer of a published package observes — the SDK's or connector's
public API, exported values, public types, runtime behaviour, or the build
output.

- `patch` — bug fixes, dependency bumps with no API change, perf improvements
- `minor` — new opt-in, backwards-compatible functionality
- `major` — breaking changes. Also add a `## <major version>` section to the
  affected package's `MIGRATION.md` in the same PR.

**Empty changeset (`pnpm exec changeset add --empty`)** — the PR has no consumer
impact: CI/workflow changes, repo docs, example-only or test-only changes, an
internal refactor with identical published output, a tooling tweak. Before adding
one, check the branch doesn't already carry a covering changeset (an extra empty
one is pure noise):

```bash
git log origin/master..HEAD --diff-filter=A --name-only --pretty=format: \
  | grep '\.changeset/.*\.md$'
```

If unsure whether a change is behaviour-affecting, let
`pnpm exec changeset status --since=origin/master` decide — that is exactly what
the CI gate runs.

## Step 3 — Compose the changeset body

A changeset is a **user-facing changelog entry**, not a commit message: it
describes what changed for the person reading the changelog, not what you did to
the code.

1. **First line must be plain prose — never a markdown heading.** Changesets
   prefixes every entry with `- <commit-hash>:` in `CHANGELOG.md`, so a heading on
   line 1 renders as `- abc1234: ## My heading` (a broken bullet). Write a
   one-sentence plain-text summary first; use headings and lists from line 2.
2. **Lead with the user-visible outcome, not the mechanism.** The reader can see
   *what* changed from the diff — tell them what it means for them.
3. **Use markdown properly** — headings, bullet lists, inline code, **bold** for
   key terms (exported names, options). Group related changes under a descriptive
   heading rather than one long paragraph.
4. **Avoid commit-type prefixes** (`feat:`, `fix:`, `chore:`) and **implementation
   language** (`refactor`, `extract`, `wrapper`, `singleton`) — those describe git
   history or code structure, not consumer impact. Drop internal names (branch
   names, PR numbers, private repo/service names).

Because the changelog is published to npm and the GitHub Release, treat every
changeset body as public — no internal-only detail.

Bad — commit-message style, heading on line 1:

```markdown
## Wallet changes
refactor OMSWallet to route signing through the new internal signer map
```

Good — changelog style:

```markdown
`OMSWallet.sendTransaction` now accepts a `selectFeeOption` callback

- Pass `FeeOptionSelector.firstAvailable` to auto-pick the first affordable option
- Existing calls are unchanged — the callback is optional
```

## Step 4 — Write and stage the changeset with the code

Write the file directly (non-interactive, works everywhere). The filename can be
anything unique under `.changeset/`. List one package — the fixed group bumps the
other to match:

```markdown
---
"@polygonlabs/oms-wallet": patch
---

Plain-text summary on the first line.

Further detail with markdown from the second line onwards.
```

Empty changeset format (no version bump):

```markdown
---
---

Plain-text description of the CI / docs / tooling change.
```

Then stage **everything together** — code and changeset — in one `git add` before
committing:

```bash
git add <changed-files> .changeset/<file>.md
git commit -m "type(scope): description"
```

## Step 5 — If you already committed without the changeset

- **Not yet pushed, or pushed with no human reviews** — don't add a follow-up
  commit. `git reset --soft HEAD~1`, write and stage the changeset, recommit with
  the same message, then `git push --force-with-lease` if it was pushed.
- **Pushed and a human has reviewed** — add a follow-up commit containing only the
  changeset (`git commit -m "chore: add changeset"`). This is the one sanctioned
  exception to the same-commit rule: preserving reviewer context outweighs
  CHANGELOG hash precision.

If **multiple** commits are missing changesets, reorganise the branch as a whole
(interactive rebase) rather than fixing them one at a time.

## Step 6 — Verify the changeset is in the commit

```bash
git show --name-only HEAD | grep '\.changeset'
```

If this returns nothing, the changeset was not included. Do not push — `git reset
--soft HEAD~1` and recommit with the changeset staged.
