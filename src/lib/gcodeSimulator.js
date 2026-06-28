import { sampleMaterialPlanIndex } from "./materialPlans";

export const DEFAULT_GCODE_SETTINGS = {
  extrusionWidthMm: 0.45,
  filamentDiameterMm: 1.75,
  layerHeightMm: 0.2,
  lineSpacingMm: 1.4,
  printFeedMmMin: 2400,
  travelFeedMmMin: 9000
};

const MAX_SIM_LAYERS = 260;
const MAX_LAYER_PATHS = 900;

// PHYSICALFLARE G-CODE SIMULATION LAB
// This is intentionally not a slicer replacement. It mirrors slicer concepts
// (layers, perimeters, infill strokes, E accumulation, tool changes) so a coder
// can replace this module with real PrusaSlicer/3MF/G-code integration later.
export function createGcodeSimulation({
  flare,
  heightMap,
  materialPlan,
  seedIndex,
  settings,
  simulationSettings = DEFAULT_GCODE_SETTINGS
}) {
  if (!heightMap?.values?.length || !settings) return createEmptySimulation();

  const sim = normalizeSimulationSettings(simulationSettings);
  const modelHeightMm = settings.baseThicknessMm + settings.reliefHeightMm;
  const layerCount = Math.min(MAX_SIM_LAYERS, Math.max(1, Math.ceil(modelHeightMm / sim.layerHeightMm)));
  const layerHeightMm = modelHeightMm / layerCount;
  const filamentArea = Math.PI * (sim.filamentDiameterMm / 2) ** 2;
  const extrusionPerMm = (sim.extrusionWidthMm * layerHeightMm) / filamentArea;
  const layers = [];
  const gcodeLines = createGcodeHeader({ flare, layerCount, modelHeightMm, seedIndex, settings, sim });
  const tools = resolveTools(materialPlan);
  let currentTool = null;
  let e = 0;
  let lastPoint = null;
  let printPathMm = 0;
  let travelPathMm = 0;
  let toolChanges = 0;

  for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
    const z = roundGcode((layerIndex + 1) * layerHeightMm);
    const paths = createLayerPaths({
      heightMap,
      layerIndex,
      materialPlan,
      modelHeightMm,
      settings,
      sim,
      z
    });
    const lineStart = gcodeLines.length;

    gcodeLines.push(`;LAYER:${layerIndex}`);
    gcodeLines.push(`;Z:${z.toFixed(3)}`);
    gcodeLines.push(`G1 Z${z.toFixed(3)} F${sim.travelFeedMmMin}`);

    for (const path of paths) {
      const tool = tools[path.materialIndex]?.tool ?? "T1";
      if (tool !== currentTool) {
        currentTool = tool;
        toolChanges += 1;
        gcodeLines.push(`${tool.replace("T", "T")} ; ${tools[path.materialIndex]?.name ?? "material"}`);
      }

      const [start, end] = path.points;
      const travel = lastPoint ? distance(lastPoint, start) : 0;
      travelPathMm += travel;
      gcodeLines.push(`G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)} F${sim.travelFeedMmMin}`);

      const length = distance(start, end);
      printPathMm += length;
      e += length * extrusionPerMm;
      gcodeLines.push(
        `G1 X${end.x.toFixed(3)} Y${end.y.toFixed(3)} E${e.toFixed(5)} F${sim.printFeedMmMin}`
      );
      lastPoint = end;
    }

    layers.push({
      index: layerIndex,
      lineEnd: gcodeLines.length,
      lineStart,
      paths,
      z
    });
  }

  gcodeLines.push(";END");
  gcodeLines.push("M104 S0");
  gcodeLines.push("M140 S0");
  gcodeLines.push("G1 X0 Y200 F9000");
  gcodeLines.push("M84");

  const estimatedMinutes =
    printPathMm / sim.printFeedMmMin +
    travelPathMm / sim.travelFeedMmMin +
    toolChanges * 0.15 +
    layerCount * 0.025;

  return {
    estimatedMinutes,
    extrusionMm: e,
    gcodeLines,
    layerCount,
    layers,
    modelDepthMm: settings.depthMm,
    modelHeightMm,
    modelWidthMm: settings.widthMm,
    printPathMm,
    settings: { ...sim, layerHeightMm },
    toolChanges,
    tools,
    travelPathMm
  };
}

export function getLayerGcodePreview(simulation, layerIndex, maxLines = 20) {
  const layer = simulation?.layers?.[layerIndex];
  if (!layer) return simulation?.gcodeLines?.slice(0, maxLines) ?? [];

  return simulation.gcodeLines.slice(layer.lineStart, Math.min(layer.lineStart + maxLines, layer.lineEnd));
}

function createLayerPaths({ heightMap, materialPlan, settings, sim, z }) {
  const gridX = heightMap.width;
  const gridY = heightMap.height;
  const values = heightMap.values;
  const cellMask = heightMap.cellMask;
  const stepX = settings.widthMm / Math.max(1, gridX - 1);
  const stepY = settings.depthMm / Math.max(1, gridY - 1);
  const rowStep = Math.max(1, Math.round(sim.lineSpacingMm / Math.max(stepY, 0.001)));
  const halfW = settings.widthMm / 2;
  const halfD = settings.depthMm / 2;
  const layerThreshold = (z - settings.baseThicknessMm) / Math.max(settings.reliefHeightMm, 0.001);
  const paths = [];
  const activeCells = [];

  for (let y = 0; y < gridY - 1; y += 1) {
    for (let x = 0; x < gridX - 1; x += 1) {
      const cellIndex = y * (gridX - 1) + x;
      if (cellMask?.length && !cellMask[cellIndex]) continue;

      const h = getCellHeight(values, x, y, gridX);
      const isBase = z <= settings.baseThicknessMm;
      if (!isBase && h < layerThreshold) continue;

      activeCells.push({ x, y });
    }
  }

  if (!activeCells.length) return paths;

  addBoundingPerimeter(paths, activeCells, { halfD, halfW, materialPlan, settings, stepX, stepY });

  const activeByRow = new Map();
  activeCells.forEach((cell) => {
    const row = activeByRow.get(cell.y) ?? [];
    row.push(cell.x);
    activeByRow.set(cell.y, row);
  });

  const rows = Array.from(activeByRow.keys()).sort((a, b) => a - b);
  for (let rowIndex = 0; rowIndex < rows.length && paths.length < MAX_LAYER_PATHS; rowIndex += rowStep) {
    const y = rows[rowIndex];
    const xs = activeByRow.get(y).sort((a, b) => a - b);
    const runs = createRuns(xs);

    runs.forEach((run, runIndex) => {
      if (paths.length >= MAX_LAYER_PATHS) return;

      const yMm = y * stepY + stepY / 2 - halfD;
      const x0 = run.start * stepX - halfW;
      const x1 = (run.end + 1) * stepX - halfW;
      const leftToRight = (rowIndex + runIndex) % 2 === 0;
      const start = leftToRight ? { x: x0, y: yMm } : { x: x1, y: yMm };
      const end = leftToRight ? { x: x1, y: yMm } : { x: x0, y: yMm };
      const u = (run.start + run.end + 1) / 2 / Math.max(1, gridX - 1);
      const v = 1 - (y + 0.5) / Math.max(1, gridY - 1);

      paths.push({
        materialIndex: getMaterialIndex(materialPlan, u, v),
        points: [start, end],
        type: "infill"
      });
    });
  }

  return orderLayerPaths(paths);
}

function addBoundingPerimeter(paths, activeCells, { halfD, halfW, materialPlan, settings, stepX, stepY }) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  activeCells.forEach((cell) => {
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x + 1);
    minY = Math.min(minY, cell.y);
    maxY = Math.max(maxY, cell.y + 1);
  });

  const x0 = minX * stepX - halfW;
  const x1 = maxX * stepX - halfW;
  const y0 = minY * stepY - halfD;
  const y1 = maxY * stepY - halfD;
  const materialIndex = getMaterialIndex(
    materialPlan,
    (minX + maxX) / 2 / Math.max(1, settings.widthMm / stepX),
    1 - (minY + maxY) / 2 / Math.max(1, settings.depthMm / stepY)
  );
  const corners = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 }
  ];

  for (let i = 0; i < corners.length - 1; i += 1) {
    paths.push({
      materialIndex,
      points: [corners[i], corners[i + 1]],
      type: "perimeter"
    });
  }
}

function createRuns(xs) {
  const runs = [];
  let start = xs[0];
  let previous = xs[0];

  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] === previous + 1) {
      previous = xs[i];
      continue;
    }

    runs.push({ end: previous, start });
    start = xs[i];
    previous = xs[i];
  }

  runs.push({ end: previous, start });
  return runs;
}

function orderLayerPaths(paths) {
  return paths.sort((a, b) => {
    if (a.materialIndex !== b.materialIndex) return a.materialIndex - b.materialIndex;
    if (a.type !== b.type) return a.type === "perimeter" ? -1 : 1;
    return a.points[0].y - b.points[0].y || a.points[0].x - b.points[0].x;
  });
}

function getCellHeight(values, x, y, gridX) {
  const a = values[y * gridX + x] ?? 0;
  const b = values[y * gridX + x + 1] ?? a;
  const c = values[(y + 1) * gridX + x] ?? a;
  const d = values[(y + 1) * gridX + x + 1] ?? c;
  return (a + b + c + d) / 4;
}

function getMaterialIndex(materialPlan, u, v) {
  if (materialPlan?.mode !== "flare-colors") return 0;
  const sampled = sampleMaterialPlanIndex(materialPlan, u, v);
  if (Number.isFinite(sampled)) return sampled;
  return 0;
}

function resolveTools(materialPlan) {
  const bands = materialPlan?.bands?.length
    ? materialPlan.bands
    : [{ color: "#f3f0e8", name: "Terrain", tool: "T1" }];

  return bands.map((band, index) => ({
    color: band.color,
    index,
    name: band.name,
    tool: band.tool ?? `T${index + 1}`
  }));
}

function createGcodeHeader({ flare, layerCount, modelHeightMm, seedIndex, settings, sim }) {
  return [
    "; generated by physicalflare",
    "; simulated g-code preview - validate with a real slicer before printing",
    `; flare = ${flare?.name ?? "unknown"}`,
    `; seed = ${Number.isFinite(seedIndex) ? seedIndex : "unknown"}`,
    `; size = ${settings.widthMm} x ${settings.depthMm} x ${modelHeightMm.toFixed(2)} mm`,
    `; layer_height = ${sim.layerHeightMm}`,
    `; layers = ${layerCount}`,
    "G21 ; millimeters",
    "G90 ; absolute positioning",
    "M82 ; absolute extrusion",
    "G92 E0"
  ];
}

function normalizeSimulationSettings(settings) {
  return {
    extrusionWidthMm: clampNumber(settings.extrusionWidthMm, 0.25, 1.2),
    filamentDiameterMm: clampNumber(settings.filamentDiameterMm, 1.5, 3),
    layerHeightMm: clampNumber(settings.layerHeightMm, 0.08, 0.6),
    lineSpacingMm: clampNumber(settings.lineSpacingMm, 0.35, 8),
    printFeedMmMin: clampNumber(settings.printFeedMmMin, 300, 9000),
    travelFeedMmMin: clampNumber(settings.travelFeedMmMin, 1200, 18000)
  };
}

function createEmptySimulation() {
  return {
    estimatedMinutes: 0,
    extrusionMm: 0,
    gcodeLines: [],
    layerCount: 0,
    layers: [],
    modelDepthMm: 0,
    modelHeightMm: 0,
    modelWidthMm: 0,
    printPathMm: 0,
    settings: { ...DEFAULT_GCODE_SETTINGS },
    toolChanges: 0,
    tools: [],
    travelPathMm: 0
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function roundGcode(value) {
  return Math.round(value * 1000) / 1000;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}
