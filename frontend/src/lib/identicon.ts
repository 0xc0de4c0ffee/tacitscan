// Deterministic 5×5 mirrored identicon (GitHub-style) from a hex seed.
// Same asset_id always produces the same identicon — color hue and fill
// pattern come from the seed bytes, no randomness.
//
// Returns an SVG string suitable for `set:html` injection.

function hexToBytes(h: string): Uint8Array {
  const safe = h.replace(/[^0-9a-fA-F]/g, "");
  const padded = safe.padEnd(8, "0").slice(0, 8);
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function identiconSvg(seed: string, size = 64): string {
  // First 4 bytes of the seed drive both color and 15-bit fill pattern.
  const bytes = hexToBytes(seed);
  const hue = Math.round((bytes[0]! / 255) * 360);
  const fg = `hsl(${hue}, 62%, 48%)`;
  const bg = `hsl(${hue}, 30%, 94%)`;

  // 24 bits across bytes[1..3]; we use 15 of them for the left + center
  // columns of the 5×5 grid. Right two columns mirror the left.
  const bits = (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  const cell = size / 5;

  let rects = "";
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const idx = y * 3 + x;
      if ((bits >> idx) & 1) {
        rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fg}"/>`;
        if (x < 2) {
          // Mirror to column 4-x.
          rects += `<rect x="${(4 - x) * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fg}"/>`;
        }
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${bg}"/>${rects}</svg>`;
}
