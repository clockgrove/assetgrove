/**
 * A `--provider-script` module for `card describe` (#432): every vision call answers one summary
 * whose description holds a word no card, title or tag of the fixture library holds.
 */
export const WORD = "samovar";

export default {
  paid: true,
  image: () => {
    throw new Error("this script only describes");
  },
  vision: () => ({
    text: JSON.stringify({
      description: `A copper ${WORD} kettle with a brass tap, for a cottage kitchen scene.`,
      tags: ["kitchen", "copper"],
    }),
    costUsd: 0.001,
  }),
};
