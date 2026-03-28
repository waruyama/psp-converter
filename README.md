# psp-converter

Converts Paint Shop Pro (.psp / .pspimage) files to SVG.

If you have old PSP files from the late 90s or early 2000s and want to turn them into modern, scalable SVGs -- this tool does that. It handles vector layers (paths, shapes, gradients) and raster layers (embedded as PNGs inside the SVG).

## Examples

Here are a few conversions from PSP to SVG, rendered as PNG previews:

| astrologer | fish | flag_brazil | fingerprint | message |
|-----------|------|-------------|-------------|---------|
| ![astrologer](png-output/astrologer.png) | ![fish](png-output/fish.png) | ![flag_brazil](png-output/flag_brazil.png) | ![fingerprint](png-output/fingerprint.png) | ![message](png-output/message.png) |

## Installation

```bash
git clone https://github.com/waruyama/psp-converter.git
cd psp-converter
npm install
```

The only dependency is `@resvg/resvg-js`, which is used solely for the optional PNG preview rendering. The core PSP-to-SVG conversion has zero dependencies.

## Usage

**Convert a single file (output to stdout):**

```bash
node index.js input.psp
```

**Convert a single file to SVG:**

```bash
node index.js input.psp output.svg
```

**Batch-convert a directory:**

```bash
node index.js input-dir/ output-dir/
```

**Batch-convert with PNG previews:**

```bash
node index.js input-dir/ output-dir/ preview-dir/
```

**Skip raster layers (vector only):**

```bash
node index.js --vectors-only input.psp output.svg
```

## What it supports

- Vector layers with bezier paths (polylines, ellipses, polygons)
- Groups
- Solid color fills and strokes
- Linear, radial, and sunburst gradients (with transparency stops)
- Stroke width, line join, line cap, miter limit
- Raster/bitmap layers (embedded as base64 PNG in the SVG)
- Layer opacity and visibility
- PSP format versions 5 and 7

## Known limitations

- **JPEG-compressed PSP files** are not supported (will produce an error).
- **Pattern and paper paint styles** are ignored -- only solid color and gradient fills/strokes are converted.
- **Rectangular gradients** are approximated as radial gradients in SVG.
- **Palette-based images** (1-bit, 4-bit) may not render correctly.
- **Text layers** are not supported. PSP stores text as vector outlines in some cases, which will convert fine, but native text objects are skipped.
- **Dash patterns** (styled lines) are parsed but not yet emitted in the SVG output.

## Programmatic use

```javascript
const { parsePSP, generateSVG, convertFile } = require('./index');

// Parse and generate SVG string
const fs = require('fs');
const buffer = fs.readFileSync('input.psp');
const pspData = parsePSP(buffer);
const svg = generateSVG(pspData);

// Or convert directly to file
convertFile('input.psp', 'output.svg');

// Vector layers only
convertFile('input.psp', 'output.svg', { vectorsOnly: true });
```

## License

MIT
