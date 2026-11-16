/**
 * Keeps cbor-x (which `@auth0/cose` uses) on its JavaScript decoder. cbor-x otherwise loads the
 * optional `cbor-extract` native addon when it is installed, and this repository runs no native
 * binary (docs/decisions.md, "Content credentials"). Imported before `@auth0/cose`, because cbor-x
 * reads the variable once, when it loads.
 */
import { disableNativeCbor } from "./env.ts";

disableNativeCbor();
