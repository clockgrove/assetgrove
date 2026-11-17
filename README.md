<img src="docs/img/icon.png" alt="Assetgrove logo: a palette cut from a log slice" width="96">

# Assetgrove

Assetgrove is a command-line tool and MCP server that generates game art (stills, sprite strips and animation sheets, material maps, rigged 3D characters) through image and 3D generation models you hold the keys for. It filters the results against your game's spec, shows a person the candidates, and writes the one they pick into the game's repository with a record of how it was made.

It is for solo developers and small teams who have chosen AI-made art and want it consistent, traceable and bounded in cost, working from a terminal or from a coding agent (Claude Code, Codex, GitHub Copilot CLI). It is a development tool: a game never depends on it at runtime.

Before you go further:

- **It is pre-1.0 and not on npm yet.** The version is the 0.2.0 release candidate. Today you run it from a checkout of this repository ([Status](#status)).
- **Generation costs money, billed by the provider to your own account.** Assetgrove has no hosted service, sells no credits and takes no payment. Its spend caps are local estimates that refuse a call before it is made; the hard limit is the one you set with the provider ([Cost and control](#cost-and-control)).
- **Model-backed QA is advisory.** Deterministic checks filter candidates. A vision model's verdict is recorded and shown beside each candidate but filters nothing in this version ([why](docs/decisions.md#model-backed-checks-advisory-at-01)).

## Is it a fit?

A good fit when:

- you want many assets in one style, described once in a style bible, with each request built from a spec, not a freehand prompt;
- you want every file traceable: model, route, prompt, parameters, reference hashes, request IDs, time, cost and the provider's terms;
- you bring your own keys: the Vercel AI Gateway, Anthropic, OpenAI, Tripo, or a local OpenAI-compatible server;
- an agent does the generating and a person keeps the decisions: picking, approving and raising spend limits.

A poor fit when:

- you want a hosted product with accounts, credits or an editor. There is none ([non-goals](docs/PRD.md#non-goals));
- you want art accepted automatically because a check passed. Nothing is picked or approved without a person;
- you need engine import files today. Hand-off writes a manifest from your own template, or sprite-atlas JSON ([docs/handoff.md](docs/handoff.md)). A Godot pack, tile sets and icon families are planned, not built ([docs/PLAN.md](docs/PLAN.md));
- you need video or audio. Neither is generated;
- you want to hide that art is AI-made. Hand-off marks each file as AI-made where its format allows, and stripping that is a [non-goal](docs/PRD.md#non-goals) ([docs/disclosure.md](docs/disclosure.md)).

## What a run looks like

A request for one still, forecast for free and then generated. The first block is the forecast on the default gateway routes. The second is the end of the same request run offline with a scripted provider that returns synthetic images, as the test suite does, so its figures are route estimates and not a bill:

```text
dry run: plan, 10 planned call(s), nothing spent
  prompt-policy  perplexity/pplx-decider-v1.2  2 x ~$0.0010
  still  openai/gpt-image-2  4 x ~$0.2500
  style-verdict  perplexity/pplx-decider-v1.2  4 x ~$0.0010
forecast $1.0060 against a $5.00 cap
```

```text
run r-f27aed8d07625dce: 4 of 4 candidates passed QA ($1.0000 spent of a $5.00 cap)
staged in .assetgrove/runs/r-f27aed8d07625dce
c1  .assetgrove/runs/r-f27aed8d07625dce/c1.png  (image/png, $0.2500)
    style-score [decision; passed, not filtered]: no constitution or spec violation (violation probability 0.00)
...
pick one with: assetgrove pick --run .assetgrove/runs/r-f27aed8d07625dce --candidate <id> --target <dir>
```

`pick` then writes the image, your game's manifest, a provenance record and a library card into the game repository, with review pending.

## Quick start

One path from nothing to a first picked asset, at a terminal. Steps 1 to 4 are free and need no key. To work through a coding agent instead, follow [docs/quick-start.md](docs/quick-start.md).

You need Node 24, Git with Git LFS, and a game repository (any Git work tree). For step 5 you also need a [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) API key, with a budget or prepaid credits set on the Vercel side.

**1. Check out Assetgrove** and give the CLI a name for this shell:

```sh
git clone https://github.com/clockgrove/assetgrove.git && cd assetgrove
corepack enable && pnpm install --frozen-lockfile
alias assetgrove="node $PWD/src/cli.ts"
```

The alias is for a POSIX shell. In another shell, run `node <checkout>/src/cli.ts` wherever a step says `assetgrove`.

**2. Create the developer settings.** They are one file per user, outside every repository, and the only place that names providers and spend limits. `assetgrove settings path` prints where the file goes (`~/.config/assetgrove/settings.json` by default). The smallest file for the gateway names the provider and declares the limit you set with it:

```json
{
  "format": "assetgrove-settings/2",
  "providers": {
    "gateway": {
      "adapter": "vercel-ai-gateway",
      "limit": { "kind": "key-budget", "usd": 20, "period": "monthly" }
    }
  }
}
```

`assetgrove settings check` then prints `limit declared` for `gateway`.

**3. Set up the game repository.** In its root:

```sh
assetgrove init --directory . --profile-preset sprite-32 --style-preset cozy-storybook --world "My World"
git lfs install
```

`init` writes the target profile (`.assetgrove/profile.json`), a starter style bible (`.assetgrove/art-direction/BIBLE.md`), a prompt template, an `art-direction` skill for your agent, Git LFS rules for `assets/source/` and `.gitignore` rules for the run folders. It writes no key and no settings, and lists the steps left to a person.

**4. Describe one asset and forecast it.** Save this as `specs/fern.json`:

```json
{ "kind": "still", "assetId": "fern", "animationFamily": "idle" }
```

```sh
assetgrove plan --spec specs/fern.json --bible .assetgrove/art-direction/BIBLE.md \
  --profile .assetgrove/profile.json --out .assetgrove/runs/fern-plan.json --dry-run
```

It prints the forecast shown above and the spend left under each cap, and writes nothing. If you see that, the setup works.

**5. Generate (paid; the forecast is about $1 on the default routes).** Put the key in this shell's environment only, never in a file in a repository:

```sh
export AI_GATEWAY_API_KEY=...
assetgrove plan --spec specs/fern.json --bible .assetgrove/art-direction/BIBLE.md \
  --profile .assetgrove/profile.json --out .assetgrove/runs/fern-plan.json
assetgrove apply .assetgrove/runs/fern-plan.json
```

`plan` asks you to confirm the spend, then compiles the prompts into `fern-plan.json` for you to read; it makes no image. `apply` generates exactly that plan and lists the candidates that passed QA, each with its reasons. Open `contact.png` in the run directory to see them side by side.

**6. Pick one.**

```sh
assetgrove pick --run .assetgrove/runs/<run> --candidate c1 --target .
```

Success is these files in the game repository, ready to commit:

```text
assets/source/fern/idle.png                  the image, with content credentials
assets/source/fern/idle.png.provenance.json  how it was made
assets/manifests/fern/idle.json              your manifest, review status "pending"
assets/source/fern/fern-idle.md              the asset's card
assets/source/fern/fern-idle.review.json     its review record
assets/source/index.md, fern/index.md, fern/log.md
```

Why it works: the prompt is composed from the spec, the style bible and the profile's frame size, so the next asset you ask for is drawn to the same rules. To go one step further, ask for another round with a note (`assetgrove apply .assetgrove/runs/fern-plan.json --round 2 --note "larger ears"`), or give `BIBLE.md` your own reference images and palette ([docs/generation-knobs.md](docs/generation-knobs.md#start-a-world)).

## How it works

Three files in the game repository describe a request, and one file outside it holds everything about money and keys:

- **Asset spec**: one asset. Its kind (`still`, `sprite-strip` or `character-3d`), id, animation family, frames and anchor.
- **Style bible**: the world's look. Palette, tone, reference images, things to avoid.
- **Target profile**: the game's side. Frame size, where files go, the manifest template, an optional validator command.
- **Developer settings**: per user, never in a repository. Providers, routes, caps and limits.

A **run** is one request's directory under `.assetgrove/runs/`. It holds **candidates**. A **pick** hands one candidate off to the game.

| Who               | Does what                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Models            | Propose candidates, through provider adapters, within the run's cap.                                                         |
| Post-processing   | Brings each candidate to spec: true alpha, crop and scale to the frame grid, palette, pivot.                                 |
| QA                | Deterministic checks drop a failing candidate. Model-backed checks are recorded beside it as advisory.                       |
| The prompt policy | Refuses a prompt that names a real artist, studio, game, character or person, before any spend.                              |
| An agent, if used | Plans, dry-runs, generates and stages. It never picks, approves or raises a limit.                                           |
| A person          | Confirms spend, picks, and approves (`assetgrove approve`).                                                                  |
| The game          | Its own validator, run by `pick`, and its own review decide what ships. Media is stored as the game's `.gitattributes` says. |

Two ways to generate lead to the same `pick`: `plan` then `apply` (a plan you can read first, from the Markdown bible `init` writes), and `stage` (one step, from a JSON style bible that lists reference images; [docs/target-profile.md](docs/target-profile.md#style-bible)).

## What it records, and where to look

| Where                                | What                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `.assetgrove/runs/<run>/`            | `request.json`, `run.json` (candidates, QA reasons, cost), `contact.png`, each candidate with its provenance, the journaled calls.      |
| `<media>.provenance.json`            | Model, route, prompt, parameters, reference hashes, request IDs, times, cost, provider terms, output grant, how the pick was confirmed. |
| The card, review record and `log.md` | The asset's state, versions, comments and history ([docs/library.md](docs/library.md)).                                                 |
| `<stateDir>/spend.jsonl`             | The spend ledger across runs. `stateDir` is `~/.local/state/assetgrove` by default, outside every repository.                           |

`assetgrove runs list`, `runs show`, `spend status`, and `ls` and `cat` on the `asset://` tree read these and spend nothing ([docs/library.md](docs/library.md#the-asset-tree)). `assetgrove disclosure` summarises the library's AI use for store surveys.

## Cost and control

- **Who bills:** the provider, on your key. A dry run forecasts from route estimates and spends nothing.
- **Local caps** refuse a paid call before it is made (exit 3): one run (`caps.runUsd`, $5; `--cap` may only lower it), the last 24 hours (`caps.dailyUsd`, $10) and one work item (`caps.workItemUsd`, $5, named by `--work-item` or `ASSETGROVE_WORK_ITEM`).
- **The ledger is an estimate.** Where a provider reports per-call cost (the gateway, Tripo), a run reconciles against it, and an unexplained gap holds further paid runs until a person acknowledges it. Anthropic and OpenAI report no usage to an ordinary key, so their calls count at the route estimate.
- **The provider's limit is the hard one.** A paid call to a provider with no declared `limit` is refused, but the declaration is yours: Assetgrove can check it only against a prepaid balance (`assetgrove spend check`).
- **A person confirms every paid run.** At a terminal the command asks. Anywhere else it exits 8 with an id for `assetgrove confirm <id>`.
- **What the caps do not stop:** spending outside Assetgrove, or an agent set on getting round its harness ([what the controls stop](docs/PRD.md#what-the-controls-stop-and-what-they-dont)).

Details: [docs/settings.md](docs/settings.md#caps-and-ledger).

## Keys and providers

Keys are read from environment variables, never from a file, and never printed. A paid command refuses to run in a repository that tracks a live key. Each provider is an entry in the developer settings with its own declared `limit`. Several can be configured at once, and `roles` and `routes` there choose which serves each operation ([docs/settings.md](docs/settings.md#roles-and-routes)).

| Provider (adapter)                      | Key variable         | Serves                                                                           |
| --------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| Vercel AI Gateway (`vercel-ai-gateway`) | `AI_GATEWAY_API_KEY` | Every 2D operation by default ([default routes](docs/models.md#default-routes)). |
| OpenAI (`openai`)                       | `OPENAI_API_KEY`     | Image, edit, vision, decisions, planning.                                        |
| Anthropic (`anthropic`)                 | `ANTHROPIC_API_KEY`  | Vision, decisions, planning. No image models: pair it with another provider.     |
| Tripo (`tripo`)                         | `TRIPO_API_KEY`      | 3D models, rigs and clips.                                                       |
| Local server (`openai-compatible`)      | none unless `keyEnv` | What you route to it. Free only on a loopback address.                           |

Get each key from that provider's own console and set its budget there. `keyEnv` on an entry names another variable. A setup with no network at all is in [docs/models.md](docs/models.md#local-only-recipe). With a coding agent, keep the key in the MCP server's environment at user scope, not in the agent's shell or the project; the per-harness steps and their limits are in [docs/keys.md](docs/keys.md). Providers may retain the prompts and reference images they receive, and `init` lists where each route sends data.

## When a command refuses

Decide on the exit code and, with `--json`, on `error.code`, never on the message.

| Exit | Situation                                                                | What you do                                                                                        |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 2    | `route_unavailable`: no configured provider serves the operation         | Add a provider, or a role, to the developer settings.                                              |
| 2    | `settings_invalid` naming `HTTPS_PROXY` or another proxy or TLS variable | Unset it, or list it under `environment.allow` ([docs/settings.md](docs/settings.md#environment)). |
| 2    | `key_tracked`, `git_required` or `lfs_required`                          | Remove the key from the tracked file; work in a Git work tree; run `init` to map media to LFS.     |
| 2    | A reference image does not decode                                        | It is an unfetched Git LFS pointer: run `git lfs pull`.                                            |
| 3    | `cap_refused`, `provider_limit_undeclared` or `spend_hold`               | Ask for less, declare the provider's limit, or review the hold in `assetgrove spend status`.       |
| 4    | Provider error: the key variable is not set, or every candidate failed   | Set the key; read the reason given for each candidate.                                             |
| 5    | QA found nothing: no candidate passed, or a check failed                 | Read the reasons in `run.json`; change the spec, the bible or the note and run again.              |
| 6    | The target's validator or a hand-off check rejected what was written     | Fix what the validator or `error.problems` names, then pick again.                                 |
| 7    | Licence refused: the provider's output grant does not fit the target     | Nothing was written. Use a route whose grant fits the licence the profile declares.                |
| 8    | `confirmation_required`                                                  | A person runs `assetgrove confirm <id>` at a terminal, then the same command again.                |
| 9    | `prompt_refused`                                                         | Describe the look in plain visual words, not by a name.                                            |

Exit 1 is an unexpected internal error; please [report it](https://github.com/clockgrove/assetgrove/issues). An interrupted paid run resumes from its journal when you run the same command again, and does not pay twice for a finished call. Every code is listed in the [skill](skills/assetgrove/SKILL.md#exit-codes).

## Beyond a first still

- **Animation.** `import` slices a contact sheet from any tool into frames and proposes families; `generate-sheet` has a model draw a whole cycle as one sheet first. A person confirms the grouping and `write-families` writes one strip per family. `animation-qa` checks motion templates, loops and continuity and writes onion-skin and looping previews; `fix-frame` regenerates one bad frame. See [docs/sheet-import.md](docs/sheet-import.md) and [docs/animation.md](docs/animation.md).
- **3D characters.** A `character-3d` spec stages rigged, animated `.glb` candidates from an approved turnaround (Tripo by default), checked with the Khronos glTF validator and the target's budgets. `rig`, `lod` and `look-dev` refine a picked model. See [docs/characters-3d.md](docs/characters-3d.md) and [docs/look-dev.md](docs/look-dev.md).
- **Changes and variations.** `request-change` edits marked regions of a picked asset, `vary` makes variations of a candidate, `compare` measures a candidate against the version before, and `audit` scores a set for style and identity.
- **Local image operations.** `op` and `recipe` matte, trim, scale, slice and convert any image, generated or not, with a provenance record and no model call ([docs/transform.md](docs/transform.md)).
- **Search.** The optional [`@clockgrove/assetgrove-search`](packages/assetgrove-search/README.md) package finds picked assets and lists near matches before a paid run.

`assetgrove --help` lists every command and `assetgrove <command> --help` its options. The [command reference](skills/assetgrove/references/commands.md) says what each one spends and writes.

## Use from a coding agent

`assetgrove mcp` serves every command as an MCP tool and the library as `asset://` resources. The skills under `skills/` teach an agent the contract: install them with `npx skills add clockgrove/assetgrove`, or copy `skills/assetgrove/` to `.claude/skills/assetgrove/` (Claude Code, Copilot) or `.agents/skills/assetgrove/` (Codex, Copilot).

- Agents pass `--json`: stdout is one JSON document and logs go to stderr. Assetgrove prompts only when stdin and stderr are a terminal, which an agent's shell is not, so a step that needs a person exits 8.
- Agents dry-run first, name the work item, and hand the run directory and candidate ids to a person. They never run `pick`, `write-families`, `approve` or `confirm`.
- Assetgrove reaches only the configured providers' hosts: `ai-gateway.vercel.sh`, `api.openai.com`, `api.anthropic.com`, `api.tripo3d.ai`, or a provider's `baseURL`. Keep those hosts out of the agent's shell sandbox; only the MCP server process needs them ([docs/keys.md](docs/keys.md)).

## Documentation

| To                                                          | Read                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Set up through Claude Code or another harness               | [docs/quick-start.md](docs/quick-start.md), [docs/keys.md](docs/keys.md)                                                       |
| Write a spec, a style bible or a target profile             | [docs/target-profile.md](docs/target-profile.md), [docs/generation-knobs.md](docs/generation-knobs.md)                         |
| Configure providers, routes, caps and limits                | [docs/settings.md](docs/settings.md), [docs/models.md](docs/models.md)                                                         |
| Hand off to an engine or an atlas format                    | [docs/handoff.md](docs/handoff.md)                                                                                             |
| Browse, review, approve and change picked assets            | [docs/library.md](docs/library.md)                                                                                             |
| Animate, build 3D characters, derive material maps          | [docs/animation.md](docs/animation.md), [docs/characters-3d.md](docs/characters-3d.md), [docs/materials.md](docs/materials.md) |
| Know what the prompt policy refuses                         | [docs/prompt-policy.md](docs/prompt-policy.md)                                                                                 |
| Understand AI marks, content credentials, disclosure        | [docs/disclosure.md](docs/disclosure.md)                                                                                       |
| Extend Assetgrove with a package (a pack, and its test kit) | [docs/extensions.md](docs/extensions.md)                                                                                       |
| See why it is built this way, and what is planned           | [docs/decisions.md](docs/decisions.md), [docs/PRD.md](docs/PRD.md), [docs/PLAN.md](docs/PLAN.md)                               |

## Status

Pre-1.0 and under active design: commands, file formats and defaults can change between versions, and there is no supported release line yet. Both packages are at 0.2.0, a release candidate that its owner has not yet published to npm ([docs/release.md](docs/release.md)). Once it is, a game pins it as a dev dependency (`pnpm add -D --save-exact @clockgrove/assetgrove@<version>`, then `pnpm exec assetgrove`) or runs it once with `npx @clockgrove/assetgrove@<version> --help`. Until then, use a checkout at a pinned commit, as the quick start does. It runs on Node 24, and its test suite runs on Linux, macOS and Windows.

## Develop

Node 24 with pnpm ([docs/decisions.md](docs/decisions.md#language-and-tooling)). `pnpm install`, then:

- `pnpm assetgrove …` runs the TypeScript sources directly; `pnpm build` compiles to `dist/` for the package.
- `pnpm check` runs Prettier, ESLint and the type check.
- `pnpm test` runs offline with a scripted provider and calls no real model. It includes a test that packs the package, installs it in a temp dir from the npm registry and runs it.
- `pnpm test:real` runs the opt-in real-provider checks, which skip without a key.

## Help, security, contributing, licence

- **Questions and bugs:** [open an issue](https://github.com/clockgrove/assetgrove/issues). Never include a key or private art.
- **Security:** report privately, as [SECURITY.md](SECURITY.md) describes.
- **Contributing:** until 1.0, pull requests from outside contributors are not accepted; issues are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the repository rules in [AGENTS.md](AGENTS.md).
- **Licence:** [MIT](LICENSE).
