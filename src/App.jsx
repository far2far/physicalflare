import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SAMPLE_FLARES } from "./data/sampleFlares";
import {
  fetchCurrentBlockHeight,
  generateOnchainHeightMap,
  resolveSeedIndex
} from "./lib/onchainFlares";
import {
  DEFAULT_LANDSCAPE_SETTINGS,
  LANDSCAPE_PRESETS,
  buildPhysicalFlareHeightMap,
  getLandscapePreset,
  mergeLandscapeSettings
} from "./lib/flareLandscapeGenerator";
import { createFallbackPalette, extractFlarePalette } from "./lib/flarePalette";
import {
  MATERIAL_MODES,
  createMaterialCellMasks,
  getMaterialPlan,
  sampleMaterialPlanIndex
} from "./lib/materialPlans";
import { PRINTER_PRESETS, getFitReport, getPrinterPreset } from "./lib/printers";
import { chooseGridSize, createMaskedTerrainMesh, createTerrainMesh } from "./lib/terrainMesh";
import { createBinaryStl, downloadBlob } from "./lib/stl";

const FALLBACK_BLOCK_HEIGHT = 953507;

const DEFAULT_SETTINGS = {
  widthMm: 180,
  depthMm: 180,
  reliefHeightMm: 28,
  baseThicknessMm: 3,
  resolution: 160
};

const RESOLUTIONS = [96, 128, 160, 192, 224, 256];
const WATER_LEVEL_MIN = 0;
const WATER_LEVEL_MAX = 0.95;
const WATER_DRAG_SCALE = 1.2;
const WATER_MESH_COMMIT_INTERVAL_MS = 180;
const INITIAL_FLARE_COUNT = 120;
const FLARE_PAGE_SIZE = 96;
const SAMPLE_SEEDS = new Map(SAMPLE_FLARES.map((flare) => [flare.inscriptionId, flare.seedIndex]));
const WIZARD_STEPS = ["Pick", "Size", "Terrain", "Material", "Preview", "Order"];

function App() {
  const [collection, setCollection] = useState(SAMPLE_FLARES);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [visibleFlareCount, setVisibleFlareCount] = useState(INITIAL_FLARE_COUNT);
  const [screen, setScreen] = useState("landing");
  const [isLightMode, setIsLightMode] = useState(true);
  const [selectedFlare, setSelectedFlare] = useState(SAMPLE_FLARES[0]);
  const [resolvedSeedIndex, setResolvedSeedIndex] = useState(SAMPLE_FLARES[0].seedIndex);
  const [blockHeight, setBlockHeight] = useState(FALLBACK_BLOCK_HEIGHT);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [landscapeSettings, setLandscapeSettings] = useState(DEFAULT_LANDSCAPE_SETTINGS);
  const [viewerWaterLevel, setViewerWaterLevel] = useState(DEFAULT_LANDSCAPE_SETTINGS.waterLevel);
  const [printerId, setPrinterId] = useState("snapmaker-u1");
  const [materialMode, setMaterialMode] = useState("flare-colors");
  const [flarePalette, setFlarePalette] = useState(() =>
    createFallbackPalette("loading", "Reading")
  );
  const [customVolume, setCustomVolume] = useState({ x: 220, y: 220, z: 250 });
  const [heightMap, setHeightMap] = useState(null);
  const [terrain, setTerrain] = useState(null);
  const [status, setStatus] = useState("Preparing actual FLARES terrain...");
  const [viewerRenderMode, setViewerRenderMode] = useState("artwork");
  const [flarePreviewMode, setFlarePreviewMode] = useState("artwork");
  const [wizardStep, setWizardStep] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const isMobileWizard = useMobileWizard();
  const pendingWaterLevelRef = useRef(DEFAULT_LANDSCAPE_SETTINGS.waterLevel);
  const lastWaterCommitAtRef = useRef(0);
  const waterCommitTimerRef = useRef(null);
  const artworkImage = selectedFlare.image || selectedFlare.thumb;

  const grid = useMemo(
    () => chooseGridSize(settings.widthMm, settings.depthMm, settings.resolution),
    [settings.depthMm, settings.resolution, settings.widthMm]
  );

  const printer = useMemo(() => {
    const preset = getPrinterPreset(printerId);
    return printerId === "custom" ? { ...preset, volume: customVolume } : preset;
  }, [customVolume, printerId]);

  const physicalHeightMap = useMemo(() => {
    return buildPhysicalFlareHeightMap(heightMap, landscapeSettings);
  }, [heightMap, landscapeSettings]);

  const landscapePreset = useMemo(() => {
    return getLandscapePreset(landscapeSettings.mode);
  }, [landscapeSettings.mode]);

  const fitReport = useMemo(() => {
    return getFitReport(
      {
        width: settings.widthMm,
        depth: settings.depthMm,
        height: settings.baseThicknessMm + settings.reliefHeightMm
      },
      printer
    );
  }, [printer, settings]);

  const materialPlan = useMemo(() => {
    return getMaterialPlan({
      mode: materialMode,
      palette: flarePalette,
      printer,
      settings,
      terrain
    });
  }, [flarePalette, materialMode, printer, settings, terrain]);

  const materialPreviewPlan = useMemo(() => {
    return getMaterialPlan({
      mode: "flare-colors",
      palette: flarePalette,
      printer,
      settings,
      terrain
    });
  }, [flarePalette, printer, settings, terrain]);

  const typeOptions = useMemo(() => {
    const source = collection.length ? collection : SAMPLE_FLARES;
    const counts = new Map();

    source.forEach((flare) => {
      counts.set(flare.type, (counts.get(flare.type) ?? 0) + 1);
    });

    return Array.from(counts.entries())
      .map(([type, count]) => ({ count, type }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }, [collection]);

  const matchingFlares = useMemo(() => {
    const value = normalize(query);
    const source = collection.length ? collection : SAMPLE_FLARES;

    return source.filter((flare) => {
      const typeMatches = typeFilter === "all" || normalize(flare.type) === typeFilter;
      if (!typeMatches) return false;
      if (!value) return true;

      return (
        normalize(flare.name).includes(value) ||
        normalize(flare.type).includes(value) ||
        normalize(flare.inscriptionId).includes(value)
      );
    });
  }, [collection, query, typeFilter]);

  const visibleFlares = useMemo(() => {
    return matchingFlares.slice(0, visibleFlareCount);
  }, [matchingFlares, visibleFlareCount]);

  const collectionCount = collection.length ? collection.length : SAMPLE_FLARES.length;
  const hasMoreFlares = visibleFlares.length < matchingFlares.length;
  const activeTypeLabel =
    typeFilter === "all"
      ? "All types"
      : typeOptions.find((option) => normalize(option.type) === typeFilter)?.type ?? "Type";
  const pickerCountLabel = `${visibleFlares.length}/${matchingFlares.length} shown`;

  const warnings = useMemo(() => {
    const next = [];
    if (fitReport.status === "blocked") {
      next.push(...fitReport.blockers);
    }
    if (fitReport.status === "rotate") {
      next.push("Fits if rotated 90 degrees on the build plate.");
    }
    if (settings.baseThicknessMm < 2) {
      next.push("Base is thinner than 2 mm.");
    }
    if (terrain?.stats.minPitchMm < 0.35) {
      next.push("XY detail pitch is below 0.35 mm.");
    }
    if (terrain?.stats.maxSlopeDegrees > 72) {
      next.push("Very steep relief: lower relief height or scale the piece larger.");
    }
    if (physicalHeightMap?.water?.enabled && physicalHeightMap.water.coverage < 0.04) {
      next.push("Water level leaves a very small island footprint.");
    }
    next.push(...materialPlan.warnings);
    return next;
  }, [fitReport, materialPlan, physicalHeightMap, settings.baseThicknessMm, terrain]);

  useEffect(() => {
    let cancelled = false;
    fetch("/flares.json")
      .then((response) => {
        if (!response.ok) throw new Error("Collection data unavailable.");
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setCollection(data.map(normalizeCollectionFlare));
      })
      .catch(() => {
        if (!cancelled) setCollection(SAMPLE_FLARES);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setVisibleFlareCount(INITIAL_FLARE_COUNT);
  }, [query, typeFilter]);

  useEffect(() => {
    let cancelled = false;
    setFlarePalette(createFallbackPalette("loading", "Reading"));

    extractFlarePalette(artworkImage)
      .then((palette) => {
        if (!cancelled) setFlarePalette(palette);
      })
      .catch(() => {
        if (!cancelled) {
          setFlarePalette(createFallbackPalette("fallback", "Fallback"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artworkImage]);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentBlockHeight()
      .then((height) => {
        if (!cancelled && Number.isFinite(height)) setBlockHeight(height);
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(`Using fallback block height ${FALLBACK_BLOCK_HEIGHT}.`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (screen !== "studio") return undefined;

    let cancelled = false;
    setStatus(`Resolving ${selectedFlare.name} seed id...`);

    resolveSeedIndex(selectedFlare)
      .then((seedIndex) => {
        if (!cancelled) {
          setResolvedSeedIndex(seedIndex);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setResolvedSeedIndex(null);
          setStatus(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [screen, selectedFlare]);

  useEffect(() => {
    if (screen !== "studio") {
      setIsGenerating(false);
      return undefined;
    }

    if (!Number.isFinite(resolvedSeedIndex) || !Number.isFinite(blockHeight)) {
      setIsGenerating(false);
      return undefined;
    }

    const controller = new AbortController();
    setIsGenerating(true);
    setStatus(`Running actual FLARES Three.js seed ${resolvedSeedIndex}...`);

    generateOnchainHeightMap({
      seedIndex: resolvedSeedIndex,
      blockHeight,
      width: grid.x,
      height: grid.y,
      signal: controller.signal
    })
      .then((nextHeightMap) => {
        setHeightMap(nextHeightMap);
        setStatus(
          `Sampled actual displacement map ${nextHeightMap.sourceWidth} x ${nextHeightMap.sourceHeight}.`
        );
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        console.error("On-chain terrain generation failed", error);
        setHeightMap(null);
        setTerrain(null);
        setStatus(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsGenerating(false);
      });

    return () => {
      controller.abort();
    };
  }, [blockHeight, grid.x, grid.y, resolvedSeedIndex, screen]);

  useEffect(() => {
    if (!physicalHeightMap) {
      setTerrain(null);
      return;
    }

    setTerrain(createTerrainMesh(physicalHeightMap, settings));
  }, [physicalHeightMap, settings]);

  const updateSetting = (key, value) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const updateLandscapeSetting = (patch) => {
    if (Object.hasOwn(patch, "waterLevel")) {
      setViewerWaterLevel(clampWaterLevel(patch.waterLevel));
    } else if (patch.mode) {
      setViewerWaterLevel(getLandscapePreset(patch.mode).settings.waterLevel);
    }

    setLandscapeSettings((current) => mergeLandscapeSettings(current, patch));
  };

  const commitViewerWaterLevel = useCallback((level) => {
    lastWaterCommitAtRef.current = Date.now();
    setLandscapeSettings((current) =>
      mergeLandscapeSettings(current, {
        trimWater: true,
        waterLevel: level
      })
    );
  }, []);

  const updateWaterLevelFromViewer = useCallback(
    (value, options = {}) => {
      const level = clampWaterLevel(value);
      pendingWaterLevelRef.current = level;
      setViewerWaterLevel(level);

      if (waterCommitTimerRef.current) {
        clearTimeout(waterCommitTimerRef.current);
        waterCommitTimerRef.current = null;
      }

      if (options.commitNow) {
        commitViewerWaterLevel(level);
        return;
      }

      const elapsed = Date.now() - lastWaterCommitAtRef.current;
      const wait = Math.max(0, WATER_MESH_COMMIT_INTERVAL_MS - elapsed);

      if (!wait) {
        commitViewerWaterLevel(level);
        return;
      }

      waterCommitTimerRef.current = setTimeout(() => {
        waterCommitTimerRef.current = null;
        commitViewerWaterLevel(pendingWaterLevelRef.current);
      }, wait);
    },
    [commitViewerWaterLevel]
  );

  useEffect(() => {
    return () => {
      if (waterCommitTimerRef.current) clearTimeout(waterCommitTimerRef.current);
    };
  }, []);

  const scaleToPrinter = () => {
    const margin = printer.id === "gigastorm" ? 30 : 8;
    const maxW = Math.max(20, printer.volume.x - margin * 2);
    const maxD = Math.max(20, printer.volume.y - margin * 2);
    const factor = Math.min(maxW / settings.widthMm, maxD / settings.depthMm);
    setSettings((current) => ({
      ...current,
      widthMm: roundMm(current.widthMm * factor),
      depthMm: roundMm(current.depthMm * factor)
    }));
  };

  const selectFlare = useCallback((flare) => {
    setSelectedFlare(flare);
    setResolvedSeedIndex(Number.isFinite(flare.seedIndex) ? flare.seedIndex : null);
    setHeightMap(null);
    setTerrain(null);
    setStatus(`Preparing ${flare.name}...`);
    setWizardStep(1);
    setScreen("studio");
  }, []);

  const returnToPicker = useCallback(() => {
    setScreen("landing");
    setWizardStep(0);
    setIsGenerating(false);
  }, []);

  const showMoreFlares = useCallback(() => {
    setVisibleFlareCount((current) => Math.min(current + FLARE_PAGE_SIZE, matchingFlares.length));
  }, [matchingFlares.length]);

  const exportStl = useCallback(() => {
    if (!terrain) return;
    const blob = createBinaryStl(terrain, selectedFlare.name);
    const safeName = selectedFlare.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    downloadBlob(blob, `${safeName || "physicalflare"}-seed-${resolvedSeedIndex}.stl`);
  }, [resolvedSeedIndex, selectedFlare.name, terrain]);

  const exportMaterialStls = useCallback(() => {
    if (!physicalHeightMap || !materialPlan.colorMap?.length) return;

    const safeName = selectedFlare.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const masks = createMaterialCellMasks({
      baseCellMask: physicalHeightMap.cellMask,
      gridX: physicalHeightMap.width,
      gridY: physicalHeightMap.height,
      materialPlan
    });

    masks.forEach(({ band, cellCount, cellMask }) => {
      if (!cellCount) return;

      const materialMesh = createMaskedTerrainMesh(physicalHeightMap, settings, cellMask);
      if (!materialMesh.indices.length) return;

      const blob = createBinaryStl(materialMesh, `${selectedFlare.name} ${band.tool} ${band.name}`);
      downloadBlob(
        blob,
        `${safeName || "physicalflare"}-seed-${resolvedSeedIndex}-${band.tool.toLowerCase()}-${band.id}.stl`
      );
    });
  }, [materialPlan, physicalHeightMap, resolvedSeedIndex, selectedFlare.name, settings]);

  const fileSizeMb = terrain
    ? ((84 + (terrain.indices.length / 3) * 50) / 1024 / 1024).toFixed(1)
    : "0.0";
  const modelHeightMm = roundMm(settings.baseThicknessMm + settings.reliefHeightMm);
  const modelSizeLabel = `${roundMm(settings.widthMm)} x ${roundMm(settings.depthMm)} x ${modelHeightMm} mm`;
  const exportReady = Boolean(terrain && !isGenerating && fitReport.status !== "blocked");
  const materialExportReady = Boolean(
    exportReady &&
      materialPlan.mode === "flare-colors" &&
      materialPlan.colorMap?.length &&
      materialPlan.isSupported
  );
  const studioState = isGenerating ? "Generating" : terrain ? "Ready" : "Preparing";
  const fitLabel =
    fitReport.status === "fits" ? "Fits" : fitReport.status === "rotate" ? "Rotate" : "Check size";
  const waterLevelLabel = physicalHeightMap?.water?.enabled
    ? `${Math.round(physicalHeightMap.water.level * 100)}%`
    : "Off";
  const landCoverageLabel = terrain?.stats.trimmed
    ? `${Math.max(1, Math.round((terrain.stats.landCoverage ?? 0) * 100))}% land`
    : "Full field";
  const footprintLabel = terrain?.stats.trimmed ? "Islands" : "Full field";
  const materialSlotsLabel = `${materialPlan.requestedSlots}/${materialPlan.availableSlots}`;
  const renderModeLabel = {
    artwork: "Artwork relief",
    materials: "4 material relief",
    solid: "Mono relief"
  }[viewerRenderMode];
  const themeClass = isLightMode ? "is-light" : "is-dark";
  const toggleTheme = useCallback(() => {
    setIsLightMode((current) => !current);
  }, []);

  if (isMobileWizard) {
    return (
      <MobileWizardFlow
        activeType={typeFilter}
        activeTypeLabel={activeTypeLabel}
        artworkImage={artworkImage}
        collectionCount={collectionCount}
        exportReady={exportReady}
        fitLabel={fitLabel}
        flarePreviewMode={flarePreviewMode}
        hasMoreFlares={hasMoreFlares}
        isGenerating={isGenerating}
        isLightMode={isLightMode}
        landCoverageLabel={landCoverageLabel}
        landscapePreset={landscapePreset}
        landscapeSettings={landscapeSettings}
        materialMode={materialMode}
        materialPlan={materialPlan}
        materialPreviewPlan={materialPreviewPlan}
        modelSizeLabel={modelSizeLabel}
        onFlarePreviewModeChange={setFlarePreviewMode}
        onLandscapeChange={updateLandscapeSetting}
        onMaterialModeChange={setMaterialMode}
        onPreviewModeChange={setViewerRenderMode}
        onPrinterChange={setPrinterId}
        onQueryChange={setQuery}
        onReturnToPicker={returnToPicker}
        onScaleToPrinter={scaleToPrinter}
        onSelectFlare={selectFlare}
        onSettingChange={updateSetting}
        onShowMore={showMoreFlares}
        onStepChange={setWizardStep}
        onToggleTheme={toggleTheme}
        onTypeChange={setTypeFilter}
        onWaterLevelChange={updateWaterLevelFromViewer}
        physicalHeightMap={physicalHeightMap}
        pickerCountLabel={pickerCountLabel}
        printer={printer}
        printerId={printerId}
        query={query}
        renderMode={viewerRenderMode}
        screen={screen}
        selectedFlare={selectedFlare}
        settings={settings}
        status={status}
        terrain={terrain}
        themeClass={themeClass}
        typeOptions={typeOptions}
        visibleFlares={visibleFlares}
        warnings={warnings}
        waterLevel={viewerWaterLevel}
        waterLevelLabel={waterLevelLabel}
        wizardStep={wizardStep}
      />
    );
  }

  if (screen === "landing") {
    return (
      <main className={`landing-shell ${themeClass}`}>
        <header className="landing-header">
          <div className="brand-block">
            <div className="brand-kicker">FLARES / physical terrains</div>
            <h1>physicalflare</h1>
          </div>
          <div className="header-actions">
            <ThemeToggle isLightMode={isLightMode} onToggle={toggleTheme} />
            <div className="landing-count">
              {query || typeFilter !== "all" ? pickerCountLabel : `${collectionCount} FLARES`}
            </div>
          </div>
        </header>

        <section className="picker-workspace">
          <div className="picker-header">
            <div>
              <p>FLARE picker</p>
              <h2>{activeTypeLabel}</h2>
            </div>
            <label className="search-field">
              <span>Search</span>
              <input
                aria-label="Search FLARES"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="FLARE #95, type, or inscription"
                type="search"
                value={query}
              />
            </label>
          </div>

          <TypeFilterRail
            activeType={typeFilter}
            collectionCount={collectionCount}
            onSelectType={setTypeFilter}
            typeOptions={typeOptions}
          />

          {visibleFlares.length > 0 ? (
            <>
              <div className="flare-card-grid">
                {visibleFlares.map((flare) => (
                  <FlareCard
                    flare={flare}
                    isActive={selectedFlare.inscriptionId === flare.inscriptionId}
                    key={flare.inscriptionId}
                    onSelect={selectFlare}
                  />
                ))}
              </div>

              <div className="picker-footer">
                <span>{pickerCountLabel}</span>
                {hasMoreFlares && (
                  <button className="secondary-action" onClick={showMoreFlares} type="button">
                    Load more
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="empty-results">No FLARES found.</div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className={`studio-shell ${themeClass}`}>
      <section className="studio-stage">
        <div className="studio-toolbar">
          <button className="switch-flare-button" onClick={returnToPicker} type="button">
            Switch FLARE
          </button>

          <div className="studio-flare-lockup">
            <FlareThumbnail flare={selectedFlare} />
            <div>
              <p>{selectedFlare.type}</p>
              <h2>{selectedFlare.name}</h2>
              <span>
                {Number.isFinite(resolvedSeedIndex)
                  ? `seed ${resolvedSeedIndex}`
                  : "resolving seed"}
              </span>
            </div>
          </div>

          <div className="studio-state-stack">
            <ThemeToggle isLightMode={isLightMode} onToggle={toggleTheme} />
            <span className={`state-pill state-${normalize(studioState)}`}>{studioState}</span>
            <div className={`fit-pill fit-${fitReport.status}`}>{fitLabel}</div>
          </div>
        </div>

        <section className="visualizer-board">
          <aside className="visualizer-side">
            <FlareSourcePanel
              flare={selectedFlare}
              imageSrc={artworkImage}
              materialPlan={materialPlan}
              onPreviewModeChange={setFlarePreviewMode}
              previewMode={flarePreviewMode}
            />
            <TransformationPanel
              heightMap={heightMap}
              isGenerating={isGenerating}
              landscapeName={landscapePreset.name}
              modelSizeLabel={modelSizeLabel}
              physicalHeightMap={physicalHeightMap}
              terrain={terrain}
            />
          </aside>

          <section className="model-viewport">
            <div className="viewport-heading">
              <div>
                <p>3D visualizer</p>
                <h2>{renderModeLabel}</h2>
              </div>
              <div className="viewport-heading-actions">
                <RenderModeSwitch
                  mode={viewerRenderMode}
                  onChange={setViewerRenderMode}
                />
                <span>{terrain ? "actual mesh" : "preview mesh"}</span>
              </div>
            </div>

            <TerrainPreview
              imageSrc={artworkImage}
              isLightMode={isLightMode}
              isGenerating={isGenerating}
              materialPlan={materialPreviewPlan}
              onWaterLevelChange={updateWaterLevelFromViewer}
              renderMode={viewerRenderMode}
              terrain={terrain}
              trimWater={landscapeSettings.trimWater}
              waterLevel={viewerWaterLevel}
            />
          </section>
        </section>

        <footer className="studio-footer">
          <div className="studio-status">
            <span>{isGenerating ? "Generating actual FLARES terrain..." : status}</span>
            {selectedFlare.inscriptionId && (
              <a
                href={`https://ordinals.com/inscription/${selectedFlare.inscriptionId}`}
                rel="noreferrer"
                target="_blank"
              >
                Ordinals
              </a>
            )}
          </div>

          <div className="studio-readout">
            <Metric label="Model" value={modelSizeLabel} />
            <Metric label="Sampler" value={`${grid.x} x ${grid.y}`} />
            <Metric label="Build" value={printer.name} />
            <Metric label="Material" value={materialPlan.name} />
          </div>
        </footer>

        <WallMockupScreen
          flare={selectedFlare}
          imageSrc={artworkImage}
          modelSizeLabel={modelSizeLabel}
          terrain={terrain}
        />
      </section>

      <aside className="export-panel">
        <header className="export-summary">
          <div>
            <p>Export menu</p>
            <h2>STL output</h2>
          </div>

          <button
            className="primary-action export-now"
            disabled={!exportReady}
            onClick={exportStl}
            type="button"
          >
            Export STL
          </button>

          <button
            className="secondary-action export-materials"
            disabled={!materialExportReady}
            onClick={exportMaterialStls}
            type="button"
          >
            Export 4 STLs
          </button>

          <div className="export-summary-grid">
            <Metric label="Height" value={`${modelHeightMm} mm`} />
            <Metric label="Triangles" value={terrain ? terrain.stats.triangleCount.toLocaleString() : "-"} />
            <Metric label="STL" value={`${fileSizeMb} MB`} />
            <Metric label="Footprint" value={footprintLabel} />
          </div>
        </header>

        <section className="tool-section">
          <div className="section-heading">
            <h2>On-Chain</h2>
            <span>Three.js terrain</span>
          </div>

          <div className="grid-two">
            <NumberInput
              label="Block"
              max={2000000}
              min={830162}
              onChange={setBlockHeight}
              value={blockHeight}
            />
            <NumberInput
              label="Seed"
              max={511}
              min={0}
              onChange={setResolvedSeedIndex}
              value={resolvedSeedIndex ?? 0}
            />
          </div>
        </section>

        <section className="tool-section">
          <div className="section-heading">
            <h2>Printer</h2>
            <span>{`${printer.volume.x} x ${printer.volume.y} x ${printer.volume.z} mm`}</span>
          </div>

          <select value={printerId} onChange={(event) => setPrinterId(event.target.value)}>
            {PRINTER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>

          {printerId === "custom" && (
            <div className="triple-input">
              <NumberInput
                label="X"
                max={2000}
                min={20}
                onChange={(x) => setCustomVolume((current) => ({ ...current, x }))}
                value={customVolume.x}
              />
              <NumberInput
                label="Y"
                max={2000}
                min={20}
                onChange={(y) => setCustomVolume((current) => ({ ...current, y }))}
                value={customVolume.y}
              />
              <NumberInput
                label="Z"
                max={2000}
                min={20}
                onChange={(z) => setCustomVolume((current) => ({ ...current, z }))}
                value={customVolume.z}
              />
            </div>
          )}

          <button className="secondary-action" onClick={scaleToPrinter} type="button">
            Scale to build plate
          </button>
        </section>

        <MaterialPlanSection
          materialMode={materialMode}
          materialPlan={materialPlan}
          onChange={setMaterialMode}
        />

        <section className="tool-section generation-lab">
          <div className="section-heading">
            <h2>Generator</h2>
            <span>Model lab</span>
          </div>

          <label className="control-row">
            <span>Mode</span>
            <select
              value={landscapeSettings.mode}
              onChange={(event) => updateLandscapeSetting({ mode: event.target.value })}
            >
              {LANDSCAPE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid-two">
            <NumberInput
              label="Curve"
              max={2.6}
              min={0.35}
              onChange={(value) => updateLandscapeSetting({ curve: value })}
              step={0.05}
              value={landscapeSettings.curve}
            />
            <NumberInput
              label="Smooth"
              max={4}
              min={0}
              onChange={(value) => updateLandscapeSetting({ smoothing: value })}
              value={landscapeSettings.smoothing}
            />
            <NumberInput
              label="Ridges"
              max={1}
              min={0}
              onChange={(value) => updateLandscapeSetting({ ridgeGain: value })}
              step={0.05}
              value={landscapeSettings.ridgeGain}
            />
            <NumberInput
              label="Terraces"
              max={24}
              min={0}
              onChange={(value) => updateLandscapeSetting({ terraceCount: value })}
              value={landscapeSettings.terraceCount}
            />
            <NumberInput
              label="Micro"
              max={0.12}
              min={0}
              onChange={(value) => updateLandscapeSetting({ microRelief: value })}
              step={0.005}
              value={landscapeSettings.microRelief}
            />
            <NumberInput
              label="Water"
              max={0.95}
              min={0}
              onChange={(value) => updateWaterLevelFromViewer(value, { commitNow: true })}
              step={0.01}
              value={viewerWaterLevel}
            />
          </div>

          <label className="toggle-row">
            <input
              checked={landscapeSettings.trimWater}
              onChange={(event) => updateLandscapeSetting({ trimWater: event.target.checked })}
              type="checkbox"
            />
            <span>Island trim</span>
          </label>
        </section>

        <section className="tool-section">
          <div className="section-heading">
            <h2>Model</h2>
            <span>millimeters</span>
          </div>

          <div className="grid-two">
            <NumberInput
              label="Width"
              max={1200}
              min={20}
              onChange={(value) => updateSetting("widthMm", value)}
              value={settings.widthMm}
            />
            <NumberInput
              label="Depth"
              max={1200}
              min={20}
              onChange={(value) => updateSetting("depthMm", value)}
              value={settings.depthMm}
            />
            <NumberInput
              label="Relief"
              max={300}
              min={1}
              onChange={(value) => updateSetting("reliefHeightMm", value)}
              value={settings.reliefHeightMm}
            />
            <NumberInput
              label="Base"
              max={40}
              min={0.8}
              onChange={(value) => updateSetting("baseThicknessMm", value)}
              step={0.2}
              value={settings.baseThicknessMm}
            />
          </div>

          <label className="control-row">
            <span>Sampler</span>
            <select
              value={settings.resolution}
              onChange={(event) => updateSetting("resolution", Number(event.target.value))}
            >
              {RESOLUTIONS.map((value) => (
                <option key={value} value={value}>
                  {value} samples
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="tool-section export-menu">
          <div className="section-heading">
            <h2>Checks</h2>
            <span>{heightMap ? `${heightMap.width} x ${heightMap.height}` : "pending"}</span>
          </div>

          <div className="metric-grid">
            <Metric label="Fit" value={fitLabel} />
            <Metric label="Pitch" value={terrain ? `${terrain.stats.minPitchMm.toFixed(2)} mm` : "-"} />
            <Metric label="Slope" value={terrain ? `${terrain.stats.maxSlopeDegrees.toFixed(0)} deg` : "-"} />
            <Metric label="Mode" value={landscapePreset.name} />
            <Metric label="Water" value={waterLevelLabel} />
            <Metric label="Land" value={landCoverageLabel} />
            <Metric label="Tools" value={materialSlotsLabel} />
            <Metric label="Palette" value={materialPlan.paletteLabel} />
            <Metric label="Handoff" value={materialPlan.handoff} />
          </div>

          <HeightmapPreview heightMap={physicalHeightMap} />

          <div className="warnings" aria-live="polite">
            {warnings.length === 0 ? (
              <p>Ready for slicer validation.</p>
            ) : (
              warnings.map((warning) => <p key={warning}>{warning}</p>)
            )}
          </div>
        </section>
      </aside>
    </main>
  );
}

function ThemeToggle({ isLightMode, onToggle }) {
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      title={isLightMode ? "Switch to dark mode" : "Switch to light mode"}
      type="button"
    >
      {isLightMode ? "DARK" : "LIGHT"}
    </button>
  );
}

function MobileWizardFlow(props) {
  const activeStep =
    props.screen === "landing"
      ? 0
      : Math.min(Math.max(1, props.wizardStep), WIZARD_STEPS.length - 1);
  const canGoBack = activeStep > 0;
  const canGoNext = props.screen === "studio" && activeStep < WIZARD_STEPS.length - 1;

  const goBack = () => {
    if (activeStep <= 1) {
      props.onReturnToPicker();
      return;
    }
    props.onStepChange(activeStep - 1);
  };

  const goNext = () => {
    if (canGoNext) props.onStepChange(activeStep + 1);
  };

  return (
    <main className={`mobile-wizard ${props.themeClass}`}>
      <header className="wizard-header">
        <div>
          <p>physicalflare</p>
          <h1>{WIZARD_STEPS[activeStep]}</h1>
        </div>
        <ThemeToggle isLightMode={props.isLightMode} onToggle={props.onToggleTheme} />
      </header>

      <nav className="wizard-progress" aria-label="Order progress">
        {WIZARD_STEPS.map((step, index) => (
          <button
            aria-current={index === activeStep ? "step" : undefined}
            className={index === activeStep ? "is-active" : index < activeStep ? "is-done" : ""}
            disabled={props.screen === "landing" && index > 0}
            key={step}
            onClick={() => {
              if (index === 0) props.onReturnToPicker();
              else if (props.screen === "studio" && index <= activeStep) props.onStepChange(index);
            }}
            type="button"
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step}</strong>
          </button>
        ))}
      </nav>

      <section className="wizard-body">
        {activeStep === 0 && <WizardPickStep {...props} />}
        {activeStep === 1 && <WizardSizeStep {...props} />}
        {activeStep === 2 && <WizardTerrainStep {...props} />}
        {activeStep === 3 && <WizardMaterialStep {...props} />}
        {activeStep === 4 && <WizardPreviewStep {...props} />}
        {activeStep === 5 && <WizardOrderStep {...props} />}
      </section>

      {props.screen === "studio" && (
        <footer className="wizard-footer">
          <button disabled={!canGoBack} onClick={goBack} type="button">
            Back
          </button>
          {activeStep < WIZARD_STEPS.length - 1 ? (
            <button className="primary-action" disabled={!canGoNext} onClick={goNext} type="button">
              Continue
            </button>
          ) : (
            <button className="primary-action" disabled type="button">
              Checkout soon
            </button>
          )}
        </footer>
      )}
    </main>
  );
}

function WizardPickStep({
  activeType,
  activeTypeLabel,
  collectionCount,
  hasMoreFlares,
  onQueryChange,
  onSelectFlare,
  onShowMore,
  onTypeChange,
  pickerCountLabel,
  query,
  selectedFlare,
  typeOptions,
  visibleFlares
}) {
  return (
    <div className="wizard-step">
      <div className="wizard-step-heading">
        <p>{`${collectionCount} FLARES`}</p>
        <h2>{activeTypeLabel}</h2>
      </div>

      <label className="search-field">
        <span>Search</span>
        <input
          aria-label="Search FLARES"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="FLARE #95, type, or inscription"
          type="search"
          value={query}
        />
      </label>

      <TypeFilterRail
        activeType={activeType}
        collectionCount={collectionCount}
        onSelectType={onTypeChange}
        typeOptions={typeOptions}
      />

      <div className="wizard-flare-grid">
        {visibleFlares.map((flare) => (
          <FlareCard
            flare={flare}
            isActive={selectedFlare.inscriptionId === flare.inscriptionId}
            key={flare.inscriptionId}
            onSelect={onSelectFlare}
          />
        ))}
      </div>

      <div className="picker-footer">
        <span>{pickerCountLabel}</span>
        {hasMoreFlares && (
          <button className="secondary-action" onClick={onShowMore} type="button">
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

function WizardSizeStep({
  artworkImage,
  modelSizeLabel,
  onPrinterChange,
  onScaleToPrinter,
  onSettingChange,
  printer,
  printerId,
  selectedFlare,
  settings
}) {
  const presets = [
    { depth: 120, label: "Small", relief: 18, width: 120 },
    { depth: 180, label: "Studio", relief: 28, width: 180 },
    { depth: 240, label: "Large", relief: 36, width: 240 }
  ];

  const applyPreset = (preset) => {
    onSettingChange("widthMm", preset.width);
    onSettingChange("depthMm", preset.depth);
    onSettingChange("reliefHeightMm", preset.relief);
  };

  return (
    <div className="wizard-step">
      <WizardFlareSummary flare={selectedFlare} imageSrc={artworkImage} meta={modelSizeLabel} />

      <section className="wizard-panel">
        <div className="section-heading">
          <h2>Build size</h2>
          <span>{printer.name}</span>
        </div>
        <div className="wizard-segment-grid">
          {presets.map((preset) => (
            <button key={preset.label} onClick={() => applyPreset(preset)} type="button">
              <span>{preset.label}</span>
              <strong>{`${preset.width} mm`}</strong>
            </button>
          ))}
        </div>
        <select
          aria-label="Printer"
          value={printerId}
          onChange={(event) => onPrinterChange(event.target.value)}
        >
          {PRINTER_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <button className="secondary-action" onClick={onScaleToPrinter} type="button">
          Scale to build plate
        </button>
      </section>

      <section className="wizard-panel">
        <div className="grid-two">
          <NumberInput label="Width" max={1200} min={20} onChange={(value) => onSettingChange("widthMm", value)} value={settings.widthMm} />
          <NumberInput label="Depth" max={1200} min={20} onChange={(value) => onSettingChange("depthMm", value)} value={settings.depthMm} />
          <NumberInput label="Relief" max={300} min={1} onChange={(value) => onSettingChange("reliefHeightMm", value)} value={settings.reliefHeightMm} />
          <NumberInput label="Base" max={40} min={0.8} onChange={(value) => onSettingChange("baseThicknessMm", value)} step={0.2} value={settings.baseThicknessMm} />
        </div>
      </section>
    </div>
  );
}

function WizardTerrainStep({
  landscapePreset,
  landscapeSettings,
  onLandscapeChange,
  onWaterLevelChange,
  physicalHeightMap,
  waterLevel,
  waterLevelLabel
}) {
  return (
    <div className="wizard-step">
      <section className="wizard-panel">
        <div className="section-heading">
          <h2>Landscape</h2>
          <span>{landscapePreset.name}</span>
        </div>
        <label className="control-row">
          <span>Mode</span>
          <select
            aria-label="Terrain mode"
            value={landscapeSettings.mode}
            onChange={(event) => onLandscapeChange({ mode: event.target.value })}
          >
            {LANDSCAPE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid-two">
          <NumberInput label="Curve" max={2.6} min={0.35} onChange={(value) => onLandscapeChange({ curve: value })} step={0.05} value={landscapeSettings.curve} />
          <NumberInput label="Smooth" max={4} min={0} onChange={(value) => onLandscapeChange({ smoothing: value })} value={landscapeSettings.smoothing} />
          <NumberInput label="Ridges" max={1} min={0} onChange={(value) => onLandscapeChange({ ridgeGain: value })} step={0.05} value={landscapeSettings.ridgeGain} />
          <NumberInput label="Water" max={0.95} min={0} onChange={(value) => onWaterLevelChange(value, { commitNow: true })} step={0.01} value={waterLevel} />
        </div>
        <label className="toggle-row">
          <input
            checked={landscapeSettings.trimWater}
            onChange={(event) => onLandscapeChange({ trimWater: event.target.checked })}
            type="checkbox"
          />
          <span>{`Island trim / ${waterLevelLabel}`}</span>
        </label>
      </section>

      <HeightmapPreview heightMap={physicalHeightMap} />
    </div>
  );
}

function WizardMaterialStep({
  materialMode,
  materialPlan,
  onMaterialModeChange
}) {
  return (
    <div className="wizard-step">
      <section className="wizard-panel">
        <div className="section-heading">
          <h2>Materials</h2>
          <span>{`${materialPlan.requestedSlots}/${materialPlan.availableSlots} tools`}</span>
        </div>
        <select
          aria-label="Material mode"
          value={materialMode}
          onChange={(event) => onMaterialModeChange(event.target.value)}
        >
          {MATERIAL_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
        <div className="material-band-grid" aria-label="Material colors">
          {materialPlan.bands.map((band) => (
            <div className="material-band" key={band.id} style={{ "--band-color": band.color }}>
              <span>{band.tool}</span>
              <strong>{band.name}</strong>
              <em>{band.range}</em>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function WizardPreviewStep(props) {
  return (
    <div className="wizard-step">
      <section className="model-viewport wizard-preview-panel">
        <div className="viewport-heading">
          <div>
            <p>Preview</p>
            <h2>3D model</h2>
          </div>
          <RenderModeSwitch mode={props.renderMode} onChange={props.onPreviewModeChange} />
        </div>
        <TerrainPreview
          imageSrc={props.artworkImage}
          isGenerating={props.isGenerating}
          isLightMode={props.isLightMode}
          materialPlan={props.materialPreviewPlan}
          onWaterLevelChange={props.onWaterLevelChange}
          renderMode={props.renderMode}
          terrain={props.terrain}
          trimWater={props.landscapeSettings.trimWater}
          waterLevel={props.waterLevel}
        />
      </section>

      <div className="wizard-summary-grid">
        <Metric label="Model" value={props.modelSizeLabel} />
        <Metric label="Fit" value={props.fitLabel} />
        <Metric label="Material" value={props.materialPlan.name} />
        <Metric label="Land" value={props.landCoverageLabel} />
      </div>

      <div className="warnings" aria-live="polite">
        {props.warnings.length === 0 ? (
          <p>Ready for order review.</p>
        ) : (
          props.warnings.slice(0, 3).map((warning) => <p key={warning}>{warning}</p>)
        )}
      </div>
    </div>
  );
}

function WizardOrderStep({
  artworkImage,
  exportReady,
  fitLabel,
  materialPlan,
  modelSizeLabel,
  printer,
  selectedFlare,
  settings
}) {
  const placeholderPrice = estimatePlaceholderPrice(settings, materialPlan);

  return (
    <div className="wizard-step">
      <WizardFlareSummary
        flare={selectedFlare}
        imageSrc={artworkImage}
        meta={`${modelSizeLabel} / ${materialPlan.name}`}
      />

      <section className="wizard-panel">
        <div className="section-heading">
          <h2>Order</h2>
          <span>{fitLabel}</span>
        </div>
        <div className="wizard-summary-grid">
          <Metric label="Printer" value={printer.name} />
          <Metric label="Material" value={materialPlan.name} />
          <Metric label="Estimate" value={`$${placeholderPrice}`} />
          <Metric label="Status" value={exportReady ? "Ready" : "Review"} />
        </div>
      </section>

      <form className="wizard-payment-form" onSubmit={(event) => event.preventDefault()}>
        <label>
          <span>Email</span>
          <input autoComplete="email" placeholder="collector@example.com" type="email" />
        </label>
        <label>
          <span>Ship to</span>
          <input autoComplete="shipping street-address" placeholder="Shipping address" type="text" />
        </label>
        <label>
          <span>Payment</span>
          <input disabled placeholder="Stripe / wallet placeholder" type="text" />
        </label>
        <button className="primary-action" disabled type="submit">
          Checkout placeholder
        </button>
      </form>
    </div>
  );
}

function WizardFlareSummary({ flare, imageSrc, meta }) {
  return (
    <section className="wizard-flare-summary">
      <div className="flare-thumbnail">
        {imageSrc ? <img alt={flare.name} src={imageSrc} /> : <span>{flare.name}</span>}
      </div>
      <div>
        <p>{flare.type}</p>
        <h2>{flare.name}</h2>
        <span>{meta}</span>
      </div>
    </section>
  );
}

function RenderModeSwitch({ mode, onChange }) {
  const modes = [
    { id: "artwork", label: "Artwork", title: "Show the original FLARE texture on the terrain" },
    { id: "materials", label: "4 Mat", title: "Show the FLARE quantized into four material colors" },
    { id: "solid", label: "Mono", title: "Show a one-material printable surface" }
  ];

  return (
    <div className="render-mode-switch" aria-label="3D render mode">
      {modes.map((item) => (
        <button
          className={mode === item.id ? "is-active" : ""}
          key={item.id}
          onClick={() => onChange(item.id)}
          title={item.title}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function TypeFilterRail({ activeType, collectionCount, onSelectType, typeOptions }) {
  return (
    <nav aria-label="Explore FLARES by type" className="type-filter-rail">
      <button
        className={activeType === "all" ? "is-active" : ""}
        onClick={() => onSelectType("all")}
        type="button"
      >
        <span>All</span>
        <strong>{collectionCount}</strong>
      </button>
      {typeOptions.map((option) => (
        <button
          className={activeType === normalize(option.type) ? "is-active" : ""}
          key={option.type}
          onClick={() => onSelectType(normalize(option.type))}
          type="button"
        >
          <span>{option.type}</span>
          <strong>{option.count}</strong>
        </button>
      ))}
    </nav>
  );
}

function MaterialPlanSection({ materialMode, materialPlan, onChange }) {
  return (
    <section className="tool-section material-section">
      <div className="section-heading">
        <h2>Materials</h2>
        <span>{`${materialPlan.availableSlots} tool${materialPlan.availableSlots === 1 ? "" : "s"}`}</span>
      </div>

      <label className="control-row">
        <span>Plan</span>
        <select value={materialMode} onChange={(event) => onChange(event.target.value)}>
          {MATERIAL_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
      </label>

      <div className="material-band-grid" aria-label="Material elevation bands">
        {materialPlan.bands.map((band) => (
          <div className="material-band" key={band.id} style={{ "--band-color": band.color }}>
            <span>{band.tool}</span>
            <strong>{band.name}</strong>
            <em>{band.range}</em>
          </div>
        ))}
      </div>

      <div className="metric-grid material-metric-grid">
        <Metric label="Tools" value={`${materialPlan.requestedSlots}/${materialPlan.availableSlots}`} />
        <Metric label="Palette" value={materialPlan.paletteLabel} />
        <Metric label="Slicer" value={materialPlan.slicer} />
      </div>
    </section>
  );
}

function FlareCard({ flare, isActive, onSelect }) {
  return (
    <button
      aria-label={`Open ${flare.name} in 3D studio`}
      className={`flare-card ${isActive ? "is-active" : ""}`}
      onClick={() => onSelect(flare)}
      type="button"
    >
      <FlareThumbnail flare={flare} />
      <span aria-hidden="true" className="flare-card-action">
        Open Studio
      </span>
      <span className="flare-card-meta">{flare.type}</span>
      <strong>{flare.name}</strong>
    </button>
  );
}

function FlareThumbnail({ flare }) {
  const imageSrc = flare.thumb || flare.image;

  return (
    <div className="flare-thumbnail">
      {imageSrc ? <img alt={flare.name} loading="lazy" src={imageSrc} /> : <span>{flare.name}</span>}
    </div>
  );
}

function FlareSourcePanel({ flare, imageSrc, materialPlan, onPreviewModeChange, previewMode }) {
  return (
    <section className="source-art-panel">
      <div className="panel-heading">
        <p>Actual FLARE</p>
        <h2>{flare.name}</h2>
      </div>
      <div className="preview-mode-switch" aria-label="FLARE preview mode">
        <button
          className={previewMode === "artwork" ? "is-active" : ""}
          onClick={() => onPreviewModeChange("artwork")}
          type="button"
        >
          Artwork
        </button>
        <button
          className={previewMode === "materials" ? "is-active" : ""}
          disabled={!materialPlan.colorMap?.length}
          onClick={() => onPreviewModeChange("materials")}
          type="button"
        >
          4 Materials
        </button>
      </div>
      <div className="source-art-frame">
        {previewMode === "materials" && materialPlan.colorMap?.length ? (
          <MaterialMapPreview materialPlan={materialPlan} />
        ) : imageSrc ? (
          <img alt={flare.name} src={imageSrc} />
        ) : (
          <span>{flare.name}</span>
        )}
      </div>
    </section>
  );
}

function MaterialMapPreview({ materialPlan }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !materialPlan.colorMap?.length) return;

    const width = materialPlan.mapWidth;
    const height = materialPlan.mapHeight;
    const ctx = canvas.getContext("2d");
    canvas.width = width;
    canvas.height = height;
    const data = ctx.createImageData(width, height);
    const colors = materialPlan.bands.map((band) => hexToRgb(band.color));

    for (let i = 0; i < materialPlan.colorMap.length; i += 1) {
      const color = colors[materialPlan.colorMap[i]] ?? colors[0] ?? { b: 0, g: 0, r: 0 };
      data.data[i * 4] = color.r;
      data.data[i * 4 + 1] = color.g;
      data.data[i * 4 + 2] = color.b;
      data.data[i * 4 + 3] = 255;
    }

    ctx.putImageData(data, 0, 0);
  }, [materialPlan]);

  return <canvas aria-label="Four-material FLARE preview" ref={canvasRef} />;
}

function TransformationPanel({
  heightMap,
  isGenerating,
  landscapeName,
  modelSizeLabel,
  physicalHeightMap,
  terrain
}) {
  const physicalFieldLabel = physicalHeightMap?.water?.enabled
    ? `${landscapeName} / islands`
    : landscapeName;

  return (
    <section className="transformation-panel">
      <div className="panel-heading">
        <p>Transformation</p>
        <h2>{terrain ? "Ready for print" : isGenerating ? "Sampling depth" : "Preparing mesh"}</h2>
      </div>

      <div className="transform-step">
        <span>01</span>
        <strong>On-chain artwork</strong>
      </div>
      <div className="transform-step">
        <span>02</span>
        <strong>{heightMap ? `${heightMap.sourceWidth} px shader sample` : "Shader sample pending"}</strong>
        <HeightmapPreview heightMap={heightMap} />
      </div>
      <div className="transform-step">
        <span>03</span>
        <strong>{physicalHeightMap ? physicalFieldLabel : "Physical field pending"}</strong>
        <HeightmapPreview heightMap={physicalHeightMap} />
      </div>
      <div className="transform-step">
        <span>04</span>
        <strong>{modelSizeLabel}</strong>
      </div>
    </section>
  );
}

function WallMockupScreen({ flare, imageSrc, modelSizeLabel, terrain }) {
  const mockupStyle = imageSrc ? { "--flare-image": cssImageUrl(imageSrc) } : undefined;

  return (
    <section className="mockup-screen" style={mockupStyle}>
      <div className="mockup-heading">
        <div>
          <p>Wall mockup</p>
          <h2>{flare.name}</h2>
        </div>
        <span>{terrain ? modelSizeLabel : "previewing placement"}</span>
      </div>

      <div className="mockup-shots">
        <MockupShot kind="wide" label="Front / wide" />
        <MockupShot kind="surface" label="Surface detail" />
        <MockupShot kind="edge" label="Edge profile" />
        <MockupShot kind="corner" label="Corner closeup" />
      </div>
    </section>
  );
}

function MockupShot({ kind, label }) {
  return (
    <article className={`mockup-shot mockup-${kind}`}>
      <div className="mockup-canvas">
        <div className="mockup-wall" />
        <div className="mockup-floor" />
        <div className="mockup-art" />
      </div>
      <strong>{label}</strong>
    </article>
  );
}

function TerrainPreview({
  imageSrc,
  isLightMode,
  isGenerating,
  materialPlan,
  onWaterLevelChange,
  renderMode,
  terrain,
  trimWater,
  waterLevel
}) {
  const containerRef = useRef(null);
  const runtimeRef = useRef(null);
  const waterRailRef = useRef(null);
  const waterRailDragRef = useRef(false);
  const waterPropsRef = useRef({ onWaterLevelChange, trimWater, waterLevel });

  const setView = useCallback((view) => {
    const runtime = runtimeRef.current;
    if (!runtime?.currentTerrain) return;
    frameTerrain(runtime, view);
  }, []);

  useEffect(() => {
    waterPropsRef.current = { onWaterLevelChange, trimWater, waterLevel };
  }, [onWaterLevelChange, trimWater, waterLevel]);

  const commitWaterRailLevel = useCallback(
    (clientY, options = {}) => {
      const rail = waterRailRef.current;
      if (!rail) return;

      const rect = rail.getBoundingClientRect();
      const ratio = 1 - (clientY - rect.top) / Math.max(1, rect.height);
      onWaterLevelChange?.(clampWaterLevel(ratio * WATER_LEVEL_MAX), options);
    },
    [onWaterLevelChange]
  );

  const startWaterRailDrag = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      waterRailDragRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      commitWaterRailLevel(event.clientY);
    },
    [commitWaterRailLevel]
  );

  const moveWaterRailDrag = useCallback(
    (event) => {
      if (!waterRailDragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      commitWaterRailLevel(event.clientY);
    },
    [commitWaterRailLevel]
  );

  const stopWaterRailDrag = useCallback(
    (event) => {
      if (!waterRailDragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      commitWaterRailLevel(event.clientY, { commitNow: true });
      waterRailDragRef.current = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    [commitWaterRailLevel]
  );

  const adjustWaterFromKey = useCallback(
    (event) => {
      const keySteps = {
        ArrowDown: -0.01,
        ArrowLeft: -0.01,
        ArrowRight: 0.01,
        ArrowUp: 0.01,
        PageDown: -0.05,
        PageUp: 0.05
      };

      const step = keySteps[event.key];
      if (!step) return;

      event.preventDefault();
      onWaterLevelChange?.(clampWaterLevel(waterLevel + step), { commitNow: true });
    },
    [onWaterLevelChange, waterLevel]
  );

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.setAttribute("aria-label", "STL terrain model viewer");
    containerRef.current.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const viewerTheme = getViewerTheme(isLightMode);
    scene.background = new THREE.Color(viewerTheme.background);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
    camera.position.set(260, 180, 280);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.panSpeed = 0.55;
    controls.rotateSpeed = 0.55;
    controls.screenSpacePanning = true;
    controls.target.set(0, 18, 0);

    const modelRoot = new THREE.Group();
    modelRoot.name = "model-root";
    scene.add(modelRoot);

    const ambient = new THREE.HemisphereLight(0xf8f0df, 0x111413, 1.8);
    const key = new THREE.DirectionalLight(0xffffff, 2.7);
    key.position.set(-220, 380, 250);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 1200;
    key.shadow.camera.left = -500;
    key.shadow.camera.right = 500;
    key.shadow.camera.top = 500;
    key.shadow.camera.bottom = -500;
    const rim = new THREE.DirectionalLight(0x79e7d4, 1.1);
    rim.position.set(340, 160, -260);
    scene.add(ambient, key, rim);

    const grid = createBuildGrid(260, 10, viewerTheme);
    grid.position.y = -0.05;
    scene.add(grid);

    const waterGizmo = createWaterGizmo();
    scene.add(waterGizmo.root);

    const resize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height);
      camera.aspect = rect.width / Math.max(1, rect.height);
      camera.updateProjectionMatrix();
      if (runtimeRef.current?.currentTerrain) {
        frameTerrain(runtimeRef.current, runtimeRef.current.view);
        updateWaterGizmo(runtimeRef.current, waterPropsRef.current.waterLevel, waterPropsRef.current.trimWater);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current);
    resize();

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();

    const getWaterHit = (event) => {
      const runtime = runtimeRef.current;
      if (!runtime?.waterGizmo?.root.visible) return null;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(runtime.waterPickTargets, false)[0] ?? null;
    };

    const setCanvasCursor = (value) => {
      renderer.domElement.style.cursor = value;
    };

    const commitWaterDrag = (event) => {
      const runtime = runtimeRef.current;
      if (!runtime?.waterDrag) return;

      event.preventDefault();
      const rect = renderer.domElement.getBoundingClientRect();
      const drag = runtime.waterDrag;
      const delta = ((drag.startY - event.clientY) / Math.max(1, rect.height)) * WATER_DRAG_SCALE;
      const nextLevel = clampWaterLevel(drag.startLevel + delta);
      updateWaterGizmo(runtime, nextLevel, true);

      if (nextLevel !== drag.lastLevel) {
        drag.lastLevel = nextLevel;
        waterPropsRef.current.onWaterLevelChange?.(nextLevel);
      }
    };

    const onPointerDown = (event) => {
      const hit = getWaterHit(event);
      if (!hit) return;

      event.preventDefault();
      renderer.domElement.setPointerCapture?.(event.pointerId);
      controls.enabled = false;
      setCanvasCursor("ns-resize");
      runtimeRef.current.waterDrag = {
        pointerId: event.pointerId,
        startLevel: clampWaterLevel(waterPropsRef.current.waterLevel),
        startY: event.clientY,
        lastLevel: clampWaterLevel(waterPropsRef.current.waterLevel)
      };
    };

    const onPointerMove = (event) => {
      const runtime = runtimeRef.current;
      if (runtime?.waterDrag) {
        commitWaterDrag(event);
        return;
      }

      setCanvasCursor(getWaterHit(event) ? "ns-resize" : "grab");
    };

    const onPointerEnd = (event) => {
      const runtime = runtimeRef.current;
      if (!runtime?.waterDrag || runtime.waterDrag.pointerId !== event.pointerId) return;

      waterPropsRef.current.onWaterLevelChange?.(runtime.waterDrag.lastLevel, { commitNow: true });
      renderer.domElement.releasePointerCapture?.(event.pointerId);
      runtime.waterDrag = null;
      controls.enabled = true;
      setCanvasCursor(getWaterHit(event) ? "ns-resize" : "grab");
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerEnd);
    renderer.domElement.addEventListener("pointercancel", onPointerEnd);

    runtimeRef.current = {
      renderer,
      scene,
      camera,
      controls,
      currentTerrain: null,
      grid,
      modelRoot,
      view: "iso",
      waterDrag: null,
      waterGizmo,
      viewerTheme,
      waterPickTargets: [waterGizmo.handle, waterGizmo.arrow, waterGizmo.pickTarget]
    };

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerEnd);
      renderer.domElement.removeEventListener("pointercancel", onPointerEnd);
      controls.dispose();
      disposeObject(modelRoot);
      disposeObject(grid);
      disposeObject(waterGizmo.root);
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return undefined;

    if (runtime.currentTerrain) {
      runtime.modelRoot.remove(runtime.currentTerrain);
      disposeObject(runtime.currentTerrain);
      runtime.currentTerrain = null;
    }

    const activeTerrain = terrain ?? createPlaceholderTerrain();
    const isPlaceholder = !terrain;

    const geometry = new THREE.BufferGeometry();
    const previewPositions = new Float32Array(activeTerrain.positions.length);
    const colors = new Float32Array(activeTerrain.positions.length);

    for (let i = 0; i < activeTerrain.positions.length; i += 3) {
      previewPositions[i] = activeTerrain.positions[i];
      previewPositions[i + 1] = activeTerrain.positions[i + 2];
      previewPositions[i + 2] = -activeTerrain.positions[i + 1];
    }

    const viewerTheme = runtime.viewerTheme ?? getViewerTheme(isLightMode);
    const usesArtworkTexture = renderMode === "artwork";
    const usesMaterialColors = renderMode === "materials";
    writePreviewColors(
      colors,
      previewPositions,
      activeTerrain.uvs,
      activeTerrain.stats,
      viewerTheme,
      usesMaterialColors ? materialPlan : null
    );

    geometry.setAttribute("position", new THREE.BufferAttribute(previewPositions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(activeTerrain.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(activeTerrain.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    let disposed = false;
    const material = new THREE.MeshStandardMaterial({
      color: usesArtworkTexture || usesMaterialColors ? 0xffffff : viewerTheme.solid,
      emissive: usesArtworkTexture || usesMaterialColors ? 0x000000 : viewerTheme.solidEmissive,
      emissiveIntensity: usesArtworkTexture || usesMaterialColors ? 0 : 0.12,
      roughness: 0.7,
      metalness: 0.02,
      opacity: isPlaceholder ? 0.74 : 1,
      side: THREE.DoubleSide,
      transparent: isPlaceholder,
      vertexColors: usesMaterialColors
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.role = "terrainMesh";
    mesh.userData.renderMode = renderMode;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const edgeGeometry = new THREE.EdgesGeometry(geometry, usesArtworkTexture ? 32 : 24);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: usesArtworkTexture ? viewerTheme.textureEdges : viewerTheme.solidEdges,
      transparent: true,
      opacity: isPlaceholder ? 0.18 : usesArtworkTexture ? 0.22 : 0.34
    });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.userData.role = "terrainEdges";
    edges.userData.renderMode = renderMode;

    const model = new THREE.Group();
    model.name = "terrain";
    model.add(mesh, edges);
    runtime.modelRoot.add(model);
    runtime.currentTerrain = model;
    updateBuildPlate(runtime, model);
    frameTerrain(runtime, runtime.view);
    updateWaterGizmo(runtime, waterPropsRef.current.waterLevel, waterPropsRef.current.trimWater);

    if (usesArtworkTexture && imageSrc) {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin("anonymous");
      loader.load(
        imageSrc,
        (texture) => {
          if (disposed) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 8;
          material.map = texture;
          material.vertexColors = false;
          material.needsUpdate = true;
        },
        undefined,
        () => {
          material.color.set(viewerTheme.solid);
          material.vertexColors = true;
          material.needsUpdate = true;
        }
      );
    }

    return () => {
      disposed = true;
      if (runtime.currentTerrain === model) {
        runtime.modelRoot.remove(model);
        runtime.currentTerrain = null;
      }
      disposeObject(model);
    };
  }, [imageSrc, materialPlan, renderMode, terrain]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    runtime.viewerTheme = getViewerTheme(isLightMode);
    applyViewerTheme(runtime);
    if (runtime.currentTerrain) updateBuildPlate(runtime, runtime.currentTerrain);
  }, [isLightMode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    updateWaterGizmo(runtime, waterLevel, trimWater);
  }, [terrain, trimWater, waterLevel]);

  return (
    <div className="terrain-preview" ref={containerRef}>
      {terrain && (
        <div className={`water-gizmo-readout ${trimWater ? "is-active" : ""}`}>
          <span>Water Z</span>
          <strong>{trimWater ? `${Math.round(clampWaterLevel(waterLevel) * 100)}%` : "Off"}</strong>
        </div>
      )}
      {terrain && (
        <div
          aria-label="Water Z"
          aria-valuemax={Math.round(WATER_LEVEL_MAX * 100)}
          aria-valuemin={0}
          aria-valuenow={Math.round(clampWaterLevel(waterLevel) * 100)}
          className={`water-z-gumball ${trimWater ? "is-active" : ""}`}
          onKeyDown={adjustWaterFromKey}
          onPointerCancel={stopWaterRailDrag}
          onPointerDown={startWaterRailDrag}
          onPointerMove={moveWaterRailDrag}
          onPointerUp={stopWaterRailDrag}
          ref={waterRailRef}
          role="slider"
          style={{ "--water-level-ratio": clampWaterLevel(waterLevel) / WATER_LEVEL_MAX }}
          tabIndex={0}
          title="Water Z"
        >
          <span className="water-z-gumball-arrow" />
          <span className="water-z-gumball-rail" />
          <span className="water-z-gumball-handle" />
        </div>
      )}
      <div className="viewer-hud">
        {terrain ? (
          <div className="view-buttons" onPointerDown={(event) => event.stopPropagation()}>
            <button onClick={() => setView("iso")} title="Isometric view" type="button">
              ISO
            </button>
            <button onClick={() => setView("top")} title="Top view" type="button">
              TOP
            </button>
            <button onClick={() => setView("front")} title="Front view" type="button">
              FRONT
            </button>
            <button onClick={() => setView("iso")} title="Reset view" type="button">
              RESET
            </button>
          </div>
        ) : (
          <div className="viewer-empty">
            {isGenerating ? "Building actual terrain" : "Preview mesh"}
          </div>
        )}
      </div>
    </div>
  );
}

function createWaterGizmo() {
  const root = new THREE.Group();
  root.name = "water-gumball";
  root.visible = false;

  const planeMaterial = new THREE.MeshBasicMaterial({
    color: 0x79e7d4,
    depthWrite: false,
    opacity: 0.12,
    side: THREE.DoubleSide,
    transparent: true
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMaterial);
  plane.name = "water-threshold-plane";
  plane.rotation.x = -Math.PI / 2;
  plane.renderOrder = 4;
  root.add(plane);

  const border = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x79e7d4, transparent: true, opacity: 0.58 })
  );
  border.name = "water-plane-linework";
  border.renderOrder = 5;
  root.add(border);

  const stem = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xff69b4, transparent: true, opacity: 0.78 })
  );
  stem.name = "water-z-stem";
  stem.renderOrder = 6;
  root.add(stem);

  const handleMaterial = new THREE.MeshBasicMaterial({
    color: 0xff69b4,
    transparent: true,
    opacity: 0.95
  });
  const handle = new THREE.Mesh(new THREE.SphereGeometry(4.2, 18, 12), handleMaterial);
  handle.name = "water-z-handle";
  handle.renderOrder = 7;
  root.add(handle);

  const arrow = new THREE.Mesh(new THREE.ConeGeometry(3.8, 8.5, 24), handleMaterial.clone());
  arrow.name = "water-z-arrow";
  arrow.renderOrder = 7;
  root.add(arrow);

  const pickTarget = new THREE.Mesh(
    new THREE.CylinderGeometry(18, 18, 34, 18),
    new THREE.MeshBasicMaterial({
      color: 0xff69b4,
      depthWrite: false,
      opacity: 0,
      transparent: true
    })
  );
  pickTarget.name = "water-z-pick-target";
  root.add(pickTarget);

  return {
    arrow,
    border,
    handle,
    pickTarget,
    plane,
    root,
    stem
  };
}

function updateWaterGizmo(runtime, waterLevel = 0, trimWater = false) {
  const gizmo = runtime?.waterGizmo;
  if (!gizmo || !runtime.currentTerrain) {
    if (gizmo) gizmo.root.visible = false;
    return;
  }

  const box = new THREE.Box3().setFromObject(runtime.currentTerrain);
  if (box.isEmpty()) {
    gizmo.root.visible = false;
    return;
  }

  const level = clampWaterLevel(waterLevel);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const minY = box.min.y;
  const maxY = Math.max(box.max.y, minY + 1);
  const waterY = THREE.MathUtils.lerp(minY, maxY, level / WATER_LEVEL_MAX);
  const maxFootprint = Math.max(size.x, size.z, 1);
  const x = box.max.x + Math.max(12, maxFootprint * 0.08);
  const z = center.z;
  const planeWidth = Math.max(size.x * 1.04, 12);
  const planeDepth = Math.max(size.z * 1.04, 12);
  const planeMinX = center.x - planeWidth / 2;
  const planeMaxX = center.x + planeWidth / 2;
  const planeMinZ = center.z - planeDepth / 2;
  const planeMaxZ = center.z + planeDepth / 2;

  gizmo.root.visible = true;
  gizmo.plane.visible = true;
  gizmo.plane.position.set(center.x, waterY, center.z);
  gizmo.plane.scale.set(planeWidth, planeDepth, 1);
  gizmo.plane.material.opacity = trimWater ? 0.12 : 0.045;
  gizmo.border.material.opacity = trimWater ? 0.62 : 0.28;
  gizmo.stem.material.opacity = trimWater ? 0.82 : 0.44;
  gizmo.handle.material.opacity = trimWater ? 0.96 : 0.52;
  gizmo.arrow.material.opacity = trimWater ? 0.96 : 0.52;

  updateLinePositions(gizmo.border.geometry, [
    planeMinX,
    waterY,
    planeMinZ,
    planeMaxX,
    waterY,
    planeMinZ,
    planeMaxX,
    waterY,
    planeMinZ,
    planeMaxX,
    waterY,
    planeMaxZ,
    planeMaxX,
    waterY,
    planeMaxZ,
    planeMinX,
    waterY,
    planeMaxZ,
    planeMinX,
    waterY,
    planeMaxZ,
    planeMinX,
    waterY,
    planeMinZ
  ]);

  const tickWidth = Math.max(5, maxFootprint * 0.025);
  updateLinePositions(gizmo.stem.geometry, [
    x,
    minY,
    z,
    x,
    maxY,
    z,
    x - tickWidth,
    minY,
    z,
    x + tickWidth,
    minY,
    z,
    x - tickWidth,
    maxY,
    z,
    x + tickWidth,
    maxY,
    z
  ]);

  const arrowOffset = Math.max(8, (maxY - minY) * 0.12);
  gizmo.handle.position.set(x, waterY, z);
  gizmo.arrow.position.set(x, Math.min(maxY + arrowOffset * 0.15, waterY + arrowOffset), z);
  gizmo.pickTarget.position.set(x, waterY, z);
  gizmo.pickTarget.scale.setScalar(Math.max(1, maxFootprint / 150));
}

function updateLinePositions(geometry, positions) {
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
}

function createPlaceholderTerrain() {
  const width = 96;
  const height = 96;
  const values = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const wave =
        Math.sin(u * Math.PI * 3.2) * 0.18 +
        Math.cos(v * Math.PI * 4.4) * 0.16 +
        Math.sin((u + v) * Math.PI * 5.6) * 0.12;
      const mound = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 1.28);
      values[y * width + x] = THREE.MathUtils.clamp(0.18 + mound * 0.72 + wave, 0, 1);
    }
  }

  return createTerrainMesh({ width, height, values }, DEFAULT_SETTINGS);
}

const VIEW_DIRECTIONS = {
  iso: new THREE.Vector3(0.95, 0.62, 1.05).normalize(),
  top: new THREE.Vector3(0.01, 1, 0.01).normalize(),
  front: new THREE.Vector3(0, 0.34, 1).normalize()
};

function frameTerrain(runtime, view = "iso") {
  if (!runtime.currentTerrain) return;

  const box = new THREE.Box3().setFromObject(runtime.currentTerrain);
  if (box.isEmpty()) return;

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  const radius = Math.max(size.length() * 0.5, 1);
  const verticalFov = THREE.MathUtils.degToRad(runtime.camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * runtime.camera.aspect);
  const distance =
    Math.max(radius / Math.sin(verticalFov / 2), radius / Math.sin(horizontalFov / 2)) *
    (view === "top" ? 1.15 : 1.05);

  const direction = VIEW_DIRECTIONS[view] ?? VIEW_DIRECTIONS.iso;
  runtime.view = view;
  runtime.camera.near = Math.max(distance / 1200, 0.05);
  runtime.camera.far = Math.max(distance * 8, 1200);
  runtime.camera.position.copy(center).addScaledVector(direction, distance);
  runtime.camera.updateProjectionMatrix();
  runtime.controls.target.copy(center);
  runtime.controls.minDistance = Math.max(radius * 0.04, 1);
  runtime.controls.maxDistance = Math.max(distance * 4, radius * 2);
  runtime.controls.update();
}

function updateBuildPlate(runtime, model) {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return;

  runtime.scene.remove(runtime.grid);
  disposeObject(runtime.grid);

  const size = new THREE.Vector3();
  box.getSize(size);
  const plateSize = Math.max(80, Math.ceil((Math.max(size.x, size.z) * 1.24) / 10) * 10);
  const divisions = Math.min(64, Math.max(8, Math.round(plateSize / 20)));
  runtime.grid = createBuildGrid(plateSize, divisions, runtime.viewerTheme ?? getViewerTheme(false));
  runtime.grid.position.y = -0.05;
  runtime.scene.add(runtime.grid);
}

function getViewerTheme(isLightMode) {
  return isLightMode
    ? {
        background: 0xf0efeb,
        gridMajor: 0xc6c0b6,
        gridMinor: 0xdfdad2,
        low: 0xd3ddd9,
        mid: 0xfffbf0,
        high: 0xd84f94,
        solid: 0xfff8eb,
        solidEdges: 0x7c756c,
        solidEmissive: 0xf6f0e4,
        textureEdges: 0x716b63
      }
    : {
        background: 0x0d0e0d,
        gridMajor: 0x5e645b,
        gridMinor: 0x2b302c,
        low: 0x273936,
        mid: 0xf1ead7,
        high: 0xff7a63,
        solid: 0xf1ead7,
        solidEdges: 0x0a0c0b,
        solidEmissive: 0x17120f,
        textureEdges: 0x10100f
      };
}

function createBuildGrid(size, divisions, theme) {
  return new THREE.GridHelper(size, divisions, theme.gridMajor, theme.gridMinor);
}

function applyViewerTheme(runtime) {
  const theme = runtime.viewerTheme;
  runtime.scene.background = new THREE.Color(theme.background);
  setGridTheme(runtime.grid, theme);

  runtime.currentTerrain?.traverse((child) => {
    if (child.userData.role === "terrainMesh") {
      const usesColorMaterial =
        child.userData.renderMode === "artwork" || child.userData.renderMode === "materials";
      child.material.color.set(usesColorMaterial ? 0xffffff : theme.solid);
      child.material.emissive?.set(usesColorMaterial ? 0x000000 : theme.solidEmissive);
      child.material.needsUpdate = true;
    }

    if (child.userData.role === "terrainEdges") {
      child.material.color.set(
        child.userData.renderMode === "artwork" ? theme.textureEdges : theme.solidEdges
      );
      child.material.needsUpdate = true;
    }
  });
}

function setGridTheme(grid, theme) {
  const materials = Array.isArray(grid?.material) ? grid.material : grid?.material ? [grid.material] : [];
  materials.forEach((material, index) => {
    material.color.set(index === 0 ? theme.gridMajor : theme.gridMinor);
    material.needsUpdate = true;
  });
}

function writePreviewColors(colors, positions, uvs, stats, theme, materialPlan) {
  const low = new THREE.Color(theme.low);
  const mid = new THREE.Color(theme.mid);
  const high = new THREE.Color(theme.high);
  const minHeight = Math.max(stats.minHeightMm, 0.001);
  const span = Math.max(stats.maxHeightMm - minHeight, 0.001);
  const materialBandColors =
    materialPlan?.mode === "flare-colors"
      ? materialPlan.bands.map((band) => new THREE.Color(band.color))
      : null;

  for (let i = 0; i < positions.length; i += 3) {
    const height = positions[i + 1];
    const t = THREE.MathUtils.clamp((height - minHeight) / span, 0, 1);
    if (materialBandColors) {
      const uvIndex = (i / 3) * 2;
      const mappedIndex = sampleMaterialPlanIndex(
        materialPlan,
        uvs?.[uvIndex] ?? 0.5,
        uvs?.[uvIndex + 1] ?? 0.5
      );
      const bandIndex =
        mappedIndex ??
        Math.min(materialBandColors.length - 1, Math.floor(t * materialBandColors.length));
      const color = materialBandColors[bandIndex];
      colors[i] = color.r;
      colors[i + 1] = color.g;
      colors[i + 2] = color.b;
      continue;
    }

    const color = height <= 0.001 ? low : low.clone().lerp(mid, Math.min(t * 1.55, 1));
    if (t > 0.72) {
      color.lerp(high, (t - 0.72) / 0.28);
    }
    colors[i] = color.r;
    colors[i + 1] = color.g;
    colors[i + 2] = color.b;
  }
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : child.material
        ? [child.material]
        : [];

    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value?.isTexture) value.dispose();
      });
      material.dispose?.();
    });
  });
}

function HeightmapPreview({ heightMap }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !heightMap) return;
    const ctx = canvas.getContext("2d");
    canvas.width = heightMap.width;
    canvas.height = heightMap.height;
    const data = ctx.createImageData(heightMap.width, heightMap.height);

    for (let i = 0; i < heightMap.values.length; i += 1) {
      const value = Math.round(heightMap.values[i] * 255);
      data.data[i * 4] = value;
      data.data[i * 4 + 1] = value;
      data.data[i * 4 + 2] = value;
      data.data[i * 4 + 3] = 255;
    }

    ctx.putImageData(data, 0, 0);
  }, [heightMap]);

  return (
    <div className="heightmap-box">
      <canvas aria-label="Generated actual FLARES displacement map" ref={canvasRef} />
    </div>
  );
}

function NumberInput({ label, max, min, onChange, step = 1, value }) {
  return (
    <label className="number-input">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function useMobileWizard() {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 760px)").matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return matches;
}

function normalizeCollectionFlare(flare) {
  const inscriptionId = flare.id;
  const attributes = flare.meta?.attributes ?? [];
  const sampleSeedIndex = SAMPLE_SEEDS.get(inscriptionId);

  return {
    name: flare.meta?.name ?? inscriptionId,
    type:
      attributes.find((attribute) => normalize(attribute.trait_type) === "type of flare")
        ?.value ?? "FLARE",
    inscriptionId,
    seedIndex: Number.isFinite(sampleSeedIndex) ? sampleSeedIndex : undefined,
    image: flare.meta?.collection_page_img_url,
    thumb: flare.meta?.thumbnail_url ?? flare.meta?.collection_page_img_url
  };
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function roundMm(value) {
  return Math.round(value * 10) / 10;
}

function estimatePlaceholderPrice(settings, materialPlan) {
  const areaFactor = (settings.widthMm * settings.depthMm) / 1000;
  const heightFactor = settings.reliefHeightMm * 1.7;
  const materialFactor = materialPlan.mode === "flare-colors" ? 90 : 35;
  return Math.round(95 + areaFactor + heightFactor + materialFactor);
}

function clampWaterLevel(value) {
  return Math.round(THREE.MathUtils.clamp(Number(value) || 0, WATER_LEVEL_MIN, WATER_LEVEL_MAX) * 100) / 100;
}

function hexToRgb(hex) {
  const value = String(hex).replace("#", "");
  return {
    b: Number.parseInt(value.slice(4, 6), 16) || 0,
    g: Number.parseInt(value.slice(2, 4), 16) || 0,
    r: Number.parseInt(value.slice(0, 2), 16) || 0
  };
}

function cssImageUrl(value) {
  return `url("${String(value).replace(/"/g, "%22")}")`;
}

export default App;
