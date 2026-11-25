/** The icons pack's entry for core's extension API (api 2): the `icons:family` kind. */
import type { Extension, ExtensionContext } from "@clockgrove/assetgrove/extension";
import { iconsFamilyKind } from "./kind.ts";

export default function iconsExtension(context: ExtensionContext): Extension {
  return { api: context.api, name: "icons", kinds: [iconsFamilyKind(context)] };
}
