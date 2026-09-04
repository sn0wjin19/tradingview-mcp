/**
 * Verified 2026-09-04 Mac TradingView Desktop PlotList fixtures.
 * Packed Trend fills are ABGR integers; Swing block colors use palette valToIndex.
 */

export const TREND_0822 = '趋势过滤器 | 百万Eric | 0822';
export const SWING_0822 = '波段过滤器 | 百万Eric | 0822';

export function packAbgr(r, g, b, alpha) {
  const alphaByte = Math.round(alpha * 255);
  return ((alphaByte << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export const TREND_PACKED = {
  GREEN: packAbgr(0x08, 0x99, 0x81, 0.349),
  RED: packAbgr(0xf2, 0x36, 0x45, 0.349),
  GRAY: packAbgr(0x80, 0x80, 0x80, 0.302),
};

export const TREND_COLORS = {
  GREEN: { hex: '#089981', alpha: 89 / 255 },
  RED: { hex: '#f23645', alpha: 89 / 255 },
  GRAY: { hex: '#808080', alpha: 77 / 255 },
};

export const SWING_PALETTE_COLORS = {
  0: '#eb4d5c',
  1: '#6fbf73',
  2: '#ffc53d',
  3: '#597ef7',
  4: '#787b86',
};

export const trendFillMeta = {
  historyCalculationMayChange: true,
  plots: [
    { id: 'plot_0', type: 'line' },
    { id: 'plot_1', type: 'line' },
    { id: 'plot_z1_upper', type: 'line' },
    { id: 'plot_z1_lower', type: 'line' },
    { id: 'plot_z1_color', type: 'colorer', target: 'fill_z1' },
    { id: 'plot_z2_upper', type: 'line' },
    { id: 'plot_z2_lower', type: 'line' },
    { id: 'plot_z2_color', type: 'colorer', target: 'fill_z2' },
    { id: 'plot_z3_upper', type: 'line' },
    { id: 'plot_z3_lower', type: 'line' },
    { id: 'plot_z3_color', type: 'colorer', target: 'fill_z3' },
  ],
  styles: {
    plot_0: { title: 'EMA21', text: 'EMA21' },
    plot_1: { title: 'EMA55', text: 'EMA55' },
    plot_z1_upper: { title: 'Z1 upper' },
    plot_z1_lower: { title: 'Z1 lower' },
    plot_z2_upper: { title: 'Z2 upper' },
    plot_z2_lower: { title: 'Z2 lower' },
    plot_z3_upper: { title: 'Z3 upper' },
    plot_z3_lower: { title: 'Z3 lower' },
  },
  filledAreas: [
    { id: 'fill_z1', title: 'Z1', objAId: 'plot_z1_upper', objBId: 'plot_z1_lower' },
    { id: 'fill_z2', title: 'Z2', objAId: 'plot_z2_upper', objBId: 'plot_z2_lower' },
    { id: 'fill_z3', title: 'Z3', objAId: 'plot_z3_upper', objBId: 'plot_z3_lower' },
  ],
};

export function trendFillRow(barTime, {
  ema21 = 100,
  ema55 = 101,
  z1 = { upper: 110, lower: 90, color: TREND_PACKED.GREEN },
  z2 = { upper: 108, lower: 92, color: TREND_PACKED.RED },
  z3 = { upper: 105, lower: 95, color: TREND_PACKED.GRAY },
} = {}) {
  return [
    barTime,
    ema21,
    ema55,
    z1.upper, z1.lower, z1.color,
    z2.upper, z2.lower, z2.color,
    z3.upper, z3.lower, z3.color,
  ];
}

export const swingPaletteMeta = {
  historyCalculationMayChange: true,
  plots: [
    { id: 'plot_osc', type: 'line' },
    { id: 'plot_block', type: 'line', palette: 'palette_block' },
    { id: 'plot_block_color', type: 'colorer', target: 'plot_block', palette: 'palette_block' },
    { id: 'plot_empty', type: 'shapes' },
  ],
  styles: {
    plot_osc: { title: '背离线', text: '背离线' },
    plot_block: { title: 'upper block' },
    plot_empty: { title: 'inactive shape' },
  },
  palettes: {
    palette_block: {
      valToIndex: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 },
    },
  },
  defaults: {
    palettes: {
      palette_block: {
        colors: {
          0: { color: SWING_PALETTE_COLORS[0] },
          1: { color: SWING_PALETTE_COLORS[1] },
          2: { color: SWING_PALETTE_COLORS[2] },
          3: { color: SWING_PALETTE_COLORS[3] },
          4: { color: SWING_PALETTE_COLORS[4] },
        },
      },
    },
  },
};

export function swingPaletteRow(barTime, {
  oscillator = 12.5,
  block = 20,
  paletteValue = 1,
  empty = null,
} = {}) {
  return [barTime, oscillator, block, paletteValue, empty];
}
