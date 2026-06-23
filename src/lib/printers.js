export const PRINTER_PRESETS = [
  {
    id: "gigastorm",
    name: "Gigastorm",
    description: "Large-format preset from the project brief",
    volume: { x: 800, y: 800, z: 1000 },
    materialSlots: 1
  },
  {
    id: "snapmaker-u1",
    name: "Snapmaker U1",
    description: "Four-tool SnapSwap printer for single or multi-material FDM terrain",
    volume: { x: 270, y: 270, z: 270 },
    materialSlots: 4,
    nozzleMm: 0.4,
    maxNozzleTempC: 300,
    maxBedTempC: 100,
    slicer: "Snapmaker Orca"
  },
  {
    id: "prusa-core-one",
    name: "Prusa CORE One",
    description: "Official CORE One build volume",
    volume: { x: 250, y: 220, z: 270 },
    materialSlots: 1,
    nozzleMm: 0.4
  },
  {
    id: "prusa-core-one-l",
    name: "Prusa CORE One L / Plus",
    description: "Larger Core One class, editable if your machine differs",
    volume: { x: 300, y: 300, z: 330 },
    materialSlots: 1,
    nozzleMm: 0.4
  },
  {
    id: "custom",
    name: "Custom",
    description: "Manual build volume",
    volume: { x: 220, y: 220, z: 250 },
    materialSlots: 1
  }
];

export function getPrinterPreset(id) {
  return PRINTER_PRESETS.find((preset) => preset.id === id) ?? PRINTER_PRESETS[0];
}

export function getFitReport(dimensions, printer) {
  const fitsNormal =
    dimensions.width <= printer.volume.x &&
    dimensions.depth <= printer.volume.y &&
    dimensions.height <= printer.volume.z;

  const fitsRotated =
    dimensions.depth <= printer.volume.x &&
    dimensions.width <= printer.volume.y &&
    dimensions.height <= printer.volume.z;

  const blockers = [];
  if (!fitsNormal && !fitsRotated) {
    if (
      dimensions.width > Math.max(printer.volume.x, printer.volume.y) ||
      dimensions.depth > Math.max(printer.volume.x, printer.volume.y)
    ) {
      blockers.push("XY footprint exceeds the build plate.");
    }
    if (dimensions.height > printer.volume.z) {
      blockers.push("Z height exceeds the build volume.");
    }
  }

  return {
    status: fitsNormal ? "fits" : fitsRotated ? "rotate" : "blocked",
    fitsNormal,
    fitsRotated,
    blockers
  };
}
