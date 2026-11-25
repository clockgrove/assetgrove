# Assetgrove audio for 1.0

Audio is a core feature of [Assetgrove 1.0](PRD.md#phase-3-extensions), beside images and 3D models. Core generates, checks, reviews, picks and stores sound effects, ambience loops and music, and the Godot pack delivers them to a Godot project. A person listens to the candidates and picks the version that goes into the library.

House rules apply: no native dependencies, existing libraries before our own code, exact checks before judgement, Git as the store, and cost only from vendor data.

## Kinds

| Kind | What it is | Brief | What the developer reviews |
| --- | --- | --- | --- |
| `sfx` | A one-shot such as a footstep, impact or door latch, up to 30 s | The action, a duration ceiling | Timing, character and the tail |
| `ambience` | A loop that wraps without a seam: wind, rain, a room tone | The scene, a loop length | The texture and the wrap point |
| `music` | An instrumental piece. `form` is `track` (a full piece for a menu, level or scene) or `cue` (a sting, transition or motif). A track may set `loop` with `bpm`, `bars` and `beatsPerBar` | Mood, instrumentation, optional section outline, theme, requested tempo, meter and key | Progression, transitions, the ending, or the wrap point of a loop |

- A **variant set** (five footsteps, three impacts) is a set of `sfx` assets sharing a `subject`, as icon families share one. Member ids and their order are fixed by the plan: `subject-01` to `subject-NN`.
- A **soundtrack** is a collection of related `music` assets, each with its own version history.
- Requested tempo, meter and key are recorded as requested. A measured value is recorded only when an exact check establishes it.

Not in 1.0: voice and text-to-speech, synchronized stems, adaptive or layered scoring, stingers synced to a playing track, and judging audio with a model (a `listen` role).

## Media, versions and renditions

- **One master per version.** A picked version's media is a lossless PCM WAV, its **mezzanine** file. Every route is asked for WAV, and a route that returns anything else is refused at intake, so nothing is decoded from a lossy file.
- **Renditions are derived.** A preview, or an Ogg Vorbis file for a target that wants one, is a rendition. It records the mezzanine hash, its own byte hash and the recipe with resolved settings and tool versions. A rendition is regenerated when the mezzanine or recipe changes. It carries its own AI mark and Content Credentials.
- **Masters live in Git LFS.** The LFS rules cover `.wav` and `.ogg` beside the image and model types.
- **Sample rate and channels.** The profile sets the sample rate, 44.1 kHz by default because it is Godot's mix rate and gives whole-sample lengths at common tempos. `sfx` is mono by default and `ambience` and `music` are stereo, each a profile value. Folding to mono is the `mono` recipe step. A stereo file whose channels are identical is refused, naming that step.
- **Marks.** The AI mark is written as XMP in a WAV `_PMX` chunk and as a Vorbis comment in Ogg. A WAV master carries embedded C2PA Content Credentials. An Ogg rendition carries a sidecar manifest, unless the spike shows the C2PA SDK embeds one in Ogg. A vendor's manifest becomes an ingredient of the asset's own. Assetgrove never denoises or re-synthesises vendor audio, so a watermark in the signal survives trim, gain and encode.

## Core changes

1. **A media trait.** Core features that today assume a raster (the contact sheet, the frames trait, plan, apply and vary, the check context) ask the kind's media trait instead. An audio trait gives the check context the decoded PCM, sample rate and channel layout.
2. **An audio engine in the transform core,** beside the image engine, with a sample hash for exact identity. Libraries, all pure JS or WASM:

   | Need | Library | Licence |
   | --- | --- | --- |
   | Read and write WAV, including `smpl` and `_PMX` chunks | `wavefile` | MIT |
   | Resample | `@alexanderolsen/libsamplerate-js` | MIT (libsamplerate BSD-2-Clause) |
   | Loudness and true peak | `@audio/loudness-lufs`, trusted only after it passes the EBU Tech 3341 test vectors | MIT |
   | Container facts for adopted files | `music-metadata` | MIT |
   | Encode Ogg Vorbis (renditions only) | chosen in Objective 6 from libvorbis WASM builds that carry no LGPL code | — |

   Core never decodes an Ogg: checks judge the master, and the Godot pack's CI proves the delivered file imports and plays.
3. **Audio operations,** each a recipe step that records one provenance step:

   | Op | What it does |
   | --- | --- |
   | `trim-silence` | Cuts leading and trailing silence below `floorDb`, keeping `marginMs` |
   | `fade` | Fades in and out over `inMs` and `outMs` |
   | `gain` | Gains the file to the profile's loudness target. Gain only, no limiter: when reaching the target would exceed the true-peak ceiling minus the encoder headroom, it refuses, naming both numbers |
   | `mono` | Folds to one channel |
   | `resample` | Changes the sample rate |
   | `loop` | Makes a seamless loop from a file generated with an overhang: cuts at the loop length and folds the overhang into the head with a crossfade of `crossfadeMs`, equal-gain for music and equal-power for ambience |
   | `encode` | Writes an Ogg Vorbis rendition at `quality` |

4. **An `audio` call kind and role.** `CallKind` gains `audio`, which is an extension API change, so the extension API version goes up by one. `call.audio(op, prompt, { parameters })` takes a closed, typed set: `durationS`, `seed` (where the route has one) and `promptInfluence`. Nothing else passes through. The prompt-policy check covers audio calls as it covers image and model calls.
5. **Cost.** Each audio call reserves the published rate times the requested duration, or the route's fixed price per generation, before spend. It settles from the vendor's own record where the vendor gives one. Stability prices in credits through `usdPerCredit`. A route whose price can't be read from vendor data isn't enabled.
6. **Review without playback in the harness.**
   - Each candidate gets a WAV preview file and a cell on a contact sheet showing its waveform, one lane per channel. The numbers (duration, loudness, true peak, loop length) go in the `stage` JSON, not on the sheet.
   - Over MCP, a preview under the read cap is returned as `audio` content, so a client that plays audio offers it. A longer preview is a `file://` link.
   - The developer listens in their own player and picks through the existing confirmation, bound to the exact candidate bytes.
   - Review notes anchor to time ranges with `t=` selectors.
7. **The first hour works for audio.** `adopt` takes a developer's own WAV and reads Ogg container facts, skipping loudness and saying so. Hand edits are new versions. `request_change` on audio regenerates from the brief with the note added.
8. **Search** indexes the card's text and fields: title, labels, kind, form, duration and requested tempo. A 15-second victory cue is found by subject and duration. Audio embeddings come after 1.0.

## Loudness

- The profile's `audio.loudness` block (`target` in LUFS, `tolerance`, `truePeakCeiling` in dBTP, `encoderHeadroom` in dB) has no default.
- An audio kind on a profile without the block is refused at plan, naming the block.
- `init` asks for the block, offering −23 LUFS and −1 dBTP (EBU R128) as the reference and naming where the numbers come from. Headless setups set the block in settings.
- Loops and music are measured by integrated loudness.
- An `sfx` is measured by its maximum momentary loudness (the 400 ms window), because integrated loudness isn't defined for short clips. A clip shorter than 400 ms is judged by true peak alone, and the check says so.

## Exact checks

All run on the master after the kind's recipe.

| Check | Rule |
| --- | --- |
| `audio:format` | Decodes; sample rate, channels and bit depth are the profile's |
| `audio:duration` | An `sfx` is at or under its ceiling; `ambience` and a music loop are exactly their loop length in samples; a track or cue is within the brief's duration ± the profile's tolerance |
| `audio:true-peak` | At or under the ceiling minus the encoder headroom |
| `audio:loudness` | Within target ± tolerance, measured as the Loudness section says |
| `audio:silence` | An `sfx`'s leading and trailing silence are each under the profile's limit |
| `audio:fade` | An `sfx`'s provenance has a `fade` step, so it never ends on a click |
| `audio:loop` | An `ambience` or music loop's provenance has a `loop` step leading to the final bytes |
| `audio:fake-stereo` | A stereo file's channels are not identical |
| `audio:set-loudness` | Every member of a variant set is within the profile's spread of the set's median, run by `audit` as icon consistency is |

**Loop length.** A music loop's length is Godot's: `floor(bars × beatsPerBar × 60 / bpm × sampleRate)` samples. The residual fraction of a sample is recorded on the card, so tempos such as 140 BPM at 44.1 kHz are allowed. The route generates the loop length plus an overhang, and the `loop` step cuts and folds it. Tempo and downbeat are not checked exactly. The spike measures how often they hold.

## Routes

| Route | Kinds | Terms, read 2026-11-18 | Price |
| --- | --- | --- | --- |
| Stability Stable Audio 2.5, direct, synchronous, 1 to 190 s, `seed` | all three | Stability assigns its rights in output to you; commercial use allowed. Training on inputs and outputs is on by default, with an opt-out. Its watermark, content credentials and other AI markings may not be removed, and output may not be presented as human-made | 8 credits a successful generation at $0.01 a credit; failures aren't charged |
| Stability Stable Audio 3.0, direct, asynchronous with a job id, up to 380 s, results kept 24 h | `ambience`, `music` | As 2.5 | As 2.5 |
| ElevenLabs Sound Effects v3, direct | `sfx`, `ambience` | Paid plans may use output commercially; free plans are non-commercial only. You keep the rights in output. ElevenLabs may use content to improve its services, with a "Data use" opt-out that applies from the day it's set. Output may not be unique across users | $0.12 a minute, published; the spike measures how a short clip rounds from the account's usage records |
| Google Lyria 3.5 | `music` | Read before the route is enabled | Read before the route is enabled |

- **Asynchronous routes** persist the provider's job id at submit, so a resumed run fetches the result without a second charge.
- **ElevenLabs tier.** The adapter reads the account's tier at `doctor` and at plan. It refuses a free tier, records the tier on each asset as the output grant's plan, and refuses a sample rate the tier doesn't allow. Each card says the output is non-exclusive.
- **Training opt-outs are recorded, not assumed.** Neither vendor's opt-out can be read through its API. The developer declares it per route in settings, and the card records "declared by the developer" with the date.
- **Refused routes, with the reason recorded:**
  - models licensed CC BY-NC, because a sold game is commercial;
  - open-weight Stable Audio hosted by a third party, because the Community License needs registration, ends above $1,000,000 of revenue and doesn't say how a host's outputs are covered;
  - ElevenLabs through the AI Gateway, until the gateway's terms say which ElevenLabs rights tier applies;
  - Eleven Music, whose plans below Enterprise exclude games outside its Indie Game definition, which Assetgrove can't verify. It comes after 1.0, behind a confirmation form that is refused headless;
  - vendors without a public API.

## Godot

The Godot pack's `godot:audio` preset:

- **WAV is the default delivery.** Loop points go in the WAV's RIFF `smpl` chunk, which Godot reads with its default loop-mode setting and other engines can read too. Assetgrove writes no WAV `.import` file. Godot's own importer applies its default compression, QOA, which is lossy; the preset documents this and leaves the setting to the developer.
- **Ogg on request.** A target that asks for Ogg gets the rendition from the master. Its `.import` (`loop`, `loop_offset`, `bpm`, `beat_count`, `bar_beats`) is written by Godot itself in scratch, as `godot:sprite-frames` builds its resource, and copied only when the project has none.
- **`check`** fails when a project's existing `.import` disagrees with the delivered version's loop points or tempo, naming the setting.
- **Variant sets** get one `AudioStreamRandomizer` resource per subject, built by Godot in scratch, keeping an existing UID.
- **Proven in the pack's CI** on the pinned Godot: the delivered files import, loop points and tempo read back, the randomizer loads, and a loop plays across its boundary.

## Disclosure

The Steam and itch.io exports gain a sound line per audio asset, from its route record.

## The spike

With a Stability key and an ElevenLabs paid key (two owner runbook steps), real routes make a fixed brief set: 10 one-shots, 5 ambience loops, 5 music loops at set tempos, 3 full tracks and 3 cues. The pass bars are written into the spike's issue before it runs. It measures:

- the share of candidates passing each exact check, before and after the recipe;
- the cost per passing asset, from vendor records;
- whether ElevenLabs gives 44.1 kHz WAV on the plan held;
- how ElevenLabs bills a short clip;
- how often a music loop keeps its tempo and lands on the downbeat;
- whether Stability's watermark and content credentials survive the Ogg rendition.

## Build order

1. The media trait, LFS types and audio marks (WAV `_PMX`, C2PA for WAV).
2. The audio engine and operations, with loudness proven on the EBU 3341 vectors.
3. The `audio` call kind and role, the prompt-policy check, and the Stability and ElevenLabs adapters with their cost model and tier checks. Scripted HTTP; no key.
4. The `sfx`, `ambience` and `music` kinds: exact checks, the `audio.loudness` block and its `init` question, staging, the contact sheet, MCP previews, pick, adopt, `request_change` and variant sets. Scripted provider; no key.
5. The Godot preset, with playback proven in the pack's CI.
6. Ogg renditions and the disclosure lines.
7. The spike, then live qualification: a sound effect, an ambience loop, a music loop, a full track and a cue each reach the library through generation, human listening and pick, and play in the pinned Godot project.

## Release acceptance

- Scripted fixtures for every kind go through the CLI and MCP: stage, preview, human pick and library check. Changing a candidate's bytes invalidates its pick confirmation. A resumed asynchronous job is fetched without a second charge.
- On live routes, a sound effect, an ambience loop, a music loop, a full track and a cue each reach the library through generation, human listening and pick. Their cards and exact master bytes pass library check.
- The Godot pack imports and plays each kind's delivery in the pinned Godot project. The library traces every delivered file's bytes back to the picked master and its recipe.
