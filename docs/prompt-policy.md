# Prompt policy

Assetgrove refuses a request whose prompts name a living artist's style, a studio, a game, a copyrighted character or a real person, before anything is spent. It is best-effort.

## What is checked

Every paid command's free plan step (`plan`, `apply`, `stage`, `generate-sheet`, `import`, `materials`, `look-dev`, `animation-qa`, `fix-frame`, `identity-eval`, `identity-check`) collects the request's prompt text:

- the spec's strings, minus strings that look like paths;
- the brief;
- the bible's fields that feed prompts (its front matter strings and its Do's and Don'ts);
- the prompt template's body;
- at `apply`, the saved plan's prompts.

The text is normalised (NFKC, lower case, diacritics removed, every run of spaces and punctuation one space) and matched against `policy/blocklist.json` (`format: "assetgrove-blocklist/1"`, shipped with the package) on word boundaries; a two-word term also matches run together. A hit exits 9 `prompt_refused` with `error.policy`: `match` (`term`, `kind`), `blocklistSha256`, `textSha256`, `verdict` and `allowedBy`. Nothing is called, spent or written. `--dry-run` and `estimate` refuse the same way.

A `ProviderSet` checks every final prompt again before an image or model call, so a prompt assembled after the plan step is refused too (exit 9, no call).

The normalised text's sha256 is the WorkPlan's `policyTextSha256`, part of the request digest. The `promptPolicy` record goes in `request.json`, the run record and, for `apply`, each candidate's provenance.

## Allow terms

A blocklist term can be an ordinary word in a world (a place called after a common noun). The developer settings' `promptPolicy.allow` lists terms the policy then lets through; each one that cleared a hit is recorded in `allowedBy`. Allow terms are the developer's decision and live in the settings, never in a shared file.

## What it cannot do

The policy reads text only. It cannot see reference images, so an anchor, key pose or turnaround copied from someone else's work passes it. It cannot police a developer's own models: a fine-tuned or local model trained on someone's style produces that style from an innocent prompt. Its list is short and a determined user can describe a style without naming it. The person who picks each asset stays responsible for it.

Names in `policy/` and `test/fixtures/prompt-policy/` are the one exemption from the rule that no other game is named in the repository (docs/decisions.md).
