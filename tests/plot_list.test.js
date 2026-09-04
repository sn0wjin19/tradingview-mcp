/**
 * Pure PlotList mapping tests. No CDP / TradingView connection.
 * Run: node --test tests/plot_list.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePackedAbgr,
  hydrateStudyFromPlotList,
  mapPlotListRow,
  parseFilledAreas,
  preservePlotValue,
  resolvePaletteColor,
} from '../src/core/plot_list.js';
import {
  TREND_COLORS,
  TREND_PACKED,
  swingPaletteMeta,
  swingPaletteRow,
  SWING_PALETTE_COLORS,
  trendFillMeta,
  trendFillRow,
} from './fixtures/plot_list_0822.js';

describe('plot_list packed ABGR', () => {
  it('decodes verified Trend green/red/gray packed colors', () => {
    const green = decodePackedAbgr(TREND_PACKED.GREEN);
    assert.equal(green.hex, TREND_COLORS.GREEN.hex);
    assert.ok(Math.abs(green.alpha - 0.349) < 0.002);
    assert.equal(green.raw, TREND_PACKED.GREEN);

    const red = decodePackedAbgr(TREND_PACKED.RED);
    assert.equal(red.hex, TREND_COLORS.RED.hex);
    assert.ok(Math.abs(red.alpha - 0.349) < 0.002);

    const gray = decodePackedAbgr(TREND_PACKED.GRAY);
    assert.equal(gray.hex, TREND_COLORS.GRAY.hex);
    assert.ok(Math.abs(gray.alpha - 0.302) < 0.002);
  });

  it('keeps empty packed colors as null', () => {
    assert.equal(decodePackedAbgr(null), null);
    assert.equal(decodePackedAbgr(undefined), null);
    assert.equal(decodePackedAbgr('∅'), null);
    assert.equal(decodePackedAbgr(''), null);
    assert.equal(preservePlotValue('∅'), null);
    assert.equal(preservePlotValue(undefined), null);
    assert.equal(preservePlotValue(0), 0);
  });
});

describe('plot_list palette', () => {
  it('resolves Swing palette values through valToIndex and defaults.palettes', () => {
    assert.deepEqual(resolvePaletteColor(swingPaletteMeta, 'palette_block', 0), {
      hex: SWING_PALETTE_COLORS[0], alpha: 1, raw: 0, index: 0,
    });
    assert.deepEqual(resolvePaletteColor(swingPaletteMeta, 'palette_block', 1), {
      hex: SWING_PALETTE_COLORS[1], alpha: 1, raw: 1, index: 1,
    });
    assert.deepEqual(resolvePaletteColor(swingPaletteMeta, 'palette_block', 4), {
      hex: SWING_PALETTE_COLORS[4], alpha: 1, raw: 4, index: 4,
    });
    assert.equal(resolvePaletteColor(swingPaletteMeta, 'palette_block', null), null);
    assert.equal(resolvePaletteColor(swingPaletteMeta, 'palette_block', '∅'), null);
  });

  it('supports TradingView map-like palette and style containers', () => {
    const meta = structuredClone(swingPaletteMeta);
    meta.styles = new Map(Object.entries(meta.styles));
    meta.palettes = new Map(Object.entries(meta.palettes));
    meta.defaults.palettes = new Map(Object.entries(meta.defaults.palettes));
    assert.equal(resolvePaletteColor(meta, 'palette_block', 1).hex, SWING_PALETTE_COLORS[1]);
    assert.equal(mapPlotListRow(meta, swingPaletteRow(100))[0].title, '背离线');
  });
});

describe('plot_list row mapping', () => {
  it('maps meta.plots[index] onto PlotList row[index + 1] and preserves nulls', () => {
    const row = swingPaletteRow(1_700_000_000, { empty: '∅' });
    const plots = mapPlotListRow(swingPaletteMeta, row);
    assert.equal(plots.length, 4);
    assert.equal(plots[0].id, 'plot_osc');
    assert.equal(plots[0].value, 12.5);
    assert.equal(plots[0].title, '背离线');
    assert.equal(plots[1].value, 20);
    assert.equal(plots[2].type, 'colorer');
    assert.equal(plots[2].value, 1);
    assert.equal(plots[2].color.hex, SWING_PALETTE_COLORS[1]);
    assert.equal(plots[3].value, null);
    assert.equal(Object.hasOwn(plots[0], 'color'), false);
  });

  it('reads filledAreas upper/lower/color from the same row', () => {
    const row = trendFillRow(1_700_000_015);
    const plots = mapPlotListRow(trendFillMeta, row);
    const fills = parseFilledAreas(trendFillMeta, row, plots);
    assert.equal(fills.length, 3);
    assert.deepEqual(fills[0], {
      id: 'fill_z1',
      title: 'Z1',
      objAId: 'plot_z1_upper',
      objBId: 'plot_z1_lower',
      upper: 110,
      lower: 90,
      color: {
        hex: TREND_COLORS.GREEN.hex,
        alpha: TREND_COLORS.GREEN.alpha,
        raw: TREND_PACKED.GREEN,
      },
    });
    assert.equal(fills[1].color.hex, TREND_COLORS.RED.hex);
    assert.equal(fills[2].color.hex, TREND_COLORS.GRAY.hex);
    assert.equal(plots[4].type, 'colorer');
    assert.equal(plots[4].target, 'fill_z1');
    assert.equal(plots[4].color.hex, TREND_COLORS.GREEN.hex);
  });

  it('hydrates a study without dropping empty cells', () => {
    const study = hydrateStudyFromPlotList({
      entity_id: 's1',
      name: '波段过滤器 | 百万Eric | 0822',
      history_calculation_may_change: true,
      meta: swingPaletteMeta,
      row: swingPaletteRow(100, { oscillator: null, empty: undefined }),
    });
    assert.equal(study.plots[0].value, null);
    assert.equal(study.plots[3].value, null);
    assert.equal(study.history_calculation_may_change, true);
    assert.equal(study.fills.length, 0);
  });
});
