// PHYSICALFLARE MODEL GENERATION LAB
// ---------------------------------------------------------------------------
// This file is the intentional infiltration point for new FLARES-to-geometry
// research. The on-chain Three.js sampler gives us a shader displacement field;
// the functions below decide how that field becomes a physical printable object.
//
// Add new approaches by:
// 1. Adding a preset to LANDSCAPE_PRESETS.
// 2. Adding a branch in applyLandscapeMode().
// 3. Keeping outputs normalized to 0..1 so terrainMesh.js can seal the STL.
// 4. Optionally returning trimMask/cellMask for non-rectangular island STLs.

export const LANDSCAPE_PRESETS = [
  {
    id: "shader-topology",
    name: "Shader Topology",
    note: "Direct read of the FLARES displacement texture.",
    settings: {
      curve: 1,
      smoothing: 1,
      ridgeGain: 0.1,
      terraceCount: 0,
      microRelief: 0.02,
      trimWater: false,
      waterLevel: 0.22
    }
  },
  {
    id: "solar-ridges",
    name: "Solar Ridges",
    note: "Amplifies gradient lines that feel native to the FLARES surface.",
    settings: {
      curve: 1.18,
      smoothing: 1,
      ridgeGain: 0.42,
      terraceCount: 0,
      microRelief: 0.045,
      trimWater: false,
      waterLevel: 0.24
    }
  },
  {
    id: "topographic-terraces",
    name: "Topographic Terraces",
    note: "Turns shader elevation into contour shelves for readable prints.",
    settings: {
      curve: 0.9,
      smoothing: 1,
      ridgeGain: 0.18,
      terraceCount: 9,
      microRelief: 0.015,
      trimWater: false,
      waterLevel: 0.26
    }
  },
  {
    id: "flare-islands",
    name: "Flare Islands",
    note: "Builds a physical archipelago from the strongest energy fields.",
    settings: {
      curve: 1.55,
      smoothing: 2,
      ridgeGain: 0.28,
      terraceCount: 0,
      microRelief: 0.035,
      trimWater: true,
      waterLevel: 0.34
    }
  },
  {
    id: "etched-field",
    name: "Etched Field",
    note: "Keeps broad terrain lower and pulls shader edges into relief.",
    settings: {
      curve: 0.72,
      smoothing: 0,
      ridgeGain: 0.62,
      terraceCount: 0,
      microRelief: 0.025,
      trimWater: false,
      waterLevel: 0.3
    }
  }
];

export const DEFAULT_LANDSCAPE_SETTINGS = {
  mode: "shader-topology",
  curve: 1,
  smoothing: 1,
  ridgeGain: 0.1,
  terraceCount: 0,
  microRelief: 0.02,
  trimWater: false,
  waterLevel: 0.22
};

export function getLandscapePreset(id) {
  return LANDSCAPE_PRESETS.find((preset) => preset.id === id) ?? LANDSCAPE_PRESETS[0];
}

export function mergeLandscapeSettings(current, patch) {
  if (patch.mode && patch.mode !== current.mode) {
    const preset = getLandscapePreset(patch.mode);
    return {
      ...current,
      mode: preset.id,
      ...preset.settings
    };
  }

  return {
    ...current,
    ...patch
  };
}

export function buildPhysicalFlareHeightMap(heightMap, settings = DEFAULT_LANDSCAPE_SETTINGS) {
  if (!heightMap?.values?.length) return null;

  const width = heightMap.width;
  const height = heightMap.height;
  const source = normalizeValues(heightMap.values);
  const smoothed = smoothValues(source, width, height, clampInt(settings.smoothing, 0, 4));
  const curved = applyCurve(smoothed, settings.curve);
  const shaped = applyLandscapeMode(curved, width, height, settings);
  const withTexture = addMicroRelief(shaped, width, height, settings.microRelief, heightMap.seedIndex);
  const waterCut = applyWaterCut(normalizeValues(withTexture), width, height, settings);

  return {
    ...heightMap,
    values: waterCut.values,
    sourceValues: waterCut.sourceValues,
    physicalMode: settings.mode,
    trimMask: waterCut.trimMask,
    cellMask: waterCut.cellMask,
    water: waterCut.water,
    generator: {
      name: getLandscapePreset(settings.mode).name,
      settings: { ...settings },
      note: getLandscapePreset(settings.mode).note
    }
  };
}

function applyWaterCut(values, width, height, settings) {
  const waterLevel = clampNumber(settings.waterLevel ?? 0, 0, 0.95);
  const trimWater = Boolean(settings.trimWater);

  if (!trimWater) {
    return {
      values,
      sourceValues: values,
      trimMask: null,
      cellMask: null,
      water: {
        enabled: false,
        level: waterLevel,
        coverage: 1,
        islandCells: (width - 1) * (height - 1)
      }
    };
  }

  const valuesAboveWater = new Float32Array(values.length);
  const sourceValues = new Float32Array(values);
  const trimMask = new Uint8Array(values.length);
  const dryScale = Math.max(1 - waterLevel, 0.000001);
  let dryVertices = 0;

  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > waterLevel) {
      trimMask[i] = 1;
      dryVertices += 1;
      valuesAboveWater[i] = (values[i] - waterLevel) / dryScale;
    }
  }

  const cellMask = new Uint8Array((width - 1) * (height - 1));
  let islandCells = 0;

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = y * width + x;
      const b = a + 1;
      const c = (y + 1) * width + x;
      const d = c + 1;
      const keep = trimMask[a] || trimMask[b] || trimMask[c] || trimMask[d];
      const cellIndex = y * (width - 1) + x;
      if (keep) {
        cellMask[cellIndex] = 1;
        islandCells += 1;
      }
    }
  }

  if (!islandCells) {
    const maxIndex = findMaxIndex(values);
    sourceValues[maxIndex] = 1;
    valuesAboveWater[maxIndex] = 1;
    trimMask[maxIndex] = 1;
    const x = Math.min(width - 2, Math.max(0, maxIndex % width));
    const y = Math.min(height - 2, Math.max(0, Math.floor(maxIndex / width)));
    cellMask[y * (width - 1) + x] = 1;
    islandCells = 1;
  }

  return {
    values: normalizeValues(valuesAboveWater),
    sourceValues,
    trimMask,
    cellMask,
    water: {
      enabled: true,
      level: waterLevel,
      coverage: islandCells / Math.max(1, (width - 1) * (height - 1)),
      dryVertices
    }
  };
}

function applyLandscapeMode(values, width, height, settings) {
  switch (settings.mode) {
    case "solar-ridges":
      return mix(values, extractRidges(values, width, height), settings.ridgeGain);
    case "topographic-terraces":
      return terraceValues(
        mix(values, extractRidges(values, width, height), settings.ridgeGain),
        settings.terraceCount
      );
    case "flare-islands":
      return buildFlareIslands(values, width, height, settings);
    case "etched-field":
      return buildEtchedField(values, width, height, settings);
    case "shader-topology":
    default:
      return mix(values, extractRidges(values, width, height), settings.ridgeGain);
  }
}

function buildFlareIslands(values, width, height, settings) {
  const ridges = extractRidges(values, width, height);
  const output = new Float32Array(values.length);

  for (let y = 0; y < height; y += 1) {
    const v = height <= 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = width <= 1 ? 0 : x / (width - 1);
      const i = y * width + x;
      const centerFalloff = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 1.05);
      const island = Math.pow(values[i], 1.4) * 0.72 + centerFalloff * 0.22;
      output[i] = island + ridges[i] * settings.ridgeGain;
    }
  }

  return output;
}

function buildEtchedField(values, width, height, settings) {
  const ridges = extractRidges(values, width, height);
  const output = new Float32Array(values.length);

  for (let i = 0; i < values.length; i += 1) {
    output[i] = values[i] * 0.62 + Math.pow(ridges[i], 0.72) * settings.ridgeGain;
  }

  return output;
}

function extractRidges(values, width, height) {
  const output = new Float32Array(values.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const left = values[y * width + Math.max(0, x - 1)];
      const right = values[y * width + Math.min(width - 1, x + 1)];
      const up = values[Math.max(0, y - 1) * width + x];
      const down = values[Math.min(height - 1, y + 1) * width + x];
      output[i] = Math.hypot(right - left, down - up);
    }
  }

  return normalizeValues(output);
}

function terraceValues(values, terraceCount) {
  const count = clampInt(terraceCount, 0, 24);
  if (!count) return values;

  const output = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const stepped = Math.round(values[i] * count) / count;
    output[i] = values[i] * 0.35 + stepped * 0.65;
  }
  return output;
}

function addMicroRelief(values, width, height, amount = 0, seed = 0) {
  const gain = clampNumber(amount, 0, 0.12);
  if (gain <= 0) return values;

  const output = new Float32Array(values.length);
  const seedPhase = (Number(seed) || 0) * 0.173;

  for (let y = 0; y < height; y += 1) {
    const v = height <= 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = width <= 1 ? 0 : x / (width - 1);
      const i = y * width + x;
      const linework =
        Math.sin((u * 33 + v * 19 + seedPhase) * Math.PI) *
        Math.cos((u * 11 - v * 29 + seedPhase) * Math.PI);
      output[i] = values[i] + linework * gain;
    }
  }

  return output;
}

function applyCurve(values, curve = 1) {
  const power = clampNumber(curve, 0.35, 2.6);
  const output = new Float32Array(values.length);

  for (let i = 0; i < values.length; i += 1) {
    output[i] = Math.pow(values[i], power);
  }

  return output;
}

function smoothValues(values, width, height, passes = 0) {
  let current = values;

  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float32Array(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let weight = 0;

        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const sx = Math.max(0, Math.min(width - 1, x + ox));
            const sy = Math.max(0, Math.min(height - 1, y + oy));
            const w = ox === 0 && oy === 0 ? 4 : ox === 0 || oy === 0 ? 2 : 1;
            sum += current[sy * width + sx] * w;
            weight += w;
          }
        }

        next[y * width + x] = sum / weight;
      }
    }
    current = next;
  }

  return current;
}

function mix(a, b, amount) {
  const t = clampNumber(amount, 0, 1);
  const output = new Float32Array(a.length);

  for (let i = 0; i < a.length; i += 1) {
    output[i] = a[i] * (1 - t) + b[i] * t;
  }

  return output;
}

function normalizeValues(values) {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < values.length; i += 1) {
    const value = Number.isFinite(values[i]) ? values[i] : 0;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  const span = Math.max(max - min, 0.000001);
  const output = new Float32Array(values.length);

  for (let i = 0; i < values.length; i += 1) {
    const value = Number.isFinite(values[i]) ? values[i] : 0;
    output[i] = clampNumber((value - min) / span, 0, 1);
  }

  return output;
}

function findMaxIndex(values) {
  let max = -Infinity;
  let index = 0;

  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > max) {
      max = values[i];
      index = i;
    }
  }

  return index;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clampInt(value, min, max) {
  return Math.round(clampNumber(value, min, max));
}
