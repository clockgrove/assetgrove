/** The tiles pack's entry for core's extension API (api 3): the `tiles:terrain` kind. */
import type { Extension, ExtensionContext } from "@clockgrove/assetgrove/extension";
import { tilesTerrainKind } from "./kind.ts";

export default function tilesExtension(context: ExtensionContext): Extension {
  return { api: context.api, name: "tiles", kinds: [tilesTerrainKind(context)] };
}
