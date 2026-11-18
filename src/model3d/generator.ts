/**
 * The `character-3d` generator: a rigged, animated `.glb` from a character's approved turnaround.
 * One candidate makes a 3D generation call, a facing decision on renders of the raw mesh (a mesh that
 * faces other than the route says fails with no rig), a rig call, one clip call for every family the
 * provider's library has, and an identity call on the rendered views; all are reserved against the
 * cap before the run's first call. QA runs before the pick and is recorded per candidate.
 */
import { CORE_PROFILE_SCHEMA, CORE_SPEC_SCHEMA } from "../generators/spec-schema.ts";
import { InputError, ProviderError } from "../errors.ts";
import type {
  Generator,
  GeneratorContext,
  KindCheck,
  PlannedCall,
} from "../generators/generator.ts";
import {
  IDENTITY_CAST_OPERATION,
  IDENTITY_CHECK,
  identitySettings3d,
  identityReason,
  scoreIdentity,
} from "../identity.ts";
import type { IdentityRecord, IdentityScore } from "../identity.ts";
import { createRaster, decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { sha256, subjectOf, withNote } from "../request.ts";
import {
  CLIP_MAP_OPERATION,
  MODEL3D_FACING_OPERATION,
  REFERENCE_VIEW_OPERATION,
} from "../routes.ts";
import type { Routes } from "../routes.ts";
import type { AssetSpec, LoadedReference, Reason, StyleBible, TargetProfile } from "../types.ts";
import { ClipMapCache, familiesToMap, clipPlan, resolveClipPlan } from "./clip-map.ts";
import { judgeFacing } from "./facing.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "./glb.ts";
import type { Glb } from "./glb.ts";
import {
  ReferenceViewCache,
  loadReferenceViews,
  planReferenceViews,
  requireFront,
  subjectBibleReferences,
  viewRecord,
} from "./views.ts";
import type { ViewedReference } from "./views.ts";
import { CHARACTER_3D_KIND, FRAMES_PER_CLIP, characterSpec, model3dSettings } from "./profile.ts";
import type { CharacterSpec } from "./profile.ts";
import {
  budgetChecks,
  clipChecks,
  hierarchyCheck,
  qaPassed,
  skeletonCheck,
  validatorCheck,
} from "./qa.ts";
import { renderTurntable } from "./render.ts";
import type { TurntableFrame } from "./render.ts";
import { profileSha256, riggedCandidate } from "./rig/candidate.ts";
import { declaresRig, loadRig, rigProfileOf } from "./rig/template.ts";
import {
  clips,
  appendAnimation,
  closeLoop,
  keepClips,
  measure,
  normalize,
  renameClips,
  yawBetween,
} from "./scene.ts";

export const MODEL_OPERATION = "model3d";
export const RIG_OPERATION = "rig3d";
export const CLIPS_OPERATION = "clips3d";

/**
 * Bible references of the subject, each with the view it shows (declared, or judged by a model and
 * cached), front first. A request whose references show no front view is refused here, before
 * the 3D call.
 */
async function subjectReferences(
  spec: AssetSpec,
  bible: StyleBible,
  bibleDir: string,
  call: GeneratorContext["call"],
  cache: ReferenceViewCache,
): Promise<ViewedReference[]> {
  const refs = subjectBibleReferences(spec, bible);
  if (refs.length === 0) {
    throw new InputError(
      `the style bible has no approved references for subject "${subjectOf(spec)}"`,
    );
  }
  const viewed = await loadReferenceViews(call, refs, bibleDir, cache);
  requireFront(viewed);
  return [...viewed.filter((r) => r.view === "front"), ...viewed.filter((r) => r.view !== "front")];
}

/**
 * The identity record of a 3D character: the bible's approved references of the subject, with its
 * description as the signature features and the bible palette. Versioned with the bible.
 */
export function identityRecordOf(
  spec: AssetSpec,
  bible: StyleBible,
  references: LoadedReference[],
): IdentityRecord {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description ?? subject;
  const fingerprint = {
    signatureFeatures: [description],
    proportions: description,
    palette: bible.palette,
  };
  const refs = references.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 }));
  return {
    subject,
    version: bible.version,
    sha256: sha256(Buffer.from(JSON.stringify({ fingerprint, refs }))),
    fingerprint,
    references: refs,
  };
}

function sideBySide(images: Raster[]): Raster {
  const height = Math.max(...images.map((r) => r.height));
  const width = images.reduce((sum, r) => sum + r.width, 0);
  const out = createRaster(width, height);
  let x0 = 0;
  for (const image of images) {
    for (let y = 0; y < image.height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * width + x0) * 4,
      );
    }
    x0 += image.width;
  }
  return out;
}

function prompt(spec: AssetSpec, bible: StyleBible, character: CharacterSpec): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  return [
    `A real-time 3D game character for the style bible version ${bible.version}.`,
    description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`,
    `Gait: ${character.gait}. Match the approved turnaround views exactly.`,
    ...(bible.mood?.length ? [`Mood: ${bible.mood.join(", ")}.`] : []),
  ].join("\n");
}

/**
 * The checks a 3D character's reasons name. The model's and rig's are deterministic measures, most
 * of them one per budget, clip family or foot (`clip-*`). `facing` and `identity-lock` are model
 * decisions core gates by its own rules: without a known facing there is no rig to check, and the
 * identity lock scores a 3D character in shadow mode (docs/target-profile.md).
 */
export const CHARACTER_3D_CHECKS: KindCheck[] = [
  ...[
    "gltf-validator",
    "mesh-hierarchy",
    "skeleton",
    "turntable",
    "budget-*",
    "clip-*",
    "loop-*",
    "ends-*",
    "contact-*",
    "joint-limits-*",
    "skinning-*",
    "compare-*",
    "reference-*",
  ].map((name): KindCheck => ({ name, mode: "exact", source: "deterministic" })),
  { name: "facing", mode: "gated", source: "decision" },
  { name: IDENTITY_CHECK, mode: "gated", source: "decision" },
];

export const character3dGenerator: Generator = {
  kind: CHARACTER_3D_KIND,
  checks: CHARACTER_3D_CHECKS,
  specSchema: CORE_SPEC_SCHEMA,
  profileSchema: CORE_PROFILE_SCHEMA,
  operations: {
    [MODEL_OPERATION]: "model3d",
    [RIG_OPERATION]: "rig3d",
    [CLIPS_OPERATION]: "clips3d",
    [MODEL3D_FACING_OPERATION]: "decisions",
    identity: "decisions",
    [IDENTITY_CAST_OPERATION]: "vision",
    [CLIP_MAP_OPERATION]: "decisions",
    [REFERENCE_VIEW_OPERATION]: "decisions",
  },

  planCandidate(spec: AssetSpec, profile: TargetProfile, routes: Routes): PlannedCall[] {
    const character = characterSpec(spec);
    model3dSettings(profile);
    const calls: PlannedCall[] = [];
    const add = (operation: string) => {
      const route = routes[operation];
      if (!route) throw new InputError(`no model route for operation "${operation}"`);
      calls.push({ operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd });
    };
    add(MODEL_OPERATION);
    // Which way the returned mesh faces is judged before it is rigged.
    add(MODEL3D_FACING_OPERATION);
    if (declaresRig(profile)) {
      // The target's shared rig and generated gaits replace the provider's rig and clips.
      rigProfileOf(profile);
    } else {
      add(RIG_OPERATION);
      // One retarget call per exact library clip, and per other family a clip-map decision may map.
      clipPlan(character, routes[CLIPS_OPERATION]).planned.forEach(() => add(CLIPS_OPERATION));
      familiesToMap(character, routes[CLIPS_OPERATION]).forEach(() => add(CLIPS_OPERATION));
    }
    // Identity never filters a 3D character, so no record check is forecast.
    const identity = identitySettings3d(profile);
    if (identity.mode !== "off") {
      add(identity.question === "cast" ? IDENTITY_CAST_OPERATION : "identity");
    }
    return calls;
  },

  planRequest(spec: AssetSpec, profile: TargetProfile, routes: Routes, bible: StyleBible) {
    // One view call per reference that declares no view, once per request.
    const calls = planReferenceViews(subjectBibleReferences(spec, bible), routes);
    if (declaresRig(profile)) return calls;
    // One clip-map decision per requested family that is not exactly a library clip, once per run.
    const mapped = familiesToMap(characterSpec(spec), routes[CLIPS_OPERATION]);
    if (mapped.length === 0) return calls;
    const route = Object.hasOwn(routes, CLIP_MAP_OPERATION)
      ? routes[CLIP_MAP_OPERATION]
      : undefined;
    if (!route) throw new InputError(`no model route for operation "${CLIP_MAP_OPERATION}"`);
    return [
      ...calls,
      ...mapped.map(() => ({
        operation: CLIP_MAP_OPERATION,
        model: route.model,
        estimatedCostUsd: route.estimatedCostUsd,
      })),
    ];
  },

  async generate(context: GeneratorContext) {
    const { spec, bible, profile, call } = context;
    const character = characterSpec(spec);
    const settings = model3dSettings(profile);
    const text = withNote(prompt(spec, bible, character), context.note);
    // A rig template that cannot be read is refused before the first call.
    const rig = declaresRig(profile)
      ? await loadRig(profile, context.profileDir ?? process.cwd())
      : undefined;
    // The view calls are cheap; the front view is required before the expensive 3D call.
    const references = await subjectReferences(
      spec,
      bible,
      context.bibleDir,
      call,
      context.referenceViews ?? new ReferenceViewCache(),
    );

    const made = await call.model3d(
      MODEL_OPERATION,
      text,
      references,
      context.seed,
      settings.budgets.triangles,
    );
    let source: Glb;
    try {
      source = parseGlb(made.glb);
    } catch (error) {
      throw new ProviderError(`the provider returned no usable glTF: ${(error as Error).message}`);
    }
    const routeForward = call.route(MODEL_OPERATION).forward ?? "+z";
    const facing = await judgeFacing(call, source, routeForward, settings.turntablePx);
    const facingParameters = {
      answer: facing.facing ?? facing.choice,
      ...(facing.probability !== undefined && {
        probability: Math.round(facing.probability * 1e4) / 1e4,
      }),
      routeForward,
    };
    if (!facing.reason.passed) {
      // No rig, clip or identity call is paid for a model the rig would fit backwards.
      return {
        output: {
          mediaType: GLB_MEDIA_TYPE,
          extension: "glb",
          bytes: made.glb,
          fields: { gait: character.gait, facing: facingParameters },
        },
        qa: { passed: false, reasons: [facing.reason] },
        prompt: text,
        parameters: {
          gait: character.gait,
          forward: settings.forward,
          ...(character.heightM !== undefined && { heightM: character.heightM }),
          references: viewRecord(references),
          facing: facingParameters,
        },
        artifacts: facing.renders.map((r) => ({
          name: `facing-yaw-${r.yawDeg}.png`,
          bytes: r.bytes,
        })),
      };
    }
    let rigged: Awaited<ReturnType<typeof riggedCandidate>> | undefined;
    if (rig) {
      rigged = await riggedCandidate({
        source,
        sourceSha256: sha256(made.glb),
        sourceForward: routeForward,
        settings,
        character,
        rig,
      });
    }
    const built = rigged ? undefined : await providerRigged();
    const reasons: Reason[] = [facing.reason, ...(rigged ? rigged.reasons : built!.reasons)];
    const renders: TurntableFrame[] = rigged ? rigged.renders : built!.renders;

    async function providerRigged() {
      const rigRoute = call.route(RIG_OPERATION);
      const rigType = rigRoute.rigTypes?.[character.gait] ?? character.gait;
      const rigged = await call.rig3d(RIG_OPERATION, made.handle, rigType);
      const plan = await resolveClipPlan(
        call,
        character,
        CLIPS_OPERATION,
        context.clipMaps ?? new ClipMapCache(),
      );
      const parse = (bytes: Uint8Array): Glb => {
        try {
          return parseGlb(bytes);
        } catch (error) {
          throw new ProviderError(
            `the provider returned no usable glTF: ${(error as Error).message}`,
          );
        }
      };
      // One clip per call: the animation of the result is tied to the clip that was asked for.
      let glb: Glb | undefined;
      const delivered: typeof plan.planned = [];
      const unmatched: Array<{ family: string; why: string }> = [];
      for (const p of plan.planned) {
        const result = await call.clips3d(CLIPS_OPERATION, rigged.handle, [p.clip]);
        const from = parse(result.glb);
        const count = from.json.animations?.length ?? 0;
        const given = result.animations?.[p.clip];
        let index: number | undefined;
        if (given !== undefined) {
          if (Number.isInteger(given) && given >= 0 && given < count) index = given;
          else {
            unmatched.push({
              family: p.family,
              why: `the provider pointed at animation ${given} for library clip ${p.clip} but returned ${count}`,
            });
            continue;
          }
        } else if (count === 1) index = 0;
        else {
          unmatched.push({
            family: p.family,
            why: `the provider returned ${count} animations for library clip ${p.clip} and did not say which is the clip`,
          });
          continue;
        }
        if (!glb) {
          glb = from;
          keepClips(glb, [index]);
        } else {
          try {
            appendAnimation(glb, from, index);
          } catch (error) {
            if (!(error instanceof InputError)) throw error;
            unmatched.push({ family: p.family, why: error.message });
            continue;
          }
        }
        delivered.push(p);
      }
      if (!glb) {
        glb = parse(rigged.glb);
        keepClips(glb, []);
      }
      renameClips(glb, new Map(delivered.map((p, i) => [i, p.family])));
      // Only families the library has no close clip for are excused; a library clip that was
      // requested but not returned fails its clip check.
      const missing = plan.missing;
      const closed: Record<string, number> = {};
      delivered.forEach((p, i) => {
        if (p.loop) closed[p.family] = closeLoop(glb, i);
      });
      const bounds = normalize(glb, {
        sourceForward: routeForward,
        forward: settings.forward,
        ...(character.heightM !== undefined && { heightM: character.heightM }),
      });
      // glTF has no playback-loop flag; targets read each clip's from its extras, as the manifest says.
      for (const animation of glb.json.animations ?? []) {
        const loop = delivered.find((p) => p.family === animation.name)?.loop ?? false;
        animation["extras"] = { ...(animation["extras"] as object | undefined), loop };
      }
      const bytes = writeGlb(glb);
      const written = parseGlb(bytes);
      const measures = measure(written);
      const height = bounds.max[1] - bounds.min[1];

      const reasons: Reason[] = [
        await validatorCheck(bytes),
        hierarchyCheck(written, measures),
        ...budgetChecks(measures, settings),
        skeletonCheck(measures),
        ...clipChecks(written, plan.planned, missing, settings, height, unmatched),
      ];

      const renders = renderTurntable(written, {
        sizePx: settings.turntablePx,
        framesPerClip: FRAMES_PER_CLIP,
        forwardYawDeg: (yawBetween("+z", settings.forward) * 180) / Math.PI,
      });
      reasons.push({
        check: "turntable",
        passed: renders.length >= 4,
        reason: `${renders.length} render(s) from a fixed camera and light: ${renders.map((r) => r.name).join(", ")}`,
        source: "deterministic",
      });
      return {
        reasons,
        renders,
        bytes,
        written,
        measures,
        bounds,
        plan,
        delivered,
        missing,
        unmatched,
        closed,
        rigType,
      };
    }

    const referenceParameters = viewRecord(references);
    let identity: IdentityScore | undefined;
    const identityMode = identitySettings3d(profile);
    if (identityMode.mode !== "off") {
      const views = ["front", "three-quarter"].map((name) => {
        const render = renders.find((r) => r.view === name && r.clip === undefined);
        if (!render) throw new Error(`no ${name} render`);
        return decodeImage(render.png);
      });
      const composite = encodePng(sideBySide(views));
      identity = await scoreIdentity({
        caller: call,
        record: identityRecordOf(spec, bible, references),
        references,
        candidate: {
          role: "candidate turntable",
          path: "(front and three-quarter renders)",
          mediaType: "image/png",
          bytes: composite,
          sha256: sha256(composite),
        },
        describe:
          "turntable renders of a 3D character model, front view on the left and three-quarter view on the right",
        settings: identityMode,
      });
      reasons.push(identityReason(identity));
    }

    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    const identityFields = identity && { identity };
    if (rigged) {
      const { measures } = rigged;
      return {
        output: {
          mediaType: GLB_MEDIA_TYPE,
          extension: "glb",
          bytes: rigged.bytes,
          fields: {
            triangles: measures.triangles,
            textureMaxPx: measures.textureMaxPx,
            materials: measures.materials,
            bones: measures.bones,
            lods: measures.lods,
            ...rigged.fields,
            gait: character.gait,
            facing: facingParameters,
            ...identityFields,
          },
        },
        qa: { passed: qaPassed(reasons), reasons },
        prompt: text,
        parameters: {
          gait: character.gait,
          ...rigged.parameters,
          targetProfileSha256: profileSha256(profile),
          forward: settings.forward,
          ...(character.heightM !== undefined && { heightM: character.heightM }),
          references: referenceParameters,
          facing: facingParameters,
        },
        artifacts: rigged.artifacts,
      };
    }
    const { written, measures, bounds, plan, delivered, missing, unmatched, closed, rigType } =
      built!;
    const clipFields = clips(written).map((c) => ({
      name: c.name,
      durationMs: Math.round(c.durationS * 1000),
      loop: delivered.find((p) => p.family === c.name)?.loop ?? false,
    }));
    return {
      output: {
        mediaType: GLB_MEDIA_TYPE,
        extension: "glb",
        bytes: built!.bytes,
        fields: {
          triangles: measures.triangles,
          textureMaxPx: measures.textureMaxPx,
          materials: measures.materials,
          bones: measures.bones,
          lods: measures.lods,
          clips: clipFields,
          bounds: { min: bounds.min.map(round), max: bounds.max.map(round) },
          gait: character.gait,
          facing: facingParameters,
          missingClips: missing,
          ...(plan.mapped.length > 0 && { mappedClips: plan.mapped }),
          ...(unmatched.length > 0 && { unmatchedClips: unmatched }),
          ...identityFields,
        },
      },
      qa: { passed: qaPassed(reasons), reasons },
      prompt: text,
      parameters: {
        gait: character.gait,
        rigType,
        clips: plan.planned.map((p) => ({ family: p.family, clip: p.clip, loop: p.loop })),
        missingClips: missing,
        ...(plan.mapped.length > 0 && { mappedClips: plan.mapped }),
        ...(unmatched.length > 0 && { unmatchedClips: unmatched }),
        loopClosedChannels: closed,
        forward: settings.forward,
        ...(character.heightM !== undefined && { heightM: character.heightM }),
        references: referenceParameters,
        facing: facingParameters,
      },
      artifacts: renders.map((r) => ({ name: r.name, bytes: r.png })),
    };
  },
};
