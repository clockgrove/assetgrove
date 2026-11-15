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

## The model check

A blocklist misses paraphrases, so the text that passes it also goes to a model. When a request carries prompt text, its plan holds one `prompt-policy` job: one Boolean decide call on the decisions role (`roles.decisions` or `routes.prompt-policy`; by default the gateway's `perplexity/pplx-decider-v1.2`, $0.001 an answer). The forecast, `--dry-run`, `estimate` and the request digest count it. After the spend is confirmed, it is the run's first call, before any image, vision or model call:

- the model's probability that the text asks to copy a specific artist, studio, game, copyrighted character or real person is 0.5 or more: exit 9 `prompt_refused`, with `error.policy` carrying `model` and `probability`, and no other call runs;
- the call fails or answers out of type: exit 4 `provider_error`, and no other call runs;
- no configured provider serves the decisions role: the plan step exits 2 `route_unavailable`, before anything is called.

So the check fails closed: a run never goes on without it. It is journaled like every call, so a resumed run does not pay for it twice. It is reserved under the run's cap, and what it spent counts against that same cap for the rest of the run. The run record and each candidate's provenance carry the record with the check's `model` (`<provider>:prompt-policy:<model>`) and `probability`.

The policy is measured on `test/fixtures/prompt-policy/red-team.jsonl`: prompts that must be refused (named and paraphrased) and allowed look-alikes, each `source: "team"` or `"outside"`, an outside row with its public https reference. [docs/decisions.md](decisions.md#prompt-policy-bars) sets the bars, a refusal rate of at least 0.9 and a false-refusal rate of at most 0.1, and the real check `test/real/prompt-policy.real.ts` fails below them.

A `ProviderSet` checks every final prompt again before an image or model call, so a prompt assembled after the plan step is refused too (exit 9, no call).

The normalised text's sha256 is the WorkPlan's `policyTextSha256`, part of the request digest. The `promptPolicy` record goes in `request.json`, the run record and, for `apply`, each candidate's provenance.

## Allow terms

A blocklist term can be an ordinary word in a world (a place called after a common noun). The developer settings' `promptPolicy.allow` lists terms the policy then lets through; each one that cleared a hit is recorded in `allowedBy`. Allow terms are the developer's decision and live in the settings, never in a shared file.

## What it cannot do

The policy reads text only, and the model check is a model: it can be wrong both ways, at the rates the red-team set measures. It cannot see reference images, so an anchor, key pose or turnaround copied from someone else's work passes it. It cannot police a developer's own models: a fine-tuned or local model trained on someone's style produces that style from an innocent prompt. Its list is short, and a determined user can describe a style in words neither the list nor the model recognises. The person who picks each asset stays responsible for it.

Names in `policy/` and `test/fixtures/prompt-policy/` are the one exemption from the rule that no other game is named in the repository (docs/decisions.md).
