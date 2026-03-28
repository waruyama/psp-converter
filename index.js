// PSP to SVG converter
// Parses Paint Shop Pro (.psp / .pspimage) files and converts vector layers
// to SVG paths with gradients, and raster layers to embedded PNG images.
// Supports PSP format versions 5 and 7 (major versions 3-5+).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- PSP Block IDs (PSPBlockID enum) ---
const PSP_IMAGE_BLOCK = 0;
const PSP_LAYER_START_BLOCK = 3;
const PSP_LAYER_BLOCK = 4;
const PSP_CHANNEL_BLOCK = 5;
const PSP_VECTOR_EXTENSION_BLOCK = 13;
const PSP_SHAPE_BLOCK = 14;
const PSP_PAINTSTYLE_BLOCK = 15;
const PSP_LINESTYLE_BLOCK = 19;

// --- Layer types (PSPLayerType enum) ---
const keGLTRaster = 1;
const keGLTVector = 3;

// --- Compression types (PSPCompression enum) ---
// Set per-image in the General Image Attributes block; applies to all channels.
const PSP_COMP_NONE = 0;
const PSP_COMP_RLE = 1;
const PSP_COMP_LZ77 = 2;

// --- Channel types (PSPChannelType enum) ---
// Each channel stores one plane of pixel data (8-bit per pixel).
const PSP_CHANNEL_COMPOSITE = 0;
const PSP_CHANNEL_RED = 1;
const PSP_CHANNEL_GREEN = 2;
const PSP_CHANNEL_BLUE = 3;

// --- Bitmap (DIB) types (PSPDIBType enum) ---
// Distinguishes layer color data from transparency masks.
const PSP_DIB_IMAGE = 0;
const PSP_DIB_TRANS_MASK = 1;

// --- Shape types (PSPVectorShapeType enum) ---
// Ellipses and polygons are stored as polyline node data (bezier curves).
const keVSTPolyline = 2;
const keVSTEllipse = 3;
const keVSTPolygon = 4;
const keVSTGroup = 5;

// --- Paint style type flags (PSPStyleType enum) ---
// Indicate which definition chunks follow the Paint Style Information Chunk.
const keStyleColor = 0x0001;
const keStyleGradient = 0x0002;

// --- Polyline node flags (PSPPolylineNodeTypes enum) ---
const keNodeClosed = 0x0080;

// --- Shape property flags ---
const keShapeVisible = 0x0004;

// --- Layer property flags ---
const keVisibleFlag = 0x00000001;

// --- SVG join/cap mappings ---
const JOIN_MAP = ['miter', 'round', 'bevel'];
const CAP_MAP = ['butt', 'round', 'square'];

// --- Gradient types (PSPStyleGradientType enum) ---
const GRAD_LINEAR = 0;
const GRAD_RADIAL = 1;
const GRAD_RECTANGULAR = 2; // approximated as radial in SVG output
const GRAD_SUNBURST = 3;

// ============================================================
// Buffer Reader — sequential reader for the little-endian PSP binary format
// ============================================================
class BufferReader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.pos = offset;
  }

  readUInt8() {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  readUInt16LE() {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readUInt32LE() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readInt32LE() {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readDoubleLE() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  readBytes(n) {
    const v = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  readVarString() {
    const len = this.readUInt16LE();
    const str = this.buf.slice(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    return str;
  }

  seek(pos) {
    this.pos = pos;
  }

  // Every PSP block starts with the 4-byte marker "~BK\0" (0x7E 0x42 0x4B 0x00).
  isBlockHeader() {
    return this.pos + 10 <= this.buf.length &&
      this.buf[this.pos] === 0x7E &&
      this.buf[this.pos + 1] === 0x42 &&
      this.buf[this.pos + 2] === 0x4B &&
      this.buf[this.pos + 3] === 0x00;
  }

  // Block header layout: 4-byte marker + WORD blockId + DWORD totalLength.
  // totalLength covers everything after the 10-byte header.
  readBlockHeader() {
    if (!this.isBlockHeader()) return null;
    this.pos += 4;
    const blockId = this.readUInt16LE();
    const totalLength = this.readUInt32LE();
    return { blockId, totalLength, dataOffset: this.pos };
  }

  // Scan forward for the next block header within a bounded region.
  nextBlock(end) {
    while (this.pos < end - 10) {
      if (this.isBlockHeader()) return this.readBlockHeader();
      this.pos++;
    }
    return null;
  }
}

// ============================================================
// PSP Parser
// ============================================================

// Top-level parser. Reads the file header (32-byte signature + version),
// then iterates over main blocks to find image attributes and layers.
function parsePSP(buffer) {
  const r = new BufferReader(buffer);

  const signature = r.readBytes(32).toString('ascii');
  if (!signature.startsWith('Paint Shop Pro Image File')) {
    throw new Error('Not a valid PSP file');
  }
  const majorVersion = r.readUInt16LE();
  r.readUInt16LE(); // minorVersion

  let imageAttrs = null;
  const layers = [];

  let block;
  while ((block = r.nextBlock(buffer.length))) {
    const blockEnd = block.dataOffset + block.totalLength;

    switch (block.blockId) {
      case PSP_IMAGE_BLOCK:
        imageAttrs = parseImageAttributes(r, majorVersion);
        break;
      case PSP_LAYER_START_BLOCK:
        parseLayerBank(r, block, layers, majorVersion, imageAttrs);
        break;
    }

    r.seek(blockEnd);
  }

  if (!imageAttrs) throw new Error('No image attributes block found');

  // Backwards compatibility: also expose vectorLayers
  const vectorLayers = layers.filter(l => l.kind === 'vector');
  return { imageAttrs, layers, vectorLayers, majorVersion };
}

// General Image Attributes Chunk — image dimensions, compression, and bit depth.
function parseImageAttributes(r, majorVersion) {
  const chunkStart = r.pos;
  const chunkSize = r.readUInt32LE();
  const width = r.readInt32LE();
  const height = r.readInt32LE();
  r.readDoubleLE(); // resolution
  r.readUInt8();    // resMetric
  const compression = r.readUInt16LE();
  const bitDepth = r.readUInt16LE();
  r.seek(chunkStart + chunkSize);
  return { width, height, compression, bitDepth };
}

// The Layer Bank (PSP_LAYER_START_BLOCK) contains one or more Layer Blocks.
// Each Layer Block holds a Layer Attributes Chunk followed by type-specific
// sub-blocks: channel data for raster layers, vector extension for vector layers.
function parseLayerBank(r, block, layers, majorVersion, imageAttrs) {
  const bankEnd = block.dataOffset + block.totalLength;

  let layerBlock;
  while ((layerBlock = r.nextBlock(bankEnd))) {
    if (layerBlock.blockId !== PSP_LAYER_BLOCK) {
      r.seek(layerBlock.dataOffset + layerBlock.totalLength);
      continue;
    }

    const layerEnd = layerBlock.dataOffset + layerBlock.totalLength;
    const layer = parseLayerInfo(r);

    if (layer.type === keGLTVector) {
      let subBlock;
      while ((subBlock = r.nextBlock(layerEnd))) {
        if (subBlock.blockId === PSP_VECTOR_EXTENSION_BLOCK) {
          const shapes = parseVectorExtension(r, subBlock, majorVersion);
          layers.push({
            kind: 'vector',
            name: layer.name,
            opacity: layer.opacity,
            visible: layer.visible,
            shapes,
          });
          r.seek(subBlock.dataOffset + subBlock.totalLength);
          break;
        }
        r.seek(subBlock.dataOffset + subBlock.totalLength);
      }
    } else if (layer.type === keGLTRaster) {
      const rasterLayer = parseRasterLayerData(r, layerEnd, layer, imageAttrs);
      if (rasterLayer) {
        layers.push(rasterLayer);
      }
    }

    r.seek(layerEnd);
  }
}

// Layer Attributes Information Chunk — layer name, type, two bounding rects,
// opacity, blend mode, and visibility flag. PSP stores two rects per layer:
// "image rect" (logical extent) and "saved rect" (actual pixel data extent).
function parseLayerInfo(r) {
  const chunkStart = r.pos;
  const chunkSize = r.readUInt32LE();
  const name = r.readVarString();
  const type = r.readUInt8();
  // Image rect: left, top, right, bottom (Win32 RECT)
  const imgLeft = r.readInt32LE();
  const imgTop = r.readInt32LE();
  const imgRight = r.readInt32LE();
  const imgBottom = r.readInt32LE();
  // Saved image rect
  const savedLeft = r.readInt32LE();
  const savedTop = r.readInt32LE();
  const savedRight = r.readInt32LE();
  const savedBottom = r.readInt32LE();
  const opacity = r.readUInt8();
  r.readUInt8(); // blendMode
  const layerFlags = r.readUInt8();
  const visible = !!(layerFlags & keVisibleFlag);
  r.seek(chunkStart + chunkSize);

  const imgWidth = imgRight - imgLeft;
  const imgHeight = imgBottom - imgTop;
  const savedWidth = savedRight - savedLeft;
  const savedHeight = savedBottom - savedTop;
  return { name, type, opacity, visible, imgLeft, imgTop, imgWidth, imgHeight, savedLeft, savedTop, savedWidth, savedHeight };
}

// Vector Extension Block — contains a flat list of Shape Blocks.
// PSP stores group children both nested inside the group AND as flattened
// copies after it; skipCount prevents double-processing the flattened ones.
function parseVectorExtension(r, block, majorVersion) {
  const chunkStart = r.pos;
  const chunkSize = r.readUInt32LE();
  r.readUInt32LE(); // shapeCount
  r.seek(chunkStart + chunkSize);

  const shapes = [];
  const blockEnd = block.dataOffset + block.totalLength;
  let skipCount = 0;
  let shapeBlock;
  while ((shapeBlock = r.nextBlock(blockEnd))) {
    if (shapeBlock.blockId === PSP_SHAPE_BLOCK) {
      if (skipCount > 0) {
        // Skip flattened copies of group children that PSP stores after the group
        skipCount--;
      } else {
        const shape = parseShape(r, shapeBlock, majorVersion);
        if (shape) {
          shapes.push(shape);
          if (shape.type === 'group') {
            skipCount = shape.children.length;
          }
        }
      }
    }
    r.seek(shapeBlock.dataOffset + shapeBlock.totalLength);
  }

  return shapes;
}

// Shape Attributes Chunk — reads name, type, flags, then dispatches to
// the appropriate shape parser (group or polyline/ellipse/polygon).
function parseShape(r, block, majorVersion) {
  const attrStart = r.pos;
  const attrChunkSize = r.readUInt32LE();
  const shapeName = r.readVarString();
  const shapeType = r.readUInt16LE();
  const shapeFlags = r.readUInt32LE();
  r.readUInt32LE(); // shapeId
  r.seek(attrStart + attrChunkSize);

  const visible = !!(shapeFlags & keShapeVisible);

  if (shapeType === keVSTGroup) {
    return parseGroupShape(r, shapeName, visible, majorVersion);
  }

  if (shapeType === keVSTPolyline || shapeType === keVSTEllipse || shapeType === keVSTPolygon) {
    return parsePolylineShape(r, shapeName, shapeType, visible, majorVersion);
  }

  return null;
}

function parseGroupShape(r, name, visible, majorVersion) {
  const chunkStart = r.pos;
  const chunkSize = r.readUInt32LE();
  const subShapeCount = r.readUInt32LE();
  r.seek(chunkStart + chunkSize);

  const children = [];
  for (let i = 0; i < subShapeCount; i++) {
    if (!r.isBlockHeader()) break;
    const subBlock = r.readBlockHeader();
    if (subBlock.blockId === PSP_SHAPE_BLOCK) {
      const child = parseShape(r, subBlock, majorVersion);
      if (child) children.push(child);
    }
    r.seek(subBlock.dataOffset + subBlock.totalLength);
  }

  return { type: 'group', name, visible, children };
}

// Polyline Shape — the main vector shape type. The binary layout is:
//   1. Polyline Attributes Chunk (stroke/fill flags, line width, cap/join)
//   2. Paint Style Sub-Block for stroke
//   3. Paint Style Sub-Block for fill
//   4. Line Style Sub-Block (dash patterns, skipped here)
//   5. Polyline Definition Chunk (node count)
//   6. Sequence of Node Chunks (anchor point, two bezier handles, flags)
function parsePolylineShape(r, name, shapeType, visible, majorVersion) {
  const polyStart = r.pos;
  const polyChunkSize = r.readUInt32LE();
  const stroked = !!r.readUInt8();
  const filled = !!r.readUInt8();
  r.readUInt8(); // styledLine
  const strokeWidth = majorVersion <= 5 ? r.readUInt16LE() : r.readDoubleLE();
  const startCapType = r.readUInt8();
  r.readUInt8(); // start cap multipliers flag
  r.readDoubleLE(); // start cap width mult
  r.readDoubleLE(); // start cap height mult
  r.readUInt8(); // endCapType
  r.readUInt8(); // end cap multipliers flag
  r.readDoubleLE(); // end cap width mult
  r.readDoubleLE(); // end cap height mult
  const joinType = r.readUInt8();
  const miterLimit = r.readDoubleLE();
  r.seek(polyStart + polyChunkSize);

  // Paint Style Sub-Block 1 (stroke)
  let strokeStyle = null;
  if (r.isBlockHeader() && r.buf.readUInt16LE(r.pos + 4) === PSP_PAINTSTYLE_BLOCK) {
    strokeStyle = parsePaintStyle(r, majorVersion);
  }

  // Paint Style Sub-Block 2 (fill)
  let fillStyle = null;
  if (r.isBlockHeader() && r.buf.readUInt16LE(r.pos + 4) === PSP_PAINTSTYLE_BLOCK) {
    fillStyle = parsePaintStyle(r, majorVersion);
  }

  // Line Style Sub-Block (skip)
  if (r.isBlockHeader() && r.buf.readUInt16LE(r.pos + 4) === PSP_LINESTYLE_BLOCK) {
    const lsBlock = r.readBlockHeader();
    r.seek(lsBlock.dataOffset + lsBlock.totalLength);
  }

  // Polyline Shape Definition Chunk
  const defStart = r.pos;
  const defChunkSize = r.readUInt32LE();
  r.readUInt32LE(); // nodeCount read from chunk
  r.seek(defStart + defChunkSize);

  // Read nodes
  const nodes = [];
  while (r.isBlockHeader() === false && r.pos < r.buf.length - 4) {
    const nodeStart = r.pos;
    const nodeChunkSize = r.readUInt32LE();
    if (nodeChunkSize < 55 || nodeStart + nodeChunkSize > r.buf.length) {
      r.seek(nodeStart);
      break;
    }
    const px = r.readDoubleLE();
    const py = r.readDoubleLE();
    const h1x = r.readDoubleLE();
    const h1y = r.readDoubleLE();
    const h2x = r.readDoubleLE();
    const h2y = r.readDoubleLE();
    const moveTo = !!r.readUInt8();
    const nodeFlags = r.readUInt16LE();
    r.seek(nodeStart + nodeChunkSize);
    nodes.push({ px, py, h1x, h1y, h2x, h2y, moveTo, nodeFlags });
  }

  return {
    type: 'polyline',
    name,
    visible,
    stroked,
    filled,
    strokeWidth,
    strokeStyle,
    fillStyle,
    joinType: JOIN_MAP[joinType] || 'miter',
    capType: CAP_MAP[startCapType] || 'butt',
    miterLimit,
    nodes,
    closed: shapeType === keVSTPolygon || shapeType === keVSTEllipse,
  };
}

// ============================================================
// Paint Style Parsing
// ============================================================

// Paint Style Sub-Block — describes how a stroke or fill is painted.
// Layout: Block Header, Information Chunk (with style type flags),
// then definition chunks for each active type (color, gradient, pattern, etc.).
// We only handle color and gradient; pattern/paper/pen are ignored.
function parsePaintStyle(r, majorVersion) {
  const psBlock = r.readBlockHeader();
  const psEnd = psBlock.dataOffset + psBlock.totalLength;

  // Paint Style Information Chunk
  const infoStart = r.pos;
  const infoChunkSize = r.readUInt32LE();
  const styleFlags = r.readUInt16LE();
  r.seek(infoStart + infoChunkSize);

  const style = { type: 'none', color: null, gradient: null };

  // Color chunk
  if (styleFlags & keStyleColor) {
    const colorStart = r.pos;
    const colorChunkSize = r.readUInt32LE();
    const rgb = r.readUInt32LE();
    style.color = {
      r: rgb & 0xFF,
      g: (rgb >> 8) & 0xFF,
      b: (rgb >> 16) & 0xFF,
    };
    style.type = 'color';
    r.seek(colorStart + colorChunkSize);
  }

  // Gradient chunk — center/focal as percentages (0-10000 = 0-100%),
  // color stops with RGB + position, transparency stops with opacity + position.
  // Locations and midpoints are stored as 0-10000 values (divided by 100 below).
  if (styleFlags & keStyleGradient) {
    const gradStart = r.pos;
    const gradChunkSize = r.readUInt32LE();
    const gradName = r.readVarString();
    r.readInt32LE(); // gradId
    const invert = !!r.readUInt8();
    const centerH = r.readInt32LE();
    const centerV = r.readInt32LE();
    // v5 has no focal point fields
    let focalH = centerH, focalV = centerV;
    if (majorVersion > 5) {
      focalH = r.readInt32LE();
      focalV = r.readInt32LE();
    }
    const angle = r.readDoubleLE();
    const repeats = r.readUInt16LE();
    const gradType = r.readUInt16LE();
    const colorCount = r.readUInt16LE();
    const transCount = r.readUInt16LE();
    r.seek(gradStart + gradChunkSize); // skip expansion

    // Read color stops
    const colorStops = [];
    for (let c = 0; c < colorCount; c++) {
      const csStart = r.pos;
      const csSize = r.readUInt32LE();
      const rgb = r.readUInt32LE();
      const loc = r.readUInt16LE();
      const mid = r.readUInt16LE();
      colorStops.push({
        r: rgb & 0xFF,
        g: (rgb >> 8) & 0xFF,
        b: (rgb >> 16) & 0xFF,
        location: loc / 100,
        midpoint: mid / 100,
      });
      r.seek(csStart + csSize);
    }

    // Read transparency stops
    const transStops = [];
    for (let t = 0; t < transCount; t++) {
      const tsStart = r.pos;
      const tsSize = r.readUInt32LE();
      // v5: opacity is BYTE; v7: opacity is WORD
      const opacity = majorVersion <= 5 ? r.readUInt8() : r.readUInt16LE();
      const loc = r.readUInt16LE();
      const mid = r.readUInt16LE();
      transStops.push({
        opacity: opacity / 100,
        location: loc / 100,
        midpoint: mid / 100,
      });
      r.seek(tsStart + tsSize);
    }

    style.gradient = {
      name: gradName,
      invert,
      centerH: centerH / 100,
      centerV: centerV / 100,
      focalH: focalH / 100,
      focalV: focalV / 100,
      angle,
      repeats,
      gradType,
      colorStops,
      transStops,
    };
    style.type = 'gradient';
  }

  r.seek(psEnd);
  return style;
}

// ============================================================
// Raster Layer Parsing
// ============================================================

// Reads channel sub-blocks (R, G, B, composite, alpha) and assembles them
// into an RGBA pixel buffer. Each channel is independently compressed.
function parseRasterLayerData(r, layerEnd, layer, imageAttrs) {
  // Use saved rect for actual pixel dimensions; image rect is the logical extent
  const w = layer.savedWidth;
  const h = layer.savedHeight;
  if (w <= 0 || h <= 0) return null;

  // Bitmap info chunk: chunkSize, bitmapCount, channelCount
  const bmpChunkStart = r.pos;
  const bmpChunkSize = r.readUInt32LE();
  r.seek(bmpChunkStart + bmpChunkSize);

  // Read channel sub-blocks
  const colorChannels = {}; // channelType -> decompressed Buffer
  let alphaChan = null;

  let chanBlock;
  while ((chanBlock = r.nextBlock(layerEnd))) {
    if (chanBlock.blockId !== PSP_CHANNEL_BLOCK) {
      r.seek(chanBlock.dataOffset + chanBlock.totalLength);
      continue;
    }

    const chanInfoStart = r.pos;
    const chanChunkSize = r.readUInt32LE();
    const compLen = r.readUInt32LE();
    r.readUInt32LE(); // uncompLen (unreliable in some versions)
    const bitmapType = r.readUInt16LE();
    const channelType = r.readUInt16LE();
    r.seek(chanInfoStart + chanChunkSize);

    if (compLen === 0) {
      r.seek(chanBlock.dataOffset + chanBlock.totalLength);
      continue;
    }
    const compData = r.readBytes(compLen);
    const pixels = decompressChannel(compData, imageAttrs.compression, w, h);

    if (bitmapType === PSP_DIB_IMAGE) {
      colorChannels[channelType] = pixels;
    } else if (bitmapType === PSP_DIB_TRANS_MASK) {
      alphaChan = pixels;
    }

    r.seek(chanBlock.dataOffset + chanBlock.totalLength);
  }

  // Combine channels into RGBA
  const pixelCount = w * h;
  const rgba = Buffer.alloc(pixelCount * 4);

  const rChan = colorChannels[PSP_CHANNEL_RED];
  const gChan = colorChannels[PSP_CHANNEL_GREEN];
  const bChan = colorChannels[PSP_CHANNEL_BLUE];
  const compChan = colorChannels[PSP_CHANNEL_COMPOSITE];
  const hasRGB = rChan && gChan && bChan;

  if (hasRGB) {
    for (let i = 0; i < pixelCount; i++) {
      rgba[i * 4] = rChan[i];
      rgba[i * 4 + 1] = gChan[i];
      rgba[i * 4 + 2] = bChan[i];
      rgba[i * 4 + 3] = alphaChan ? alphaChan[i] : 255;
    }
  } else if (compChan) {
    for (let i = 0; i < pixelCount; i++) {
      rgba[i * 4] = compChan[i];
      rgba[i * 4 + 1] = compChan[i];
      rgba[i * 4 + 2] = compChan[i];
      rgba[i * 4 + 3] = alphaChan ? alphaChan[i] : 255;
    }
  }

  return {
    kind: 'raster',
    name: layer.name,
    opacity: layer.opacity,
    visible: layer.visible,
    x: layer.imgLeft + layer.savedLeft,
    y: layer.imgTop + layer.savedTop,
    width: w,
    height: h,
    rgba,
  };
}

function decompressChannel(compData, compression, width, height) {
  const expectedSize = width * height;
  if (compression === PSP_COMP_LZ77) {
    return zlib.inflateSync(compData);
  } else if (compression === PSP_COMP_NONE) {
    return compData;
  } else if (compression === PSP_COMP_RLE) {
    return decompressRLE(compData, expectedSize);
  }
  throw new Error(`Unsupported compression type: ${compression}`);
}

// PSP uses PackBits-style RLE: byte > 128 means repeat next byte (257-count)
// times; byte < 128 means (count+1) literal bytes; 128 is a no-op.
function decompressRLE(compData, expectedSize) {
  const out = Buffer.alloc(expectedSize);
  let srcPos = 0;
  let dstPos = 0;
  while (srcPos < compData.length && dstPos < expectedSize) {
    const count = compData[srcPos++];
    if (count > 128) {
      // Repeat next byte (257 - count) times
      const val = compData[srcPos++];
      const repeat = 257 - count;
      for (let i = 0; i < repeat && dstPos < expectedSize; i++) {
        out[dstPos++] = val;
      }
    } else if (count < 128) {
      // Literal run of (count + 1) bytes
      const len = count + 1;
      for (let i = 0; i < len && dstPos < expectedSize; i++) {
        out[dstPos++] = compData[srcPos++];
      }
    }
    // count === 128: no-op
  }
  return out;
}

// ============================================================
// Minimal PNG Encoder (RGBA)
// Zero-dependency encoder for embedding raster layers as data URIs in SVG.
// Produces valid PNG with a single unfiltered IDAT chunk (no optimization).
// ============================================================
function encodePNG(rgba, width, height) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = pngChunk('IHDR', ihdr);

  // IDAT chunk: add filter byte (0 = None) before each row, then zlib compress
  const rowLen = width * 4;
  const filtered = Buffer.alloc(height * (1 + rowLen));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + rowLen)] = 0; // filter type: None
    rgba.copy(filtered, y * (1 + rowLen) + 1, y * rowLen, (y + 1) * rowLen);
  }
  const compressed = zlib.deflateSync(filtered);
  const idatChunk = pngChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData) >>> 0, 0);
  return Buffer.concat([len, typeB, data, crc]);
}

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32.table[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32.table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================
// Gradient Stop Merging
// PSP stores color stops and transparency stops as separate arrays.
// SVG needs a single array of stops with both color and opacity.
// These functions merge the two by interpolating at every unique position.
// ============================================================

// Generic interpolation over a sorted array of stops.
// extract(stop) returns the value at a stop; extract(a, b, t) interpolates.
function lerpStops(pos, stops, defaultVal, extract) {
  if (stops.length === 0) return defaultVal;
  if (pos <= stops[0].location) return extract(stops[0]);
  if (pos >= stops[stops.length - 1].location) return extract(stops[stops.length - 1]);

  for (let i = 0; i < stops.length - 1; i++) {
    if (pos >= stops[i].location && pos <= stops[i + 1].location) {
      const range = stops[i + 1].location - stops[i].location;
      if (range === 0) return extract(stops[i]);
      const t = (pos - stops[i].location) / range;
      return extract(stops[i], stops[i + 1], t);
    }
  }
  return extract(stops[stops.length - 1]);
}

function interpolateColorAt(pos, stops) {
  return lerpStops(pos, stops, { r: 0, g: 0, b: 0 }, (a, b, t) => {
    if (t === undefined) return a;
    return {
      r: Math.round(a.r + t * (b.r - a.r)),
      g: Math.round(a.g + t * (b.g - a.g)),
      b: Math.round(a.b + t * (b.b - a.b)),
    };
  });
}

function interpolateOpacityAt(pos, stops) {
  return lerpStops(pos, stops, 1, (a, b, t) => {
    if (t === undefined) return a.opacity;
    return a.opacity + t * (b.opacity - a.opacity);
  });
}

function dedupByLocation(stops) {
  const seen = new Set();
  return stops.filter(s => {
    if (seen.has(s.location)) return false;
    seen.add(s.location);
    return true;
  });
}

// Merge color and transparency stop arrays into unified SVG-ready stops.
function mergeGradientStops(gradient) {
  // Deduplicate stops at the same position — keep first occurrence.
  // PSP stores an extra stop at the end position to start a "next segment"
  // that doesn't exist; using it would pick the wrong color.
  const colorStops = dedupByLocation(gradient.colorStops);
  const transStops = dedupByLocation(gradient.transStops);

  // Collect all unique positions from color and trans stops
  const posSet = new Set();
  for (const s of colorStops) posSet.add(s.location);
  for (const s of transStops) posSet.add(s.location);
  const positions = [...posSet].sort((a, b) => a - b);

  // Build merged stops
  const merged = positions.map(pos => {
    const color = interpolateColorAt(pos, colorStops);
    const opacity = interpolateOpacityAt(pos, transStops);
    return { r: color.r, g: color.g, b: color.b, opacity, location: pos };
  });

  // If inverted, reverse the stops and flip locations
  if (gradient.invert) {
    merged.reverse();
    for (const s of merged) s.location = 1 - s.location;
  }

  return merged;
}

// ============================================================
// SVG Generation
// ============================================================
// Convert PSP bezier nodes to an SVG path data string (d attribute).
// Each node has an anchor point (px, py) and two control handles (h1, h2).
// h1 is the incoming handle, h2 is the outgoing handle.
function nodesToPathD(nodes, shapeClosed) {
  if (nodes.length === 0) return '';

  const parts = [];
  let subPathStart = 0;

  function closeSubPath(lastNode, firstNode) {
    parts.push(`C ${fmt(lastNode.h2x)},${fmt(lastNode.h2y)} ${fmt(firstNode.h1x)},${fmt(firstNode.h1y)} ${fmt(firstNode.px)},${fmt(firstNode.py)}`);
    parts.push('Z');
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (i === 0 || node.moveTo) {
      if (i > 0 && shouldClose(nodes, subPathStart, i - 1, shapeClosed)) {
        closeSubPath(nodes[i - 1], nodes[subPathStart]);
      }
      subPathStart = i;
      parts.push(`M ${fmt(node.px)},${fmt(node.py)}`);
    } else {
      const prev = nodes[i - 1];
      parts.push(`C ${fmt(prev.h2x)},${fmt(prev.h2y)} ${fmt(node.h1x)},${fmt(node.h1y)} ${fmt(node.px)},${fmt(node.py)}`);
    }
  }

  const lastIdx = nodes.length - 1;
  if (shouldClose(nodes, subPathStart, lastIdx, shapeClosed)) {
    closeSubPath(nodes[lastIdx], nodes[subPathStart]);
  }

  return parts.join(' ');
}

function shouldClose(nodes, subPathStart, lastIdx, shapeClosed) {
  if (shapeClosed) return true;
  for (let i = subPathStart; i <= lastIdx; i++) {
    if (nodes[i].nodeFlags & keNodeClosed) return true;
  }
  return false;
}

function fmt(n) {
  return Number(n.toFixed(2));
}

function colorToHex(c) {
  if (!c) return null;
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function computeBbox(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.px); minY = Math.min(minY, n.py);
    maxX = Math.max(maxX, n.px); maxY = Math.max(maxY, n.py);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Convert a PSP gradient to an SVG <linearGradient> or <radialGradient> element.
// Returns a url(#id) reference string for use in fill/stroke attributes.
function buildGradientSVG(gradient, defs, bbox, ctx) {
  const id = 'grad' + (++ctx.gradientId);
  const stops = mergeGradientStops(gradient);
  const stopLines = stops.map(s => {
    const color = colorToHex(s);
    const opacity = s.opacity < 1 ? ` stop-opacity="${s.opacity.toFixed(2)}"` : '';
    return `      <stop offset="${(s.location * 100).toFixed(0)}%" stop-color="${color}"${opacity}/>`;
  });

  if (gradient.gradType === GRAD_LINEAR) {
    // Convert PSP angle (CSS-like convention) to SVG gradient coordinates
    // PSP: 0°=bottom-to-top, 90°=left-to-right, angles increase clockwise
    const rad = (gradient.angle - 90) * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = gradient.centerH;
    const cy = gradient.centerV;

    // Project bounding box corners onto gradient direction to find full extent
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
    let minProj = Infinity, maxProj = -Infinity;
    for (const [x, y] of corners) {
      const proj = (x - cx) * cos + (y - cy) * sin;
      minProj = Math.min(minProj, proj);
      maxProj = Math.max(maxProj, proj);
    }
    const x1 = (cx + cos * minProj).toFixed(3);
    const y1 = (cy + sin * minProj).toFixed(3);
    const x2 = (cx + cos * maxProj).toFixed(3);
    const y2 = (cy + sin * maxProj).toFixed(3);

    const spreadMethod = gradient.repeats > 0 ? ' spreadMethod="repeat"' : '';
    defs.push(`    <linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${spreadMethod}>`);
    defs.push(...stopLines);
    defs.push('    </linearGradient>');
  } else {
    // Radial, sunburst, and rectangular gradients — rectangular is approximated as radial.
    // Use userSpaceOnUse to avoid aspect ratio distortion from objectBoundingBox.
    const pxCx = bbox.minX + gradient.centerH * bbox.w;
    const pxCy = bbox.minY + gradient.centerV * bbox.h;

    // Radius = distance from center to farthest bounding box corner
    const r = Math.max(
      Math.hypot(pxCx - bbox.minX, pxCy - bbox.minY),
      Math.hypot(pxCx - bbox.maxX, pxCy - bbox.minY),
      Math.hypot(pxCx - bbox.minX, pxCy - bbox.maxY),
      Math.hypot(pxCx - bbox.maxX, pxCy - bbox.maxY),
    );

    const hasFocal = gradient.gradType === GRAD_RADIAL || gradient.gradType === GRAD_SUNBURST;
    const focalAttr = hasFocal
      ? ` fx="${fmt(bbox.minX + gradient.focalH * bbox.w)}" fy="${fmt(bbox.minY + gradient.focalV * bbox.h)}"`
      : '';
    const spreadMethod = gradient.repeats > 0 ? ' spreadMethod="repeat"' : '';
    defs.push(`    <radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(pxCx)}" cy="${fmt(pxCy)}" r="${fmt(r)}"${focalAttr}${spreadMethod}>`);
    defs.push(...stopLines);
    defs.push('    </radialGradient>');
  }

  return `url(#${id})`;
}

function styleToFill(style, defs, bbox, ctx) {
  if (!style) return 'none';
  if (style.type === 'gradient' && style.gradient) return buildGradientSVG(style.gradient, defs, bbox, ctx);
  if (style.type === 'color' && style.color) return colorToHex(style.color);
  return 'none';
}

function shapeToSVGElements(shape, defs, ctx, indent = '    ') {
  if (!shape.visible) return [];

  if (shape.type === 'group') {
    const elements = [];
    elements.push(`${indent}<g>`);
    for (const child of shape.children) {
      elements.push(...shapeToSVGElements(child, defs, ctx, indent + '  '));
    }
    elements.push(`${indent}</g>`);
    return elements;
  }

  if (shape.type === 'polyline') {
    const d = nodesToPathD(shape.nodes, shape.closed);
    if (!d) return [];

    const bbox = computeBbox(shape.nodes);
    const attrs = [`d="${d}"`];

    if (shape.filled && shape.fillStyle) {
      attrs.push(`fill="${styleToFill(shape.fillStyle, defs, bbox, ctx)}"`);
    } else {
      attrs.push('fill="none"');
    }

    if (shape.stroked && shape.strokeStyle) {
      attrs.push(`stroke="${styleToFill(shape.strokeStyle, defs, bbox, ctx)}"`);
      if (shape.strokeWidth > 0) {
        attrs.push(`stroke-width="${fmt(shape.strokeWidth)}"`);
      }
      attrs.push(`stroke-linejoin="${shape.joinType}"`);
      attrs.push(`stroke-linecap="${shape.capType}"`);
      if (shape.joinType === 'miter' && shape.miterLimit > 0) {
        attrs.push(`stroke-miterlimit="${fmt(shape.miterLimit)}"`);
      }
    } else if (!shape.filled || !shape.fillStyle || shape.fillStyle.type === 'none') {
      attrs.push('stroke="#000000"');
    }

    return [`${indent}<path ${attrs.join(' ')}/>`];
  }

  return [];
}

function generateSVG(pspData, options) {
  const { imageAttrs, layers } = pspData;
  const vectorsOnly = options && options.vectorsOnly;
  const ctx = { gradientId: 0 };
  const defs = [];
  const bodyLines = [];

  for (const layer of layers) {
    if (!layer.visible) continue;
    if (layer.kind === 'raster' && vectorsOnly) continue;

    const opacityAttr = layer.opacity < 255 ? ` opacity="${(layer.opacity / 255).toFixed(2)}"` : '';

    if (layer.kind === 'raster') {
      const png = encodePNG(layer.rgba, layer.width, layer.height);
      const dataUri = 'data:image/png;base64,' + png.toString('base64');
      bodyLines.push(`  <image id="${escapeXml(layer.name)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" href="${dataUri}"${opacityAttr}/>`);
      continue;
    }

    const shapeLines = [];
    for (const shape of layer.shapes) {
      shapeLines.push(...shapeToSVGElements(shape, defs, ctx));
    }
    if (shapeLines.length === 0) continue;

    bodyLines.push(`  <g id="${escapeXml(layer.name)}"${opacityAttr}>`);
    bodyLines.push(...shapeLines);
    bodyLines.push('  </g>');
  }

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${imageAttrs.width}" height="${imageAttrs.height}" viewBox="0 0 ${imageAttrs.width} ${imageAttrs.height}">`);

  if (defs.length > 0) {
    lines.push('  <defs>');
    lines.push(...defs);
    lines.push('  </defs>');
  }

  lines.push(...bodyLines);
  lines.push('</svg>');
  return lines.join('\n');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// CLI
// ============================================================
function main() {
  const rawArgs = process.argv.slice(2);
  const vectorsOnly = rawArgs.includes('--vectors-only');
  const args = rawArgs.filter(a => !a.startsWith('--'));

  if (args.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log('Usage: node index.js [--vectors-only] <input.psp|.pspimage> [output.svg]');
    console.log('       node index.js [--vectors-only] <input-dir> <output-dir> [png-dir]');
    console.log('\nConverts PSP 7 layers to SVG.');
    console.log('If no output is specified, writes to stdout.');
    console.log('If png-dir is specified, renders 128x128 PNG previews.');
    console.log('\nOptions:');
    console.log('  --vectors-only  Skip bitmap/raster layers (vector only)');
    process.exit(args.length === 0 && !rawArgs.includes('--help') && !rawArgs.includes('-h') ? 1 : 0);
  }

  const input = path.resolve(args[0]);
  const output = args[1] ? path.resolve(args[1]) : null;
  const pngDir = args[2] ? path.resolve(args[2]) : null;

  const inputStat = fs.statSync(input);

  function renderPreview(svgPath, baseName) {
    if (!pngDir) return;
    const pngPath = path.join(pngDir, baseName.replace(/\.(psp|pspimage)$/i, '.png'));
    renderPNG(svgPath, pngPath, 128);
    console.log(`Rendered:  ${baseName} -> ${path.basename(pngPath)}`);
  }

  if (inputStat.isDirectory()) {
    if (!output) {
      console.error('Error: output directory required for batch mode');
      process.exit(1);
    }
    if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });
    if (pngDir && !fs.existsSync(pngDir)) fs.mkdirSync(pngDir, { recursive: true });

    const files = fs.readdirSync(input).filter(f => f.toLowerCase().endsWith('.psp') || f.toLowerCase().endsWith('.pspimage'));
    for (const file of files) {
      const inputPath = path.join(input, file);
      const outputPath = path.join(output, file.replace(/\.(psp|pspimage)$/i, '.svg'));
      try {
        convertFile(inputPath, outputPath, { vectorsOnly });
        console.log(`Converted: ${file} -> ${path.basename(outputPath)}`);
        renderPreview(outputPath, file);
      } catch (err) {
        console.error(`Error converting ${file}: ${err.message}`);
      }
    }
  } else {
    if (output) {
      if (pngDir && !fs.existsSync(pngDir)) fs.mkdirSync(pngDir, { recursive: true });
      convertFile(input, output, { vectorsOnly });
      console.log(`Converted: ${path.basename(input)} -> ${path.basename(output)}`);
      renderPreview(output, path.basename(input));
    } else {
      const buffer = fs.readFileSync(input);
      const pspData = parsePSP(buffer);
      const svg = generateSVG(pspData, { vectorsOnly });
      process.stdout.write(svg + '\n');
    }
  }
}

function convertFile(inputPath, outputPath, options) {
  const buffer = fs.readFileSync(inputPath);
  const pspData = parsePSP(buffer);
  const svg = generateSVG(pspData, options);
  fs.writeFileSync(outputPath, svg, 'utf8');
}

function renderPNG(svgPath, pngPath, size) {
  const { Resvg } = require('@resvg/resvg-js');
  const svgData = fs.readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svgData, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0, 0, 0, 0)',
  });
  const rendered = resvg.render();
  fs.writeFileSync(pngPath, rendered.asPng());
}

module.exports = { parsePSP, generateSVG, convertFile };

if (require.main === module) {
  main();
}
