import { normalize, type Embedder } from "./embedder.ts";
import type { SearchRouteEmbedder } from "@clockgrove/assetgrove/extension";
import { SearchError } from "./errors.ts";

/**
 * Embeds through the provider route core resolved. Built per call: the port differs between a
 * paid run, which carries `embed`, and a read, which does not.
 */
export class RouteEmbedder implements Embedder {
  readonly id = "route";
  /** Every call is a provider call that costs money. */
  readonly paid = true;
  readonly revision: string;
  readonly route: string;
  readonly model: string;
  readonly dimension: number;
  private readonly port: SearchRouteEmbedder;

  constructor(port: SearchRouteEmbedder) {
    this.port = port;
    this.route = port.route;
    this.model = port.model;
    // The route is part of the revision, so the vector cache and the table names keep one
    // provider's vectors apart from another's for the same model name.
    this.revision = `${port.route}/${port.model}`;
    this.dimension = port.dimension;
  }

  private async embedEach(inputs: ({ image: Uint8Array } | { text: string })[]) {
    if (inputs.length > 0 && !this.port.embed) {
      throw new SearchError(
        "invalid_input",
        "This needs the hosted embedder, which embeds only in a paid request that was confirmed first.",
        {
          hint: "Use the find tool (assetgrove find) with words, or search index; both ask before they spend.",
        },
      );
    }
    const out: Float32Array[] = [];
    for (const input of inputs) {
      const vec = await (this.port.embed as NonNullable<SearchRouteEmbedder["embed"]>)(input);
      if (vec.length !== this.dimension) {
        throw new SearchError(
          "invalid_input",
          `The ${this.route} route returned a vector of ${vec.length} numbers; the embedder expects ${this.dimension}.`,
          { details: { route: this.route, model: this.model, got: vec.length } },
        );
      }
      out.push(normalize(Float32Array.from(vec)));
    }
    return out;
  }

  embedImages(images: Uint8Array[]): Promise<Float32Array[]> {
    return this.embedEach(images.map((image) => ({ image })));
  }

  embedTexts(texts: string[]): Promise<Float32Array[]> {
    return this.embedEach(texts.map((text) => ({ text })));
  }
}
