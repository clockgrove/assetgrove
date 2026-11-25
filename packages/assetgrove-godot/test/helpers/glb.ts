/**
 * A synthetic skinned character as a binary glTF, built with glTF Transform: one box mesh skinned
 * to a two-joint chain (`hips`, `spine`), and one animation per name rotating the spine.
 */
import { Document, NodeIO } from "@gltf-transform/core";

export interface GlbOptions {
  /** The animations' names, in order. */
  animations: string[];
  /** How many separate box meshes the scene holds, each skinned to the chain; 1 by default. */
  meshes?: number;
  /** Whether the meshes are skinned to the chain; true by default. Unskinned, the chain is plain nodes. */
  skin?: boolean;
}

const BOX_POSITIONS = [
  [-0.1, 0, -0.1],
  [0.1, 0, -0.1],
  [0.1, 0, 0.1],
  [-0.1, 0, 0.1],
  [-0.1, 0.4, -0.1],
  [0.1, 0.4, -0.1],
  [0.1, 0.4, 0.1],
  [-0.1, 0.4, 0.1],
];
const BOX_INDICES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4,
  3, 4, 7,
];

/** The GLB's bytes. */
export async function characterGlb(options: GlbOptions): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("character");
  const root = doc.createNode("character");
  scene.addChild(root);

  const hips = doc.createNode("hips").setTranslation([0, 0, 0]);
  const spine = doc.createNode("spine").setTranslation([0, 0.2, 0]);
  hips.addChild(spine);
  root.addChild(hips);
  const skin =
    options.skin !== false
      ? doc
          .createSkin("rig")
          .addJoint(hips)
          .addJoint(spine)
          .setSkeleton(hips)
          .setInverseBindMatrices(
            doc
              .createAccessor("inverseBinds")
              .setType("MAT4")
              .setBuffer(buffer)
              .setArray(
                new Float32Array([
                  ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                  ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.2, 0, 1],
                ]),
              ),
          )
      : undefined;

  for (let m = 0; m < (options.meshes ?? 1); m++) {
    const position = doc
      .createAccessor()
      .setType("VEC3")
      .setBuffer(buffer)
      .setArray(new Float32Array(BOX_POSITIONS.flatMap(([x, y, z]) => [x! + m * 0.3, y!, z!])));
    const joints = () =>
      doc
        .createAccessor()
        .setType("VEC4")
        .setBuffer(buffer)
        .setArray(new Uint8Array(BOX_POSITIONS.flatMap(([, y]) => [y! > 0.2 ? 1 : 0, 0, 0, 0])));
    const weights = () =>
      doc
        .createAccessor()
        .setType("VEC4")
        .setBuffer(buffer)
        .setArray(new Float32Array(BOX_POSITIONS.flatMap(() => [1, 0, 0, 0])));
    const indices = doc
      .createAccessor()
      .setType("SCALAR")
      .setBuffer(buffer)
      .setArray(new Uint16Array(BOX_INDICES));
    const primitive = doc
      .createPrimitive()
      .setAttribute("POSITION", position)
      .setIndices(indices)
      .setMaterial(doc.createMaterial(`body-${m}`).setBaseColorFactor([0.4, 0.6, 0.3, 1]));
    if (skin) primitive.setAttribute("JOINTS_0", joints()).setAttribute("WEIGHTS_0", weights());
    const mesh = doc.createMesh(`body-${m}`).addPrimitive(primitive);
    const body = doc.createNode(`body-${m}`).setMesh(mesh);
    if (skin) body.setSkin(skin);
    root.addChild(body);
  }

  for (const name of options.animations) {
    const times = doc
      .createAccessor()
      .setType("SCALAR")
      .setBuffer(buffer)
      .setArray(new Float32Array([0, 0.5, 1]));
    const s = Math.sin(Math.PI / 16);
    const c = Math.cos(Math.PI / 16);
    const rotations = doc
      .createAccessor()
      .setType("VEC4")
      .setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 1, s, 0, 0, c, 0, 0, 0, 1]));
    const sampler = doc
      .createAnimationSampler()
      .setInput(times)
      .setOutput(rotations)
      .setInterpolation("LINEAR");
    const channel = doc
      .createAnimationChannel()
      .setTargetNode(spine)
      .setTargetPath("rotation")
      .setSampler(sampler);
    doc.createAnimation(name).addSampler(sampler).addChannel(channel);
  }
  return new NodeIO().writeBinary(doc);
}
