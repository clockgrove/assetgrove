/**
 * Cuts a token sequence to `max` while keeping its trailing special tokens (the end token).
 * Tokenizer truncation drops the end token, so cut texts would embed unlike short ones.
 * `withSpecials` is the encoding with special tokens, `plain` the same text without them.
 */
export function fitTokens(withSpecials: number[], plain: number[], max: number): number[] {
  if (withSpecials.length <= max) return withSpecials;
  const lead = leadingSpecials(withSpecials, plain);
  if (lead < 0) return withSpecials.slice(0, max);
  const trailing = withSpecials.slice(lead + plain.length);
  const room = Math.max(0, max - lead - trailing.length);
  return [...withSpecials.slice(0, lead), ...plain.slice(0, room), ...trailing].slice(0, max);
}

function leadingSpecials(withSpecials: number[], plain: number[]): number {
  for (let lead = 0; lead + plain.length <= withSpecials.length; lead++) {
    if (plain.every((id, i) => withSpecials[lead + i] === id)) return lead;
  }
  return -1;
}
