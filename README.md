# physicalflare

`physicalflare` is a browser tool for turning actual FLARES on-chain terrain into sealed, millimeter-scale STL files for FDM 3D printing.

## Why this shape

The FLARES Ordinals are recursive on-chain artworks. A sampled inscription wrapper loads a shared script, injects a piece payload, and boots a compressed Three.js scene using `seedIndex`, live block height, water maps, and seeded terrain parameters.

For fabrication, this project now runs that actual FLARES Three.js engine in a hidden browser frame, keeps the engine's compute buffers alive, and samples the final blurred displacement render target.

That shader terrain is not treated as a perfect one-click STL. It is treated as source material for a physical interpretation layer: the raw on-chain displacement field can be curved, smoothed, ridged, terraced, etched, or otherwise transformed before the watertight STL is built. The image thumbnail is only a visual reference/material in the preview, not the source of geometry.

## Model generation lab

The clear extension point is:

```txt
src/lib/flareLandscapeGenerator.js
```

That file is intentionally marked `PHYSICALFLARE MODEL GENERATION LAB`. It is where new code should be added when someone wants to learn from the FLARES shader/top-down terrain and invent a better physical translation.

Current modes:

- `Shader Topology`: close to the sampled on-chain displacement.
- `Solar Ridges`: amplifies gradient lines from the FLARES surface.
- `Topographic Terraces`: turns elevation into contour shelves.
- `Flare Islands`: creates a stronger archipelago-like physical object and enables waterline trimming by default.
- `Etched Field`: lowers broad terrain and pulls shader edges into relief.

The generator can also return `trimMask` and `cellMask` data. When `Island trim` is enabled, `waterLevel` removes the flat flooded field, rescales the dry relief above that level, and asks `terrainMesh.js` to build only the island footprint with sealed coastline walls.

To add a new generator:

1. Add a preset to `LANDSCAPE_PRESETS`.
2. Add a branch in `applyLandscapeMode()`.
3. Keep output values normalized to `0..1`.
4. Optionally return `trimMask` / `cellMask` when the model should stop being rectangular.
5. `terrainMesh.js` will seal the result into a printable STL.

## Features

- Browser-only actual FLARES terrain pipeline.
- Full collection picker backed by `flares.json`, with type filtering, search, and progressive loading for the 512-piece set.
- Source artwork preview can switch between the original FLARE and the extracted four-material color map.
- Seed resolution from the live Ordinals inscription wrapper when needed.
- Sealed binary STL export in millimeters.
- User-selectable Bitcoin block height for deterministic physical editions.
- Water level island trimming for printable archipelago editions.
- Printer fit checks for:
  - Gigastorm: 800 x 800 x 1000 mm, using the limit provided for this project.
  - Snapmaker U1: 270 x 270 x 270 mm, four material slots, 0.4 mm nozzle, 300 C nozzle, and 100 C bed.
  - Prusa CORE One: 250 x 220 x 270 mm, per Prusa's launch article.
  - Prusa CORE One L / Plus: 300 x 300 x 330 mm editable preset for the larger Core One class.
- Material planning:
  - One material: current STL export path.
  - Four FLARE colors: extracts a four-color palette and indexed color map from the selected artwork.
  - Four aligned STL export: one STL body per FLARE color, ready to assign to T1-T4 in a multi-material slicer.
- Local sample FLARES #12, #95, and #363.

## Run

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Notes for printing

The exported STL is a watertight heightfield: a terrain top, flat bottom, and perimeter walls. In island mode, the rectangular flooded field is removed and each kept footprint is sealed with coastline walls. The model is Z-up, measured in millimeters, and intended to be sliced with a normal FDM workflow. Use the fit warnings as first-pass checks, then validate wall thickness, layer height, and estimated print time in PrusaSlicer, Snapmaker Orca, or the Gigastorm slicing workflow before production.

For Snapmaker U1-style multi-material terrain, the app extracts four colors from the selected FLARE and can export four aligned STL bodies split by the artwork's color regions. STL still does not carry material assignments by itself, so assign the exported T1-T4 parts to matching materials in Snapmaker Orca. A future production path can package the same material map as one 3MF with material metadata. The extension points are `src/lib/flarePalette.js` and `src/lib/materialPlans.js`.

Prusa CORE One volume reference: https://blog.prusa3d.com/introducing-prusa-core-one-fully-enclosed-corexy-3d-printer-with-active-temperature-control_105477/
Snapmaker U1 reference: https://www.techradar.com/pro/snapmaker-u1-3d-printer-review
