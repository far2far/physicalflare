export function chooseGridSize(widthMm, depthMm, resolution) {
  const longSide = Math.max(widthMm, depthMm);
  const x = Math.max(24, Math.round((widthMm / longSide) * resolution));
  const y = Math.max(24, Math.round((depthMm / longSide) * resolution));
  return { x, y };
}

export function createTerrainMesh(heightMap, settings) {
  if (heightMap?.cellMask?.length) {
    return createTrimmedTerrainMesh(heightMap, settings);
  }

  return createRectangularTerrainMesh(heightMap, settings);
}

export function createMaskedTerrainMesh(heightMap, settings, cellMask) {
  return createMaskedCellTerrainMesh(
    {
      ...heightMap,
      cellMask,
      sourceValues: null,
      trimMask: null
    },
    settings
  );
}

function createRectangularTerrainMesh(heightMap, settings) {
  const { width: gridX, height: gridY, values } = heightMap;
  const vertexCount = gridX * gridY * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];

  const stepX = settings.widthMm / (gridX - 1);
  const stepY = settings.depthMm / (gridY - 1);
  const halfW = settings.widthMm / 2;
  const halfD = settings.depthMm / 2;
  const topOffset = 0;
  const bottomOffset = gridX * gridY;

  for (let y = 0; y < gridY; y += 1) {
    for (let x = 0; x < gridX; x += 1) {
      const i = y * gridX + x;
      const px = x * stepX - halfW;
      const py = y * stepY - halfD;
      const pz = settings.baseThicknessMm + values[i] * settings.reliefHeightMm;

      setVertex(positions, topOffset + i, px, py, pz);
      setVertex(positions, bottomOffset + i, px, py, 0);
      setUv(uvs, topOffset + i, x / (gridX - 1), 1 - y / (gridY - 1));
      setUv(uvs, bottomOffset + i, x / (gridX - 1), 1 - y / (gridY - 1));
    }
  }

  for (let y = 0; y < gridY - 1; y += 1) {
    for (let x = 0; x < gridX - 1; x += 1) {
      const a = topOffset + y * gridX + x;
      const b = topOffset + y * gridX + x + 1;
      const c = topOffset + (y + 1) * gridX + x;
      const d = topOffset + (y + 1) * gridX + x + 1;
      indices.push(a, b, d, a, d, c);

      const ba = bottomOffset + y * gridX + x;
      const bb = bottomOffset + y * gridX + x + 1;
      const bc = bottomOffset + (y + 1) * gridX + x;
      const bd = bottomOffset + (y + 1) * gridX + x + 1;
      indices.push(ba, bd, bb, ba, bc, bd);
    }
  }

  for (let x = 0; x < gridX - 1; x += 1) {
    const t0 = topOffset + x;
    const t1 = topOffset + x + 1;
    const b0 = bottomOffset + x;
    const b1 = bottomOffset + x + 1;
    indices.push(t0, b0, b1, t0, b1, t1);

    const nt0 = topOffset + (gridY - 1) * gridX + x;
    const nt1 = topOffset + (gridY - 1) * gridX + x + 1;
    const nb0 = bottomOffset + (gridY - 1) * gridX + x;
    const nb1 = bottomOffset + (gridY - 1) * gridX + x + 1;
    indices.push(nt0, nt1, nb0, nt1, nb1, nb0);
  }

  for (let y = 0; y < gridY - 1; y += 1) {
    const wt0 = topOffset + y * gridX;
    const wt1 = topOffset + (y + 1) * gridX;
    const wb0 = bottomOffset + y * gridX;
    const wb1 = bottomOffset + (y + 1) * gridX;
    indices.push(wt0, wt1, wb0, wt1, wb1, wb0);

    const et0 = topOffset + y * gridX + gridX - 1;
    const et1 = topOffset + (y + 1) * gridX + gridX - 1;
    const eb0 = bottomOffset + y * gridX + gridX - 1;
    const eb1 = bottomOffset + (y + 1) * gridX + gridX - 1;
    indices.push(et0, eb0, et1, et1, eb0, eb1);
  }

  return {
    positions,
    uvs,
    indices: Uint32Array.from(indices),
    gridX,
    gridY,
    stats: calculateStats(values, gridX, gridY, settings)
  };
}

function createTrimmedTerrainMesh(heightMap, settings) {
  if (heightMap.water?.enabled && heightMap.sourceValues?.length) {
    return createWaterClippedTerrainMesh(heightMap, settings);
  }

  return createMaskedCellTerrainMesh(heightMap, settings);
}

function createWaterClippedTerrainMesh(heightMap, settings) {
  const { width: gridX, height: gridY, values, sourceValues, water } = heightMap;
  const positions = [];
  const uvs = [];
  const indices = [];
  const waterLevel = Math.max(0, Math.min(0.95, water?.level ?? 0));
  const dryScale = Math.max(1 - waterLevel, 0.000001);
  let islandCellCount = 0;

  for (let y = 0; y < gridY - 1; y += 1) {
    for (let x = 0; x < gridX - 1; x += 1) {
      const corners = createCellCorners(sourceValues, x, y, gridX, gridY, settings);
      const polygon = clipPolygonAboveWater(corners, waterLevel);
      if (polygon.length < 3) continue;

      islandCellCount += 1;

      const top = [];
      const bottom = [];

      for (const point of polygon) {
        const heightValue = Math.max(0, Math.min(1, (point.source - waterLevel) / dryScale));
        top.push(
          pushVertex(
            positions,
            uvs,
            point.x,
            point.y,
            settings.baseThicknessMm + heightValue * settings.reliefHeightMm,
            point.u,
            point.v
          )
        );
        bottom.push(pushVertex(positions, uvs, point.x, point.y, 0, point.u, point.v));
      }

      for (let i = 1; i < polygon.length - 1; i += 1) {
        indices.push(top[0], top[i], top[i + 1]);
        indices.push(bottom[0], bottom[i + 1], bottom[i]);
      }

      for (let i = 0; i < polygon.length; i += 1) {
        const next = (i + 1) % polygon.length;
        const point = polygon[i];
        const nextPoint = polygon[next];
        const shouldWall =
          isWaterContourEdge(point, nextPoint) ||
          isDomainBoundaryEdge(point, nextPoint, gridX, gridY);

        if (shouldWall) {
          indices.push(top[i], bottom[i], bottom[next], top[i], bottom[next], top[next]);
        }
      }
    }
  }

  if (!islandCellCount) {
    return createMaskedCellTerrainMesh(heightMap, settings);
  }

  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    gridX,
    gridY,
    stats: calculateStats(values, gridX, gridY, settings, {
      cellMask: heightMap.cellMask,
      islandCellCount,
      triangleCount: indices.length / 3,
      water: {
        ...water,
        coverage: islandCellCount / Math.max(1, (gridX - 1) * (gridY - 1))
      }
    })
  };
}

function createMaskedCellTerrainMesh(heightMap, settings) {
  const { width: gridX, height: gridY, values, cellMask, water } = heightMap;
  const positions = [];
  const uvs = [];
  const indices = [];
  const stepX = settings.widthMm / (gridX - 1);
  const stepY = settings.depthMm / (gridY - 1);
  const halfW = settings.widthMm / 2;
  const halfD = settings.depthMm / 2;
  const cellWidth = gridX - 1;
  let islandCellCount = 0;

  for (let y = 0; y < gridY - 1; y += 1) {
    for (let x = 0; x < gridX - 1; x += 1) {
      const cellIndex = y * cellWidth + x;
      if (!cellMask[cellIndex]) continue;

      islandCellCount += 1;

      const x0 = x * stepX - halfW;
      const x1 = (x + 1) * stepX - halfW;
      const y0 = y * stepY - halfD;
      const y1 = (y + 1) * stepY - halfD;
      const u0 = x / (gridX - 1);
      const u1 = (x + 1) / (gridX - 1);
      const v0 = 1 - y / (gridY - 1);
      const v1 = 1 - (y + 1) / (gridY - 1);

      const nwHeight = getTopHeight(values[y * gridX + x], settings);
      const neHeight = getTopHeight(values[y * gridX + x + 1], settings);
      const swHeight = getTopHeight(values[(y + 1) * gridX + x], settings);
      const seHeight = getTopHeight(values[(y + 1) * gridX + x + 1], settings);

      const topNw = pushVertex(positions, uvs, x0, y0, nwHeight, u0, v0);
      const topNe = pushVertex(positions, uvs, x1, y0, neHeight, u1, v0);
      const topSw = pushVertex(positions, uvs, x0, y1, swHeight, u0, v1);
      const topSe = pushVertex(positions, uvs, x1, y1, seHeight, u1, v1);
      const bottomNw = pushVertex(positions, uvs, x0, y0, 0, u0, v0);
      const bottomNe = pushVertex(positions, uvs, x1, y0, 0, u1, v0);
      const bottomSw = pushVertex(positions, uvs, x0, y1, 0, u0, v1);
      const bottomSe = pushVertex(positions, uvs, x1, y1, 0, u1, v1);

      indices.push(topNw, topNe, topSe, topNw, topSe, topSw);
      indices.push(bottomNw, bottomSe, bottomNe, bottomNw, bottomSw, bottomSe);

      const northOpen = y === 0 || !cellMask[(y - 1) * cellWidth + x];
      const southOpen = y === gridY - 2 || !cellMask[(y + 1) * cellWidth + x];
      const westOpen = x === 0 || !cellMask[y * cellWidth + x - 1];
      const eastOpen = x === gridX - 2 || !cellMask[y * cellWidth + x + 1];

      if (northOpen) indices.push(topNw, bottomNw, bottomNe, topNw, bottomNe, topNe);
      if (southOpen) indices.push(topSw, topSe, bottomSw, topSe, bottomSe, bottomSw);
      if (westOpen) indices.push(topNw, topSw, bottomNw, topSw, bottomSw, bottomNw);
      if (eastOpen) indices.push(topNe, bottomNe, topSe, topSe, bottomNe, bottomSe);
    }
  }

  return {
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    gridX,
    gridY,
    stats: calculateStats(values, gridX, gridY, settings, {
      cellMask,
      islandCellCount,
      triangleCount: indices.length / 3,
      water
    })
  };
}

function createCellCorners(sourceValues, x, y, gridX, gridY, settings) {
  return [
    createCellPoint(sourceValues, x, y, gridX, gridY, settings),
    createCellPoint(sourceValues, x + 1, y, gridX, gridY, settings),
    createCellPoint(sourceValues, x + 1, y + 1, gridX, gridY, settings),
    createCellPoint(sourceValues, x, y + 1, gridX, gridY, settings)
  ];
}

function createCellPoint(sourceValues, gx, gy, gridX, gridY, settings) {
  const stepX = settings.widthMm / (gridX - 1);
  const stepY = settings.depthMm / (gridY - 1);
  const halfW = settings.widthMm / 2;
  const halfD = settings.depthMm / 2;
  const u = gx / (gridX - 1);
  const v = 1 - gy / (gridY - 1);

  return {
    gx,
    gy,
    source: sourceValues[gy * gridX + gx],
    u,
    v,
    waterline: false,
    x: gx * stepX - halfW,
    y: gy * stepY - halfD
  };
}

function clipPolygonAboveWater(corners, waterLevel) {
  const output = [];

  for (let i = 0; i < corners.length; i += 1) {
    const current = corners[i];
    const next = corners[(i + 1) % corners.length];
    const currentInside = current.source > waterLevel;
    const nextInside = next.source > waterLevel;

    if (currentInside && nextInside) {
      output.push(next);
    } else if (currentInside && !nextInside) {
      output.push(intersectWaterEdge(current, next, waterLevel));
    } else if (!currentInside && nextInside) {
      output.push(intersectWaterEdge(current, next, waterLevel));
      output.push(next);
    }
  }

  return output;
}

function intersectWaterEdge(a, b, waterLevel) {
  const range = b.source - a.source;
  const t = Math.max(0, Math.min(1, Math.abs(range) < 0.000001 ? 0.5 : (waterLevel - a.source) / range));

  return {
    gx: lerp(a.gx, b.gx, t),
    gy: lerp(a.gy, b.gy, t),
    source: waterLevel,
    u: lerp(a.u, b.u, t),
    v: lerp(a.v, b.v, t),
    waterline: true,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t)
  };
}

function isWaterContourEdge(a, b) {
  return a.waterline && b.waterline;
}

function isDomainBoundaryEdge(a, b, gridX, gridY) {
  const maxX = gridX - 1;
  const maxY = gridY - 1;

  return (
    (near(a.gx, 0) && near(b.gx, 0)) ||
    (near(a.gx, maxX) && near(b.gx, maxX)) ||
    (near(a.gy, 0) && near(b.gy, 0)) ||
    (near(a.gy, maxY) && near(b.gy, maxY))
  );
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function near(a, b) {
  return Math.abs(a - b) < 0.000001;
}

function setVertex(positions, index, x, y, z) {
  const i = index * 3;
  positions[i] = x;
  positions[i + 1] = y;
  positions[i + 2] = z;
}

function setUv(uvs, index, u, v) {
  const i = index * 2;
  uvs[i] = u;
  uvs[i + 1] = v;
}

function pushVertex(positions, uvs, x, y, z, u, v) {
  const index = positions.length / 3;
  positions.push(x, y, z);
  uvs.push(u, v);
  return index;
}

function getTopHeight(value, settings) {
  return settings.baseThicknessMm + value * settings.reliefHeightMm;
}

function calculateStats(values, gridX, gridY, settings, options = {}) {
  let min = Infinity;
  let max = -Infinity;
  let maxGradient = 0;
  const stepX = settings.widthMm / (gridX - 1);
  const stepY = settings.depthMm / (gridY - 1);
  const { cellMask = null } = options;

  for (let y = 0; y < gridY; y += 1) {
    for (let x = 0; x < gridX; x += 1) {
      if (cellMask && !vertexTouchesKeptCell(x, y, gridX, gridY, cellMask)) continue;

      const value = values[y * gridX + x];
      min = Math.min(min, value);
      max = Math.max(max, value);

      if (x < gridX - 1 && y < gridY - 1) {
        if (cellMask && !cellMask[y * (gridX - 1) + x]) continue;

        const dzdx =
          ((values[y * gridX + x + 1] - value) * settings.reliefHeightMm) / stepX;
        const dzdy =
          ((values[(y + 1) * gridX + x] - value) * settings.reliefHeightMm) / stepY;
        maxGradient = Math.max(maxGradient, Math.hypot(dzdx, dzdy));
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }

  return {
    minHeightMm: settings.baseThicknessMm + min * settings.reliefHeightMm,
    maxHeightMm: settings.baseThicknessMm + max * settings.reliefHeightMm,
    totalHeightMm: settings.baseThicknessMm + settings.reliefHeightMm,
    minPitchMm: Math.min(stepX, stepY),
    triangleCount:
      options.triangleCount ??
      (gridX - 1) * (gridY - 1) * 4 + (gridX - 1) * 4 + (gridY - 1) * 4,
    maxSlopeDegrees: (Math.atan(maxGradient) * 180) / Math.PI,
    trimmed: Boolean(cellMask),
    islandCellCount: options.islandCellCount ?? (gridX - 1) * (gridY - 1),
    landCoverage: options.water?.coverage ?? 1,
    waterLevel: options.water?.level ?? 0
  };
}

function vertexTouchesKeptCell(x, y, gridX, gridY, cellMask) {
  const cellWidth = gridX - 1;

  for (let oy = -1; oy <= 0; oy += 1) {
    for (let ox = -1; ox <= 0; ox += 1) {
      const cellX = x + ox;
      const cellY = y + oy;

      if (cellX < 0 || cellY < 0 || cellX >= cellWidth || cellY >= gridY - 1) {
        continue;
      }

      if (cellMask[cellY * cellWidth + cellX]) return true;
    }
  }

  return false;
}
