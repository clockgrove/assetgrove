/** The tiles pack's entry for core's extension API (api 2): the `tiles:terrain` kind. */
import type { Extension, ExtensionContext } from "@clockgrove/assetgrove/extension";
import { tilesTerrainKind } from "./kind.ts";

export default function tilesExtension(context: ExtensionContext): Extension {
  return { api: context.api, name: "tiles", kinds: [tilesTerrainKind(context)] };
}
