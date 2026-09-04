/**
 * Generic PlotList decoding used by data_get_bar_snapshot.
 *
 * These helpers are Node-side and do not talk to TradingView. Page evaluation
 * returns raw PlotList rows plus compact study metadata; this module maps
 * meta.plots[index] to row[index + 1], keeps empty cells as null, decodes
 * packed ABGR colorer values, resolves palette colors, and reads filledAreas.
 *
 * 0822 live/replay capture tools keep their own in-page contracts.
 */

const EMPTY_MARKERS = new Set(['', '∅']);

export function isEmptyPlotValue(value) {
  return value === undefined || value === null || EMPTY_MARKERS.has(value);
}

/** Keep explicit empties as null so missing is not confused with a failed read. */
export function preservePlotValue(value) {
  if (isEmptyPlotValue(value)) return null;
  return value;
}

function isColorerType(type) {
  return String(type || '').toLowerCase() === 'colorer';
}

function toUnsigned32(value) {
  return Number(value) >>> 0;
}

function hexByte(value) {
  return value.toString(16).padStart(2, '0');
}

export function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(trimmed);
  if (!match) return null;
  const body = match[1];
  if (body.length === 3) {
    return `#${body.split('').map(ch => ch + ch).join('').toLowerCase()}`;
  }
  return `#${body.slice(0, 6).toLowerCase()}`;
}

/**
 * Decode a TradingView packed plot color as ABGR bytes.
 * Verified Trend fills use A≈0.349 for green/red and A≈0.302 for gray.
 */
export function decodePackedAbgr(raw) {
  const value = preservePlotValue(raw);
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  const packed = toUnsigned32(value);
  const alphaByte = (packed >>> 24) & 0xff;
  const blue = (packed >>> 16) & 0xff;
  const green = (packed >>> 8) & 0xff;
  const red = packed & 0xff;
  return {
    hex: `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`,
    alpha: alphaByte / 255,
    raw: value,
  };
}

function asIndexable(value) {
  if (value == null || typeof value !== 'object') return {};
  if (typeof value.forEach === 'function' && typeof value.get === 'function') {
    const out = {};
    value.forEach((entry, key) => {
      out[String(key)] = entry;
    });
    return out;
  }
  return value;
}

function plainObject(value) {
  const indexed = asIndexable(value);
  const out = {};
  for (const key of Object.keys(indexed).sort()) out[key] = indexed[key];
  return out;
}

function lookupIndexed(collection, index) {
  if (collection == null) return undefined;
  if (Array.isArray(collection)) return collection[index];
  if (typeof collection === 'object') {
    if (Object.prototype.hasOwnProperty.call(collection, index)) return collection[index];
    if (Object.prototype.hasOwnProperty.call(collection, String(index))) {
      return collection[String(index)];
    }
  }
  return undefined;
}

function colorFromPaletteEntry(entry) {
  if (typeof entry === 'string') {
    const hex = normalizeHexColor(entry);
    return hex ? { hex, alpha: 1 } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const hex = normalizeHexColor(entry.color || entry.value);
  if (!hex) return null;
  const alpha = typeof entry.alpha === 'number' && Number.isFinite(entry.alpha)
    ? entry.alpha
    : 1;
  return { hex, alpha };
}

/**
 * Resolve a palette plot/fill value through meta.palettes[id].valToIndex and
 * meta.defaults.palettes[id].colors (array or index map).
 */
export function resolvePaletteColor(meta, paletteId, rawValue) {
  if (paletteId == null || paletteId === '') return null;
  const value = preservePlotValue(rawValue);
  if (value === null) return null;
  const palettes = asIndexable(meta && meta.palettes);
  const defaults = asIndexable(
    (meta && meta.defaults && meta.defaults.palettes)
      || (meta && meta.defaultsPalettes),
  );
  const palette = palettes[paletteId] || {};
  const defaultsPalette = defaults[paletteId] || {};
  const valToIndex = asIndexable(palette.valToIndex);
  let index = null;
  if (Object.prototype.hasOwnProperty.call(valToIndex, value)) {
    index = valToIndex[value];
  } else if (Object.prototype.hasOwnProperty.call(valToIndex, String(value))) {
    index = valToIndex[String(value)];
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    index = value;
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  const colors = defaultsPalette.colors != null ? defaultsPalette.colors : palette.colors;
  const decoded = colorFromPaletteEntry(lookupIndexed(colors, index));
  if (!decoded) return null;
  return {
    hex: decoded.hex,
    alpha: decoded.alpha,
    raw: value,
    index,
  };
}

export function plotManifest(plot, styles, index) {
  const spec = plot && typeof plot === 'object' ? plot : {};
  const styleMap = asIndexable(styles);
  const style = spec.id != null && styleMap[spec.id] && typeof styleMap[spec.id] === 'object'
    ? styleMap[spec.id]
    : {};
  const title = style.title != null && style.title !== ''
    ? String(style.title)
    : (spec.title != null && spec.title !== '' ? String(spec.title) : null);
  const text = style.text != null && style.text !== ''
    ? String(style.text)
    : (spec.text != null && spec.text !== '' ? String(spec.text) : null);
  return {
    id: spec.id == null ? null : String(spec.id),
    type: spec.type == null ? null : String(spec.type),
    target: spec.target == null ? null : String(spec.target),
    palette: spec.palette == null ? null : String(spec.palette),
    title,
    text,
    row_index: index + 1,
  };
}

function decodePlotColor(meta, manifest, value) {
  if (!manifest || (!isColorerType(manifest.type) && !manifest.palette)) return undefined;
  const paletteColor = manifest.palette
    ? resolvePaletteColor(meta, manifest.palette, value)
    : null;
  if (paletteColor) return paletteColor;
  return decodePackedAbgr(value);
}

/**
 * Map one PlotList row: meta.plots[index] corresponds to row[index + 1].
 * row[0] is the bar time and is not a plot.
 */
export function mapPlotListRow(meta, row) {
  const plots = Array.isArray(meta && meta.plots) ? meta.plots : [];
  const styles = asIndexable(meta && meta.styles);
  const values = Array.isArray(row) ? row : [];
  return plots.map((plot, index) => {
    const manifest = plotManifest(plot, styles, index);
    const value = preservePlotValue(index + 1 < values.length ? values[index + 1] : undefined);
    const mapped = {
      id: manifest.id,
      type: manifest.type,
      target: manifest.target,
      palette: manifest.palette,
      title: manifest.title,
      text: manifest.text,
      value,
    };
    const color = decodePlotColor(meta, manifest, value);
    if (color !== undefined) mapped.color = color;
    return mapped;
  });
}

function plotById(mappedPlots) {
  const byId = Object.create(null);
  for (const plot of mappedPlots) {
    if (plot && plot.id) byId[plot.id] = plot;
  }
  return byId;
}

function fillColor(meta, fill, mappedPlots) {
  const colorer = mappedPlots.find(plot => (
    isColorerType(plot.type) && plot.target === fill.id
  ));
  if (colorer) {
    if (colorer.color) return colorer.color;
    return resolvePaletteColor(meta, fill.palette || colorer.palette, colorer.value)
      || decodePackedAbgr(colorer.value);
  }
  if (fill.palette) return resolvePaletteColor(meta, fill.palette, null);
  return null;
}

/**
 * Read filledAreas against the same PlotList row: upper/lower come from the
 * objA/objB plots, color from a targeting colorer or fill palette.
 */
export function parseFilledAreas(meta, row, mappedPlots) {
  const fills = Array.isArray(meta && meta.filledAreas)
    ? meta.filledAreas
    : (Array.isArray(meta && meta.filled_areas) ? meta.filled_areas : []);
  const plots = Array.isArray(mappedPlots) ? mappedPlots : mapPlotListRow(meta, row);
  const byId = plotById(plots);
  return fills.map((fill) => {
    const spec = fill && typeof fill === 'object' ? fill : {};
    const upperPlot = spec.objAId != null ? byId[String(spec.objAId)] : undefined;
    const lowerPlot = spec.objBId != null ? byId[String(spec.objBId)] : undefined;
    return {
      id: spec.id == null ? null : String(spec.id),
      title: spec.title == null || spec.title === '' ? null : String(spec.title),
      objAId: spec.objAId == null ? null : String(spec.objAId),
      objBId: spec.objBId == null ? null : String(spec.objBId),
      upper: upperPlot ? upperPlot.value : null,
      lower: lowerPlot ? lowerPlot.value : null,
      color: fillColor(meta, {
        id: spec.id == null ? null : String(spec.id),
        palette: spec.palette == null ? null : String(spec.palette),
      }, plots),
    };
  });
}

export function hydrateStudyFromPlotList(study) {
  const meta = study && study.meta && typeof study.meta === 'object' ? study.meta : {};
  const row = Array.isArray(study && study.row) ? study.row : [];
  const plots = mapPlotListRow(meta, row);
  const fills = parseFilledAreas(meta, row, plots);
  const rawFills = Array.isArray(meta.filledAreas)
    ? meta.filledAreas
    : (Array.isArray(meta.filled_areas) ? meta.filled_areas : []);
  const paletteDefinitions = plainObject(meta.palettes);
  const paletteDefaults = plainObject(meta.defaults && meta.defaults.palettes);
  const paletteIds = [...new Set([
    ...Object.keys(paletteDefinitions),
    ...Object.keys(paletteDefaults),
  ])].sort();
  const palettes = {};
  for (const id of paletteIds) {
    const definition = paletteDefinitions[id] && typeof paletteDefinitions[id] === 'object'
      ? paletteDefinitions[id]
      : {};
    const defaults = paletteDefaults[id] && typeof paletteDefaults[id] === 'object'
      ? paletteDefaults[id]
      : {};
    palettes[id] = {
      valToIndex: plainObject(definition.valToIndex),
      colors: plainObject(defaults.colors != null ? defaults.colors : definition.colors),
    };
  }
  const historyCalculationMayChange = study
    && typeof study.history_calculation_may_change === 'boolean'
    ? study.history_calculation_may_change
    : !!meta.historyCalculationMayChange;
  return {
    entity_id: study && study.entity_id != null ? study.entity_id : null,
    name: study && study.name != null ? study.name : null,
    history_calculation_may_change: historyCalculationMayChange,
    manifest: {
      plots: (Array.isArray(meta.plots) ? meta.plots : [])
        .map((plot, index) => plotManifest(plot, meta.styles, index)),
      fills: rawFills.map(fill => ({
        id: fill && fill.id != null ? String(fill.id) : null,
        title: fill && fill.title != null ? String(fill.title) : null,
        objAId: fill && fill.objAId != null ? String(fill.objAId) : null,
        objBId: fill && fill.objBId != null ? String(fill.objBId) : null,
        palette: fill && fill.palette != null ? String(fill.palette) : null,
      })),
      palettes,
      history_calculation_may_change: historyCalculationMayChange,
    },
    plots,
    fills,
  };
}
