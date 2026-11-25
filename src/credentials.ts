/**
 * C2PA content credentials (design section 6, assetgrove#251): a signed manifest in each PNG,
 * JPEG and WebP hand-off writes, beside the IPTC mark. The manifest is built, embedded and read
 * by the Content Authenticity Initiative's SDK (`@contentauth/c2pa-wasm`, c2pa-rs in
 * WebAssembly); its signer callback must return a whole COSE_Sign1, which `@auth0/cose` builds.
 * Assetgrove writes no JUMBF or COSE itself (docs/decisions.md).
 *
 * The signer is the developer's certificate and key from the developer settings
 * (`contentCredentials`), or else a development certificate created once in the state directory.
 */
import { createHash, createPrivateKey, webcrypto, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import "./pure-cbor.ts";
import { Algorithms, Headers, ProtectedHeaders, Sign1 } from "@auth0/cose";
import { initSync, WasmBuilder, WasmReader } from "@contentauth/c2pa-wasm";
import type { DigitalSourceType } from "./metadata.ts";
import { hasC2paChunk, modelText } from "./metadata.ts";
import { SettingsError } from "./errors.ts";

/** The media types C2PA credentials are written into. */
const SIGNABLE = new Set(["image/png", "image/jpeg", "image/webp", "audio/wav"]);
/** The assertion that names the sha256 of the bytes a manifest was signed over. */
export const INPUT_ASSERTION = "org.clockgrove.assetgrove.input";
/** The development certificate's directory under the state directory. */
export const DEVELOPMENT_DIR = "content-credentials";
/** Validation codes that do not fail the check: no trust list is configured. */
const ACCEPTED_FAILURES = new Set(["signingCredential.untrusted"]);

/** What a result says when the local development certificate signed. */
export const DEVELOPMENT_SIGNER_WARNING =
  "signed with Assetgrove's local development certificate, which no C2PA trust list holds; set contentCredentials in the developer settings to sign with your own certificate";

/** Whether a media type is one C2PA credentials are written into. */
export function canCarryCredentials(mediaType: string): boolean {
  return SIGNABLE.has(mediaType);
}

type Alg = "es256" | "es384" | "ps256" | "ed25519";
const COSE_ALG: Record<Alg, Algorithms> = {
  es256: Algorithms.ES256,
  es384: Algorithms.ES384,
  ps256: Algorithms.PS256,
  ed25519: Algorithms.EdDSA,
};

/** Which certificate signs, as recorded in provenance and results. */
export interface SignerRecord {
  /** True for the local development certificate, which no C2PA trust list holds. */
  development: boolean;
  /** The sha256 of the signing (leaf) certificate's DER bytes. */
  certificateSha256: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  alg: Alg;
}

/** A signer: its record, key and certificate chain (leaf first, DER). */
export interface ContentSigner {
  record: SignerRecord;
  key: KeyObject;
  chain: Uint8Array[];
}

/** The developer settings' content credentials: absolute paths to a PEM chain and a PEM key. */
export interface CredentialSettings {
  certificate: string;
  privateKey: string;
}

let loaded = false;
const BYTES = Symbol("bytes");

/** A Blob whose bytes the SDK can read synchronously in Node, through `FileReaderSync`. */
class BytesBlob extends Blob {
  readonly [BYTES]: Uint8Array;
  constructor(bytes: Uint8Array) {
    super([bytes as Uint8Array<ArrayBuffer>]);
    this[BYTES] = bytes;
  }
  override slice(start = 0, end = this[BYTES].length): BytesBlob {
    return new BytesBlob(this[BYTES].subarray(start, end));
  }
}

/** Initialises the SDK once. The SDK reads a Blob with the browser's `FileReaderSync`. */
function sdk(): void {
  if (loaded) return;
  const g = globalThis as Record<string, unknown>;
  if (g["FileReaderSync"] === undefined) {
    g["FileReaderSync"] = class {
      readAsArrayBuffer(blob: unknown): ArrayBuffer {
        const bytes = (blob as Partial<BytesBlob>)[BYTES];
        if (bytes === undefined) throw new TypeError("only in-memory bytes can be read");
        // A copy: a Buffer's slice is a view onto its whole pool.
        return new Uint8Array(bytes).buffer;
      }
    };
  }
  const wasm = fileURLToPath(import.meta.resolve("@contentauth/c2pa-wasm/c2pa.wasm"));
  initSync({ module: readFileSync(wasm) });
  loaded = true;
}

function algOf(key: KeyObject): Alg {
  const type = key.asymmetricKeyType;
  if (type === "ed25519") return "ed25519";
  if (type === "rsa" || type === "rsa-pss") return "ps256";
  if (type === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve === "prime256v1" || curve === "P-256") return "es256";
    if (curve === "secp384r1" || curve === "P-384") return "es384";
  }
  throw new SettingsError(
    `contentCredentials.privateKey is a ${type ?? "unknown"} key; use ECDSA P-256 or P-384, Ed25519 or RSA`,
  );
}

function pemCertificates(pem: string): Uint8Array[] {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    (m) => new Uint8Array(new X509Certificate(m[0]).raw),
  );
}

function signerOf(chain: Uint8Array[], key: KeyObject, development: boolean): ContentSigner {
  const leaf = new X509Certificate(chain[0]!);
  return {
    key,
    chain,
    record: {
      development,
      certificateSha256: createHash("sha256").update(chain[0]!).digest("hex"),
      subject: leaf.subject.replaceAll("\n", ", "),
      issuer: leaf.issuer.replaceAll("\n", ", "),
      serialNumber: leaf.serialNumber,
      alg: algOf(key),
    },
  };
}

/** The developer's signer, read from the files the developer settings name. */
export function settingsSigner(settings: CredentialSettings): ContentSigner {
  let pem: string;
  let keyPem: string;
  try {
    pem = readFileSync(settings.certificate, "utf8");
    keyPem = readFileSync(settings.privateKey, "utf8");
  } catch (error) {
    throw new SettingsError(
      `contentCredentials: cannot read ${(error as { path?: string }).path ?? "a file"}`,
      { cause: error },
    );
  }
  const chain = pemCertificates(pem);
  if (chain.length === 0)
    throw new SettingsError(
      `contentCredentials.certificate ${settings.certificate} holds no certificate`,
    );
  let key: KeyObject;
  try {
    key = createPrivateKey(keyPem);
  } catch (error) {
    throw new SettingsError(
      `contentCredentials.privateKey ${settings.privateKey} is not a PEM private key`,
      { cause: error },
    );
  }
  return signerOf(chain, key, false);
}

const pem = (label: string, der: Uint8Array): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trimEnd()}\n-----END ${label}-----\n`;

function name(common: string): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: "2.5.4.3",
        value: new asn1js.Utf8String({ value: common }),
      }),
    ],
  });
}

const keyUsage = (bits: number, unused: number): pkijs.Extension =>
  new pkijs.Extension({
    extnID: "2.5.29.15",
    critical: true,
    extnValue: new asn1js.BitString({
      valueHex: new Uint8Array([bits]).buffer,
      unusedBits: unused,
    }).toBER(false),
  });

async function keyId(key: CryptoKey): Promise<ArrayBuffer> {
  const spki = await webcrypto.subtle.exportKey("spki", key);
  const info = new pkijs.PublicKeyInfo({ schema: asn1js.fromBER(spki).result });
  return webcrypto.subtle.digest("SHA-1", info.subjectPublicKey.valueBlock.valueHexView);
}

async function certificate(input: {
  serial: number;
  subject: string;
  issuer: string;
  publicKey: CryptoKey;
  signingKey: CryptoKey;
  issuerKey: CryptoKey;
  ca: boolean;
  now: Date;
}): Promise<Uint8Array> {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: input.serial });
  cert.issuer = name(input.issuer);
  cert.subject = name(input.subject);
  cert.notBefore.value = new Date(input.now.getTime() - 24 * 3600 * 1000);
  cert.notAfter.value = new Date(input.now.getTime() + 10 * 365 * 24 * 3600 * 1000);
  const basic = new pkijs.BasicConstraints({ cA: input.ca });
  cert.extensions = [
    new pkijs.Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: basic.toSchema().toBER(false),
    }),
    // keyCertSign and cRLSign for the CA, digitalSignature for the signer.
    input.ca ? keyUsage(0x06, 1) : keyUsage(0x80, 7),
    new pkijs.Extension({
      extnID: "2.5.29.14",
      extnValue: new asn1js.OctetString({ valueHex: await keyId(input.publicKey) }).toBER(false),
    }),
  ];
  if (!input.ca) {
    cert.extensions.push(
      new pkijs.Extension({
        extnID: "2.5.29.37",
        extnValue: new pkijs.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.4"] })
          .toSchema()
          .toBER(false),
      }),
      new pkijs.Extension({
        extnID: "2.5.29.35",
        extnValue: new pkijs.AuthorityKeyIdentifier({
          keyIdentifier: new asn1js.OctetString({ valueHex: await keyId(input.issuerKey) }),
        })
          .toSchema()
          .toBER(false),
      }),
    );
  }
  await cert.subjectPublicKeyInfo.importKey(input.publicKey, pkijs.getCrypto(true));
  await cert.sign(input.signingKey, "SHA-256", pkijs.getCrypto(true));
  return new Uint8Array(cert.toSchema(true).toBER(false));
}

/**
 * The local development signer: a CA and a signer certificate (c2pa-rs refuses a self-signed
 * signer), ECDSA P-256, created once under `<stateDir>/content-credentials/` and reused. The CA's
 * certificate is written beside them as `ca.pem`, so a reader can be told to trust it.
 */
export async function developmentSigner(stateDir: string): Promise<ContentSigner> {
  const dir = join(stateDir, DEVELOPMENT_DIR);
  const chainPath = join(dir, "chain.pem");
  const keyPath = join(dir, "signer.key");
  if (!existsSync(chainPath) || !existsSync(keyPath)) {
    pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto }));
    const alg = { name: "ECDSA", namedCurve: "P-256" };
    const ca = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const signer = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const now = new Date();
    const caName = "Assetgrove development CA (not trusted)";
    const caDer = await certificate({
      serial: 1,
      subject: caName,
      issuer: caName,
      publicKey: ca.publicKey,
      signingKey: ca.privateKey,
      issuerKey: ca.publicKey,
      ca: true,
      now,
    });
    const leafDer = await certificate({
      serial: 2,
      subject: "Assetgrove development signer (not trusted)",
      issuer: caName,
      publicKey: signer.publicKey,
      signingKey: ca.privateKey,
      issuerKey: ca.publicKey,
      ca: false,
      now,
    });
    const key = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", signer.privateKey));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ca.pem"), pem("CERTIFICATE", caDer));
    writeFileSync(`${keyPath}.tmp`, pem("PRIVATE KEY", key), { mode: 0o600 });
    renameSync(`${keyPath}.tmp`, keyPath);
    writeFileSync(`${chainPath}.tmp`, pem("CERTIFICATE", leafDer) + pem("CERTIFICATE", caDer));
    renameSync(`${chainPath}.tmp`, chainPath);
  }
  const chain = pemCertificates(readFileSync(chainPath, "utf8"));
  return signerOf(chain, createPrivateKey(readFileSync(keyPath, "utf8")), true);
}

/** The signer the developer settings choose: their certificate, else the development one. */
export async function resolveSigner(settings: {
  stateDir: string;
  contentCredentials?: CredentialSettings;
}): Promise<ContentSigner> {
  return settings.contentCredentials
    ? settingsSigner(settings.contentCredentials)
    : developmentSigner(settings.stateDir);
}

/** What a manifest says: how the file was made, and from what. */
export interface CredentialClaim {
  digitalSourceType: DigitalSourceType;
  models: readonly string[];
  /** The file's name, for the manifest's title. */
  title: string;
  /** For an adopted hand edit: the AI-made original, carried as the `parentOf` ingredient. */
  original?: { bytes: Uint8Array; mediaType: string; title: string };
}

const IPTC = "http://cv.iptc.org/newscodes/digitalsourcetype/";

/** The `c2pa.actions.v2` actions a claim records. */
function actions(claim: CredentialClaim): Record<string, unknown>[] {
  const models = modelText(claim.models);
  const agent = models === undefined ? {} : { softwareAgent: { name: models } };
  const source =
    claim.digitalSourceType === "undeclared" ? {} : { digitalSourceType: claim.digitalSourceType };
  if (claim.original === undefined) return [{ action: "c2pa.created", ...source, ...agent }];
  return [
    { action: "c2pa.opened", parameters: { ingredientIds: ["original"] } },
    {
      action: "c2pa.edited",
      description: "A person's hand edit of the AI-made original, adopted into the library",
      digitalSourceType: `${IPTC}compositeWithTrainedAlgorithmicMedia`,
      ...agent,
    },
  ];
}

/** The sha256 of bytes, as hex. */
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** COSE_Sign1 with a detached payload and a `pad` header that fills the reserved space exactly. */
async function coseSign(
  signer: ContentSigner,
  claim: Uint8Array,
  size: number,
): Promise<Uint8Array> {
  const signed = await Sign1.sign(
    new ProtectedHeaders([
      [Headers.Algorithm, COSE_ALG[signer.record.alg]],
      [Headers.X5Chain, signer.chain.length === 1 ? signer.chain[0]! : signer.chain],
    ]),
    undefined,
    claim,
    signer.key,
  );
  // The payload is detached (C2PA: the claim is the payload, carried beside the signature).
  const encode = (pad: number): Uint8Array =>
    new Sign1(
      // The protected header exactly as signed.
      (signed as unknown as { encodedProtectedHeaders: Uint8Array }).encodedProtectedHeaders,
      new Map([["pad", new Uint8Array(pad)]]) as unknown as Map<number, unknown>,
      null as unknown as Uint8Array,
      signed.signature,
    ).encode();
  let pad = 0;
  let out = encode(pad);
  for (let i = 0; i < 4 && out.length !== size; i++) {
    pad = Math.max(0, pad + size - out.length);
    out = encode(pad);
  }
  if (out.length !== size)
    throw new Error(`the COSE signature is ${out.length} bytes, not ${size}`);
  return out;
}

/** Signs `bytes` (already IPTC-marked) with a manifest for `claim`; returns the signed bytes. */
export async function signCredentials(
  bytes: Uint8Array,
  mediaType: string,
  claim: CredentialClaim,
  signer: ContentSigner,
  version: string,
): Promise<Uint8Array> {
  sdk();
  const definition = {
    claim_generator_info: [{ name: "Assetgrove", version }],
    title: claim.title,
    format: mediaType,
    assertions: [
      { label: "c2pa.actions.v2", data: { actions: actions(claim) } },
      {
        label: INPUT_ASSERTION,
        data: {
          sha256: sha256(bytes),
          certificateSha256: signer.record.certificateSha256,
          development: signer.record.development,
        },
      },
    ],
  };
  const builder = WasmBuilder.fromJson(JSON.stringify(definition));
  try {
    if (claim.original) {
      await builder.addIngredientFromBlob(
        JSON.stringify({
          title: claim.original.title,
          relationship: "parentOf",
          label: "original",
        }),
        claim.original.mediaType,
        new BytesBlob(claim.original.bytes),
      );
    }
    if (!claim.original && mediaType === "audio/wav" && hasC2paChunk(bytes)) {
      // A vendor's manifest in the source is replaced by ours; it stays as an ingredient.
      await builder.addIngredientFromBlob(
        JSON.stringify({
          title: `vendor ${claim.title}`,
          relationship: "componentOf",
          label: "vendor",
        }),
        mediaType,
        new BytesBlob(bytes),
      );
    }
    const size = signer.chain.reduce((n, der) => n + der.length, 0) + 4096;
    const signed = await builder.sign(
      {
        alg: signer.record.alg,
        reserveSize: size,
        sign: async (data: Uint8Array) =>
          (await coseSign(signer, data, size)) as Uint8Array<ArrayBuffer>,
      },
      [],
      mediaType,
      new BytesBlob(bytes),
    );
    return new Uint8Array(signed);
  } finally {
    builder.free();
  }
}

/** A manifest as read back and validated. */
export interface ReadCredentials {
  /** The SDK's validation state: `Invalid`, `Valid` or `Trusted`. */
  state: string;
  /** Validation failures, other than an untrusted signing credential. */
  failures: { code: string; explanation?: string }[];
  /** Whether the signing credential is on a trust list the reader was given. */
  trusted: boolean;
  actions: { action: string; digitalSourceType?: string; softwareAgent?: string }[];
  /** The sha256 the manifest names for the bytes it was signed over. */
  inputSha256?: string;
  /** The sha256 of the signing certificate, as the manifest names it. */
  certificateSha256?: string;
  /** Whether the manifest says Assetgrove's development certificate signed it. */
  development?: boolean;
  ingredients: { title?: string; relationship?: string; validationState?: string }[];
  signer: { subject?: string; issuer?: string; serialNumber?: string };
}

interface ManifestJson {
  assertions?: { label: string; data?: Record<string, unknown> }[];
  ingredients?: { title?: string; relationship?: string; validation_results?: unknown }[];
  signature_info?: { common_name?: string; issuer?: string; cert_serial_number?: string };
}

/**
 * Reads and validates the active manifest of `bytes`; undefined when there is none. Offline: no
 * OCSP or remote manifest fetch. `trustAnchors` (PEM) are certificates to trust.
 */
export async function readCredentials(
  bytes: Uint8Array,
  mediaType: string,
  trustAnchors?: string,
): Promise<ReadCredentials | undefined> {
  sdk();
  const context = {
    verify: { ocsp_fetch: false, remote_manifest_fetch: false },
    ...(trustAnchors !== undefined && { trust: { trust_anchors: trustAnchors } }),
  };
  let reader: WasmReader;
  try {
    reader = await WasmReader.fromBytes(mediaType, bytes, JSON.stringify(context));
  } catch (error) {
    if (/JumbfNotFound|ProvenanceMissing|NotFound/.test(String(error))) return undefined;
    return {
      state: "Invalid",
      failures: [{ code: "manifest.unreadable", explanation: String(error) }],
      trusted: false,
      actions: [],
      ingredients: [],
      signer: {},
    };
  }
  try {
    const store = JSON.parse(reader.json()) as {
      active_manifest?: string;
      manifests?: Record<string, ManifestJson>;
      validation_state?: string;
      validation_results?: {
        activeManifest?: {
          failure?: { code: string; explanation?: string }[];
          success?: { code: string }[];
        };
      };
      validation_status?: { code: string; explanation?: string }[];
    };
    const manifest = store.manifests?.[store.active_manifest ?? ""];
    if (manifest === undefined) return undefined;
    const results = store.validation_results?.activeManifest;
    const failures = (results?.failure ?? store.validation_status ?? [])
      .filter((f) => !ACCEPTED_FAILURES.has(f.code))
      .map((f) => ({
        code: f.code,
        ...(f.explanation !== undefined && { explanation: f.explanation }),
      }));
    const assertions = manifest.assertions ?? [];
    const actionList = assertions
      .filter((a) => a.label === "c2pa.actions.v2" || a.label === "c2pa.actions")
      .flatMap((a) =>
        Array.isArray(a.data?.["actions"]) ? (a.data["actions"] as Record<string, unknown>[]) : [],
      )
      .map((a) => ({
        action: String(a["action"]),
        ...(typeof a["digitalSourceType"] === "string" && {
          digitalSourceType: a["digitalSourceType"],
        }),
        ...(typeof (a["softwareAgent"] as { name?: unknown } | undefined)?.name === "string" && {
          softwareAgent: (a["softwareAgent"] as { name: string }).name,
        }),
      }));
    const own = assertions.find((a) => a.label === INPUT_ASSERTION)?.data ?? {};
    const input = own["sha256"];
    const certificate = own["certificateSha256"];
    const info = manifest.signature_info ?? {};
    return {
      state: store.validation_state ?? "Invalid",
      failures,
      trusted: (results?.success ?? []).some((s) => s.code === "signingCredential.trusted"),
      actions: actionList,
      ...(typeof input === "string" && { inputSha256: input }),
      ...(typeof certificate === "string" && { certificateSha256: certificate }),
      ...(typeof own["development"] === "boolean" && { development: own["development"] }),
      ingredients: (manifest.ingredients ?? []).map((i) => ({
        ...(i.title !== undefined && { title: i.title }),
        ...(i.relationship !== undefined && { relationship: i.relationship }),
      })),
      signer: {
        ...(info.common_name !== undefined && { subject: info.common_name }),
        ...(info.issuer !== undefined && { issuer: info.issuer }),
        ...(info.cert_serial_number !== undefined && { serialNumber: info.cert_serial_number }),
      },
    };
  } finally {
    reader.free();
  }
}

/** The problem codes of a file's credentials. */
export type CredentialProblemCode =
  "credentials_missing" | "credentials_invalid" | "credentials_mismatch";

/** What a file's manifest must say. */
export interface ExpectedCredentials {
  digitalSourceType: DigitalSourceType;
  models: readonly string[];
  /** True for an adopted hand edit, whose manifest records the edit of an original. */
  adopted?: boolean;
}

/** One problem with a written file's credentials; undefined when they hold. */
export async function credentialProblem(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
  expected: ExpectedCredentials,
): Promise<{ code: CredentialProblemCode; problem: string } | undefined> {
  const read = await readCredentials(bytes, mediaType);
  if (read === undefined)
    return { code: "credentials_missing", problem: `${path} lacks its C2PA content credentials` };
  const binding = read.failures.find((f) =>
    /^assertion\.(dataHash|bmffHash|boxesHash)\./.test(f.code),
  );
  if (binding)
    return {
      code: "credentials_mismatch",
      problem: `${path}'s C2PA manifest does not match its bytes (${binding.code})`,
    };
  if (read.failures.length > 0 || read.state === "Invalid")
    return {
      code: "credentials_invalid",
      problem: `${path}'s C2PA manifest is invalid (${read.failures.map((f) => f.code).join(", ") || read.state})`,
    };
  const wanted = expectedActions(expected);
  const got = read.actions.map((a) => a.action);
  const lastAction = read.actions.at(-1);
  const models = modelText(expected.models);
  if (
    got.join(",") !== wanted.join(",") ||
    (expected.adopted !== true &&
      expected.digitalSourceType !== "undeclared" &&
      lastAction?.digitalSourceType !== expected.digitalSourceType) ||
    (models !== undefined && lastAction?.softwareAgent !== models) ||
    (expected.adopted === true && !read.ingredients.some((i) => i.relationship === "parentOf"))
  )
    return {
      code: "credentials_invalid",
      problem: `${path}'s C2PA manifest does not record ${wanted.join(" then ")} with the provenance's source type and models`,
    };
  return undefined;
}

function expectedActions(expected: ExpectedCredentials): string[] {
  return expected.adopted === true ? ["c2pa.opened", "c2pa.edited"] : ["c2pa.created"];
}

/**
 * The bytes to write for a file: `existing` (the file already at the destination) when its
 * manifest validates, was signed over these same `bytes` by the same certificate and records the
 * same claim, so an unchanged asset keeps its bytes; else `bytes` newly signed.
 */
export async function credentialed(
  bytes: Uint8Array,
  mediaType: string,
  claim: CredentialClaim,
  signer: ContentSigner,
  version: string,
  existing?: Uint8Array,
): Promise<Uint8Array> {
  if (existing !== undefined) {
    const read = await readCredentials(existing, mediaType).catch(() => undefined);
    const problem =
      read === undefined
        ? "missing"
        : await credentialProblem("", existing, mediaType, {
            digitalSourceType: claim.digitalSourceType,
            models: claim.models,
            ...(claim.original !== undefined && { adopted: true }),
          });
    if (
      read !== undefined &&
      problem === undefined &&
      read.inputSha256 === sha256(bytes) &&
      read.certificateSha256 === signer.record.certificateSha256
    )
      return existing;
  }
  return signCredentials(bytes, mediaType, claim, signer, version);
}
