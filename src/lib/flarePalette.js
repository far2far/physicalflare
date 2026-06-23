export const FALLBACK_FLARE_COLORS = ["#f6f1e6", "#9bb9b0", "#4e6f87", "#d84f94"];

export function createFallbackPalette(status = "fallback", label = "Fallback") {
  return {
    colorMap: null,
    colors: FALLBACK_FLARE_COLORS,
    label,
    mapHeight: 0,
    mapWidth: 0,
    status
  };
}

export async function extractFlarePalette(imageSrc, options = {}) {
  if (!imageSrc) return createFallbackPalette("fallback", "No image");

  const image = await loadImage(imageSrc);
  const sampleSize = options.sampleSize ?? 96;
  const mapSize = options.mapSize ?? 144;
  const paletteData = readImagePixels(image, sampleSize, sampleSize);
  const buckets = collectColorBuckets(paletteData.data);
  const colors = buildMedianCutPalette(buckets, 4);

  if (colors.length < 4) {
    return createFallbackPalette("fallback", "Low color");
  }

  const mapData = readImagePixels(image, mapSize, mapSize);
  const colorMap = createColorIndexMap(mapData.data, colors);

  return {
    colorMap,
    colors,
    label: "FLARE",
    mapHeight: mapData.height,
    mapWidth: mapData.width,
    status: "ready"
  };
}

export function samplePaletteIndex(palette, u, v) {
  if (!palette?.colorMap?.length || !palette.mapWidth || !palette.mapHeight) return null;

  const x = clampInt(Math.round(u * (palette.mapWidth - 1)), 0, palette.mapWidth - 1);
  const y = clampInt(Math.round((1 - v) * (palette.mapHeight - 1)), 0, palette.mapHeight - 1);
  return palette.colorMap[y * palette.mapWidth + x] ?? null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("FLARE image palette could not be read."));
    image.src = src;
  });
}

function readImagePixels(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  return {
    data: ctx.getImageData(0, 0, width, height).data,
    height,
    width
  };
}

function collectColorBuckets(data) {
  const buckets = new Map();

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 24) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = `${r >> 3}-${g >> 3}-${b >> 3}`;
    const bucket = buckets.get(key) ?? { b: 0, count: 0, g: 0, r: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values()).map((bucket) => ({
    b: bucket.b / bucket.count,
    count: bucket.count,
    g: bucket.g / bucket.count,
    r: bucket.r / bucket.count
  }));
}

function buildMedianCutPalette(buckets, colorCount) {
  if (!buckets.length) return [];

  let boxes = [buckets];
  while (boxes.length < colorCount) {
    boxes.sort((a, b) => boxScore(b) - boxScore(a));
    const box = boxes.shift();
    if (!box || box.length < 2) {
      if (box) boxes.push(box);
      break;
    }

    const [left, right] = splitBox(box);
    boxes.push(left, right);
  }

  return boxes
    .map(averageBoxColor)
    .filter(Boolean)
    .sort((a, b) => relativeLuminance(a) - relativeLuminance(b))
    .map(rgbToHex);
}

function boxScore(box) {
  const bounds = getBoxBounds(box);
  return Math.max(bounds.r.max - bounds.r.min, bounds.g.max - bounds.g.min, bounds.b.max - bounds.b.min) *
    Math.sqrt(getBoxWeight(box));
}

function splitBox(box) {
  const bounds = getBoxBounds(box);
  const ranges = [
    ["r", bounds.r.max - bounds.r.min],
    ["g", bounds.g.max - bounds.g.min],
    ["b", bounds.b.max - bounds.b.min]
  ];
  ranges.sort((a, b) => b[1] - a[1]);

  const channel = ranges[0][0];
  const sorted = [...box].sort((a, b) => a[channel] - b[channel]);
  const halfWeight = getBoxWeight(sorted) / 2;
  let weight = 0;
  let splitIndex = 1;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    weight += sorted[i].count;
    if (weight >= halfWeight) {
      splitIndex = i + 1;
      break;
    }
  }

  return [sorted.slice(0, splitIndex), sorted.slice(splitIndex)];
}

function getBoxBounds(box) {
  const bounds = {
    b: { max: -Infinity, min: Infinity },
    g: { max: -Infinity, min: Infinity },
    r: { max: -Infinity, min: Infinity }
  };

  for (const color of box) {
    bounds.r.min = Math.min(bounds.r.min, color.r);
    bounds.r.max = Math.max(bounds.r.max, color.r);
    bounds.g.min = Math.min(bounds.g.min, color.g);
    bounds.g.max = Math.max(bounds.g.max, color.g);
    bounds.b.min = Math.min(bounds.b.min, color.b);
    bounds.b.max = Math.max(bounds.b.max, color.b);
  }

  return bounds;
}

function getBoxWeight(box) {
  return box.reduce((total, color) => total + color.count, 0);
}

function averageBoxColor(box) {
  const weight = getBoxWeight(box);
  if (!weight) return null;

  const sum = box.reduce(
    (average, color) => {
      average.r += color.r * color.count;
      average.g += color.g * color.count;
      average.b += color.b * color.count;
      return average;
    },
    { b: 0, g: 0, r: 0 }
  );

  return {
    b: sum.b / weight,
    g: sum.g / weight,
    r: sum.r / weight
  };
}

function createColorIndexMap(data, colors) {
  const palette = colors.map(hexToRgb);
  const map = new Uint8Array(data.length / 4);

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 24) {
      map[i / 4] = 0;
      continue;
    }

    map[i / 4] = findNearestColorIndex(
      { r: data[i], g: data[i + 1], b: data[i + 2] },
      palette
    );
  }

  return map;
}

function findNearestColorIndex(color, palette) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < palette.length; i += 1) {
    const candidate = palette[i];
    const distance =
      (color.r - candidate.r) ** 2 +
      (color.g - candidate.g) ** 2 +
      (color.b - candidate.b) ** 2;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function relativeLuminance(color) {
  return 0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b);
}

function srgbToLinear(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function rgbToHex(color) {
  return `#${[color.r, color.g, color.b]
    .map((value) => clampInt(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    b: Number.parseInt(value.slice(4, 6), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    r: Number.parseInt(value.slice(0, 2), 16)
  };
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}
