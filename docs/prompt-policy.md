# Prompt policy

Assetgrove refuses a request whose prompts name a living artist's style, a studio, a game, a copyrighted character or a real person. A name on its list refuses before anything is spent; a phrase such as "in the style of" or a name that is also an ordinary word is decided by a model, with the words around it, when the run starts. It is best-effort.

## What is checked

Every paid command's free plan step (`plan`, `apply`, `stage`, `generate-sheet`, `import`, `materials`, `look-dev`, `animation-qa`, `fix-frame`, `identity-eval`, `identity-check`) collects the request's prompt text, each string kept with the part it came from:

- the spec's strings, minus strings that look like paths;
- the brief;
- the bible's fields that feed prompts (its tone fields, and its Do's and Don'ts, which the model check is told are rules the art must follow);
- the prompt template's body;
- at `apply`, the saved plan's prompts, which are the only saved text that counts (digests and formats feed no prompt) and are labelled model-written;
- the free-text options a prompt carries: `fix-frame`'s `--family`, `--subject` and `--note`; `animation-qa`'s `--family` and `--subject` when it makes vision calls; `import`'s `--subject` and `--hints` when it proposes a grouping;
- the target profile's text a prompt carries: the motion template `generate-sheet` states (its description and beat names) and the groom seasons and their traits `look-dev` describes.

The text is normalised (invisible format characters such as soft hyphens and zero-width spaces removed, NFKC, lower case, diacritics removed, every run of spaces and punctuation one space) and matched against `policy/blocklist.json` (`format: "assetgrove-blocklist/1"`, shipped with the package) on word boundaries; a two-word term also matches run together.

The free check refuses only an unambiguous name (artist, studio, game, character or person): exit 9 `prompt_refused` with `error.policy`: `match` (`term`, `kind`), `blocklistSha256`, `textSha256`, `verdict` and `allowedBy`. Nothing is called, spent or written, and it makes no provider call. The plan step, `--dry-run`, `estimate`, the `ProviderSet`'s final-prompt check and every other free check refuse the same way.

Two kinds of hit refuse nothing by themselves: a phrase ("in the style of", "inspired by", "imitate", "recreate", "game called") and a name marked `"ambiguous": true` in the blocklist (a name that is also an ordinary word or a given name). Each is recorded in the record's `hits` with its `term`, `kind`, `ambiguous`, `part` and `context` (up to 12 normalised words either side). `--dry-run` and the plan step report them as decided by the model check when the run starts.

## The model check

A blocklist misses paraphrases and cannot tell a phrase used to copy from the same phrase used innocently, so the text that passes the free check also goes to a model. When a request carries prompt text, its plan holds one `prompt-policy` job: one Boolean decide call on the decisions role (`roles.decisions` or `routes.prompt-policy`; by default the gateway's `perplexity/pplx-decider-v1.2`, $0.001 an answer). The forecast, `--dry-run`, `estimate` and the request digest count it. After the spend is confirmed, it is the run's first call, before any image, vision or model call. The model is given the prompt as labelled parts: spec strings; brief; bible tone fields; bible Do's and Don'ts, marked as rules the art must follow; template body; other text (notes, subjects, profile text); the compiler-written prompt and negative prompt, marked model-written; and the hits with their context. So a bible rule not to imitate the look of any named game is read as a rule, and an ambiguous name is decided by its sentence, with no global allow entry. The answer:

- the model's probability that the text asks to copy a specific artist, studio, game, copyrighted character or real person is 0.5 or more: exit 9 `prompt_refused`, with `error.policy` carrying `model` and `probability`, and no other call runs;
- the call fails or answers out of type: exit 4 `provider_error`, and no other call runs;
- no configured provider serves the decisions role: the plan step exits 2 `route_unavailable`, before anything is called.

Compiler-written text is never the reason a person's request exits 9 after spend. At `plan`, a name in the compiler's output falls back for free to the template prompt (the compiler's `fallbackReason`, and `promptPolicy.fallback`); phrase hits in it are saved and decided by apply's check. A run whose prompt text has model-written parts (`apply`, whose saved plan prompts are model-written) forecasts two prompt-policy calls: when the first refuses, a second decides on the person-written parts alone. If it allows, the run uses the repository template's prompt and records why in `promptPolicy.fallback`; if it refuses, exit 9. `plan` forecasts its own one call plus its apply's two.

So the check fails closed: a run never goes on without it. It is journaled like every call, so a resumed run does not pay for it twice. It is reserved under the run's cap, and what it spent counts against that same cap for the rest of the run. The run record and each candidate's provenance carry the record with the check's `model` (`<provider>:prompt-policy:<model>`), `probability` and `verdict`, the `hits` and any `fallback`.

The policy is measured on `test/fixtures/prompt-policy/red-team.jsonl`: prompts by category: `name` (refused for free), `phrase` (decided by the model, the expectation per row), `paraphrase`, `lookalike` and `plain`, each with an optional `part` (rules, text, model-negative) and each `source: "team"` or `"outside"`, an outside row with its public https reference. [docs/decisions.md](decisions.md#prompt-policy-bars) sets the bars, a refusal rate of at least 0.9 and a false-refusal rate of at most 0.1, and the real check `test/real/prompt-policy.real.ts` fails below them.

A `ProviderSet` runs the free check on every final prompt again before an image or model call, so a name in a prompt assembled after the plan step is refused too (exit 9, no call).

The normalised text's sha256 is the WorkPlan's `policyTextSha256`, part of the request digest. The `promptPolicy` record goes in `request.json`, the run record and, for `apply`, each candidate's provenance.

## Allow terms

An ambiguous name no longer needs an allow term: the model check decides it from its sentence. The developer settings' `promptPolicy.allow` lists terms the policy lets through for good, for a term that is an ordinary word in a world and that the developer does not want decided each run; it clears any hit, name or phrase, and each one that cleared a hit is recorded in `allowedBy`. Allow terms are the developer's decision and live in the settings, never in a shared file.

## What it cannot do

The policy reads text only, and a phrase hit is decided by a model, not refused for free, so it can be wrong both ways, at the rates the red-team set measures. It cannot see reference images, so an anchor, key pose or turnaround copied from someone else's work passes it. It cannot police a developer's own models: a fine-tuned or local model trained on someone's style produces that style from an innocent prompt. Its list is short, and a determined user can describe a style in words neither the list nor the model recognises. The person who picks each asset stays responsible for it.

Names in `policy/` and `test/fixtures/prompt-policy/` are the one exemption from the rule that no other game is named in the repository (docs/decisions.md).
