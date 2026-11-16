/** A provider script like `script.ts` whose still differs from it, so a second pick makes a new version. */
import script from "./script.ts";
import { encodePng } from "../../src/image/raster.ts";
import { drawSubject } from "./synthetic.ts";

export default {
  ...script,
  image: () => ({
    images: [{ mediaType: "image/png", bytes: encodePng(drawSubject(128, 0, [230, 236, 245])) }],
  }),
};
