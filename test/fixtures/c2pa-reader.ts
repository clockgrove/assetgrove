/**
 * An independent C2PA reader for the tests: it shares no code with the writer (the CAI SDK and
 * `@auth0/cose`). exiftool (a separate JUMBF and CBOR implementation) extracts the manifest store
 * from the file; this file walks the JUMBF boxes, decodes CBOR with `cbor2`, and checks with
 * node:crypto that the COSE_Sign1 signature over the claim verifies with the leaf certificate of
 * its x5chain, that the chain verifies, that the claim's hashed URIs match their assertions, and
 * that the hard binding (`c2pa.hash.data`) matches the file's bytes.
 */
import { createHash, verify, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decode, encode, Tag } from "cbor2";
import type { ExifTool } from "exiftool-vendored";

interface Box {
  type: string;
  /** The whole box, header included. */
  bytes: Uint8Array;
  /** The payload after the header. */
  payload: Uint8Array;
}

function boxes(data: Uint8Array): Box[] {
  const out: Box[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at + 8 <= data.length) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = data.length - at;
    const type = Buffer.from(data.subarray(at + 4, at + 8)).toString("latin1");
    out.push({
      type,
      bytes: data.subarray(at, at + size),
      payload: data.subarray(at + header, at + size),
    });
    at += size;
  }
  return out;
}

/** The data of a WebP's RIFF chunk. */
function riffChunk(data: Uint8Array, fourcc: string): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 12; at + 8 <= data.length;) {
    const size = view.getUint32(at + 4, true);
    if (Buffer.from(data.subarray(at, at + 4)).toString("latin1") === fourcc)
      return data.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error(`no ${fourcc} chunk`);
}

interface Superbox {
  label: string;
  /** The superbox's payload (description box and content boxes). */
  payload: Uint8Array;
  children: Box[];
}

function superbox(box: Box): Superbox {
  const children = boxes(box.payload);
  const description = children[0]!;
  // jumd: 16-byte type UUID, toggles, then a null-terminated label when toggles has bit 2.
  const toggles = description.payload[16]!;
  let label = "";
  if (toggles & 0x02) {
    const end = description.payload.indexOf(0, 17);
    label = Buffer.from(description.payload.subarray(17, end)).toString("utf8");
  }
  return { label, payload: box.payload, children: children.slice(1) };
}

const decoder = { decode: (bytes: Uint8Array): unknown => decode(bytes) };
const encoder = { encode: (value: unknown): Uint8Array => encode(value) };

function cborOf(sb: Superbox): unknown {
  const content = sb.children.find((c) => c.type === "cbor");
  if (!content) throw new Error(`${sb.label} has no cbor box`);
  return decoder.decode(content.payload);
}

const get = (map: unknown, key: string | number): unknown =>
  map instanceof Map ? map.get(key) : (map as Record<string, unknown>)?.[key as string];

export interface IndependentRead {
  claimGenerator: string;
  actions: { action: string; digitalSourceType?: string; softwareAgent?: string }[];
  ingredients: { relationship?: string; title?: string }[];
  /** The signing certificate (leaf). */
  signer: X509Certificate;
  /** Every check passed: signature, chain, assertion hashes and data hash. */
  signatureValid: boolean;
  chainValid: boolean;
  assertionsValid: boolean;
  dataHashValid: boolean;
}

/** Reads and checks the active manifest of `file` independently of the writer. */
export async function readIndependently(
  exiftool: ExifTool,
  file: string,
): Promise<IndependentRead> {
  const tmp = `${file}.jumbf`;
  await exiftool.extractBinaryTag("JUMBF", file, tmp);
  let jumbf: Uint8Array = new Uint8Array(await readFile(tmp));
  // exiftool decodes a WebP's C2PA chunk but extracts no JUMBF from it: take the RIFF chunk.
  if (jumbf.length === 0) jumbf = riffChunk(new Uint8Array(await readFile(file)), "C2PA");
  const store = superbox(boxes(jumbf)[0]!);
  if (store.label !== "c2pa") throw new Error(`not a C2PA store: ${store.label}`);
  // The active manifest is the last one in the store.
  const manifest = superbox(store.children.at(-1)!);
  const parts = new Map(
    manifest.children.map((c) => [superbox(c).label, { box: c, sb: superbox(c) }]),
  );
  const claimPart = parts.get("c2pa.claim.v2") ?? parts.get("c2pa.claim");
  const signaturePart = parts.get("c2pa.signature");
  const assertionStore = parts.get("c2pa.assertions");
  if (!claimPart || !signaturePart || !assertionStore) throw new Error("incomplete manifest");
  const claimBytes = claimPart.sb.children.find((c) => c.type === "cbor")!.payload;
  const claim = decoder.decode(claimBytes);
  const assertions = new Map(
    assertionStore.sb.children.map((c) => {
      const sb = superbox(c);
      return [sb.label, { box: c, sb }];
    }),
  );

  // The signature: COSE_Sign1 (tag 18) with a detached payload, the claim.
  let cose = cborOf(signaturePart.sb);
  if (cose instanceof Tag) cose = cose.contents;
  const [protectedBytes, , , signature] = cose as [Uint8Array, unknown, null, Uint8Array];
  const headers = decoder.decode(protectedBytes);
  const alg = get(headers, 1) as number;
  const x5chain = get(headers, 33);
  const chain = (Array.isArray(x5chain) ? x5chain : [x5chain]).map(
    (der: Uint8Array) => new X509Certificate(der),
  );
  const leaf = chain[0]!;
  const toBeSigned = encoder.encode(["Signature1", protectedBytes, new Uint8Array(0), claimBytes]);
  const hash = alg === -35 ? "sha384" : alg === -8 ? null : "sha256";
  const signatureValid = verify(
    hash,
    toBeSigned,
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
  const chainValid = chain.every((cert, i) => {
    const issuer = chain[i + 1] ?? cert;
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  });

  // Each hashed URI in the claim names an assertion whose superbox payload has that sha256.
  const refs = [
    ...((get(claim, "created_assertions") as unknown[]) ?? []),
    ...((get(claim, "gathered_assertions") as unknown[]) ?? []),
    ...((get(claim, "assertions") as unknown[]) ?? []),
  ];
  const assertionsValid =
    refs.length > 0 &&
    refs.every((ref) => {
      const url = String(get(ref, "url"));
      const label = url.split("/").pop()!;
      const found = assertions.get(label);
      if (!found) return false;
      const digest = createHash("sha256").update(found.sb.payload).digest();
      return Buffer.from(get(ref, "hash") as Uint8Array).equals(digest);
    });

  // The hard binding: the file's bytes, minus the exclusions, hash to the assertion's value.
  const bytes = new Uint8Array(await readFile(file));
  const binding = cborOf(assertions.get("c2pa.hash.data")!.sb);
  const ranges = ((get(binding, "exclusions") as unknown[]) ?? []).map((e) => [
    Number(get(e, "start")),
    Number(get(e, "length")),
  ]);
  const data = createHash("sha256");
  let at = 0;
  for (const [start, length] of ranges.sort((a, b) => a[0]! - b[0]!)) {
    data.update(bytes.subarray(at, start));
    at = start! + length!;
  }
  data.update(bytes.subarray(at));
  const dataHashValid = data.digest().equals(Buffer.from(get(binding, "hash") as Uint8Array));

  const actionData = cborOf(
    (assertions.get("c2pa.actions.v2") ?? assertions.get("c2pa.actions"))!.sb,
  );
  const actions = ((get(actionData, "actions") as unknown[]) ?? []).map((a) => ({
    action: String(get(a, "action")),
    ...(typeof get(a, "digitalSourceType") === "string" && {
      digitalSourceType: get(a, "digitalSourceType") as string,
    }),
    ...(typeof get(get(a, "softwareAgent"), "name") === "string" && {
      softwareAgent: get(get(a, "softwareAgent"), "name") as string,
    }),
  }));
  const ingredients = [...assertions]
    .filter(([label]) => label.startsWith("c2pa.ingredient"))
    .map(([, { sb }]) => {
      const data = cborOf(sb);
      return {
        ...(typeof get(data, "relationship") === "string" && {
          relationship: get(data, "relationship") as string,
        }),
        ...(typeof get(data, "dc:title") === "string" && {
          title: get(data, "dc:title") as string,
        }),
      };
    });
  const generator = get(claim, "claim_generator_info");
  return {
    claimGenerator: String(get(Array.isArray(generator) ? generator[0] : generator, "name")),
    actions,
    ingredients,
    signer: leaf,
    signatureValid,
    chainValid,
    assertionsValid,
    dataHashValid,
  };
}
