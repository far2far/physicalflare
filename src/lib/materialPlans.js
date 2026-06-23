export const MATERIAL_MODES = [
  {
    id: "single",
    name: "One material",
    slots: 1,
    handoff: "STL"
  },
  {
    id: "flare-colors",
    name: "4 FLARE colors",
    slots: 4,
    handoff: "4 STL set"
  }
];

const SINGLE_MATERIAL_BANDS = [
  {
    id: "single",
    name: "Terrain",
    range: "0-100%",
    tool: "T1",
    color: "#f3f0e8"
  }
];

const FLARE_COLOR_BANDS = [
  {
    id: "color-1",
    name: "Color 1",
    range: "Artwork",
    tool: "T1",
    color: "#f6f1e6"
  },
  {
    id: "color-2",
    name: "Color 2",
    range: "Artwork",
    tool: "T2",
    color: "#9bb9b0"
  },
  {
    id: "color-3",
    name: "Color 3",
    range: "Artwork",
    tool: "T3",
    color: "#4e6f87"
  },
  {
    id: "color-4",
    name: "Color 4",
    range: "Artwork",
    tool: "T4",
    color: "#d84f94"
  }
];

// PHYSICALFLARE MULTI-MATERIAL PRINT LAB
// This is the handoff point for turning a terrain into one printable body,
// four FLARE-color STL bodies, or a future 3MF with material assignments.
export function getMaterialPlan({ mode, palette, printer, settings, terrain }) {
  const materialMode = MATERIAL_MODES.find((item) => item.id === mode) ?? MATERIAL_MODES[0];
  const availableSlots = printer.materialSlots ?? 1;
  const requestedSlots = materialMode.slots;
  const bands = mode === "flare-colors" ? createFlareColorBands(palette) : createSingleMaterialBands(palette);
  const bandHeightMm = requestedSlots > 1 ? settings.reliefHeightMm / requestedSlots : settings.reliefHeightMm;
  const nozzleMm = printer.nozzleMm ?? 0.4;
  const warnings = [];

  if (requestedSlots > availableSlots) {
    warnings.push("Four-material terrain needs a four-tool printer.");
  }

  if (mode === "flare-colors" && palette?.status === "fallback") {
    warnings.push("Using fallback colors because the FLARE palette could not be read.");
  }

  if (
    mode === "flare-colors" &&
    Number.isFinite(terrain?.stats?.minPitchMm) &&
    terrain.stats.minPitchMm < nozzleMm * 1.2
  ) {
    warnings.push(`XY pitch is tight for a ${nozzleMm.toFixed(1)} mm nozzle.`);
  }

  if (
    mode === "flare-colors" &&
    terrain?.stats?.trimmed &&
    Number.isFinite(terrain.stats.landCoverage) &&
    terrain.stats.landCoverage < 0.08
  ) {
    warnings.push("Island footprint is small for clean four-material transitions.");
  }

  return {
    availableSlots,
    bands,
    bandHeightMm,
    colorMap: palette?.colorMap ?? null,
    handoff: materialMode.handoff,
    isSupported: requestedSlots <= availableSlots,
    mapHeight: palette?.mapHeight ?? 0,
    mapWidth: palette?.mapWidth ?? 0,
    mode: materialMode.id,
    name: materialMode.name,
    paletteLabel: palette?.label ?? "Fallback",
    paletteStatus: palette?.status ?? "fallback",
    requestedSlots,
    slicer: printer.slicer ?? "Slicer",
    warnings
  };
}

export function createMaterialCellMasks({ baseCellMask, gridX, gridY, materialPlan }) {
  if (materialPlan?.mode !== "flare-colors" || !materialPlan.colorMap?.length) return [];

  const cellWidth = gridX - 1;
  const cellHeight = gridY - 1;
  const masks = materialPlan.bands.map((band) => ({
    band,
    cellCount: 0,
    cellMask: new Uint8Array(cellWidth * cellHeight)
  }));

  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      const cellIndex = y * cellWidth + x;
      if (baseCellMask?.length && !baseCellMask[cellIndex]) continue;

      const u = (x + 0.5) / cellWidth;
      const v = 1 - (y + 0.5) / cellHeight;
      const materialIndex = sampleMaterialPlanIndex(materialPlan, u, v) ?? 0;
      const mask = masks[materialIndex] ?? masks[0];
      mask.cellMask[cellIndex] = 1;
      mask.cellCount += 1;
    }
  }

  return masks;
}

export function sampleMaterialPlanIndex(materialPlan, u, v) {
  if (!materialPlan?.colorMap?.length || !materialPlan.mapWidth || !materialPlan.mapHeight) return null;

  const x = clampInt(Math.round(u * (materialPlan.mapWidth - 1)), 0, materialPlan.mapWidth - 1);
  const y = clampInt(Math.round((1 - v) * (materialPlan.mapHeight - 1)), 0, materialPlan.mapHeight - 1);
  return materialPlan.colorMap[y * materialPlan.mapWidth + x] ?? null;
}

function createSingleMaterialBands(palette) {
  return [
    {
      ...SINGLE_MATERIAL_BANDS[0],
      color: palette?.colors?.[0] ?? SINGLE_MATERIAL_BANDS[0].color
    }
  ];
}

function createFlareColorBands(palette) {
  const colors = palette?.colors ?? [];

  return FLARE_COLOR_BANDS.map((band, index) => ({
    ...band,
    color: colors[index] ?? band.color
  }));
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}
