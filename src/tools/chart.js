import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';
import { hoverBar, MAX_HOVER_BAR_OFFSET } from '../core/hover_bar.js';

export function registerChartTools(server) {
  server.tool('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {}, async () => {
    try { return jsonResult(await core.getState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_symbol', 'Change the chart symbol', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.setSymbol({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
  }, async ({ timeframe }) => {
    try { return jsonResult(await core.setTimeframe({ timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  }, async ({ chart_type }) => {
    try { return jsonResult(await core.setType({ chart_type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().optional().describe('Full indicator name (required for add): "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work. Not needed for remove.'),
    entity_id: z.string().optional().describe('Entity ID (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
  }, async ({ action, indicator, entity_id, inputs }) => {
    try {
      if (action === 'add' && !indicator) throw new Error('indicator name is required for add action.');
      return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, async () => {
    try { return jsonResult(await core.getVisibleRange()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
  }, async ({ from, to }) => {
    try { return jsonResult(await core.setVisibleRange({ from, to })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  }, async ({ date }) => {
    try { return jsonResult(await core.scrollToDate({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_hover_bar', 'Move the active-pane crosshair to one exact loaded bar and return a stable Data Window reading. This is a verification fallback: it only sends CDP mouseMoved, verifies TradingView applied the requested bar time, and fails closed if Replay is active, the bar is not visible, or identities change.', {
    time: z.coerce.number().optional().describe('Unix bar time in seconds or milliseconds. Exactly one of time or bars_ago is required.'),
    bars_ago: z.coerce.number().int().min(0).max(MAX_HOVER_BAR_OFFSET).optional().describe('Offset from the last loaded bar. Exactly one of time or bars_ago is required; 0 selects the active bar.'),
    study_filters: z.array(z.string().min(1)).optional().describe('Substring filters for target visible studies. Each filter must match a study; omit to read every visible study Data Window.'),
    stable_polls: z.coerce.number().int().min(2).max(12).optional().describe('Consecutive identical Data Window observations required before success (default 2).'),
    poll_interval_ms: z.coerce.number().int().min(25).max(2000).optional().describe('Milliseconds between Data Window stability observations (default 100).'),
    timeout_ms: z.coerce.number().int().min(100).max(10000).optional().describe('Bounded timeout for revealing the bar and settling the crosshair/Data Window (default 2000).'),
  }, async ({ time, bars_ago, study_filters, stable_polls, poll_interval_ms, timeout_ms }) => {
    try {
      const result = await hoverBar({
        time,
        bars_ago,
        study_filters,
        stable_polls,
        poll_interval_ms,
        timeout_ms,
      });
      return jsonResult(result, result.success !== true);
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try { return jsonResult(await core.symbolInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
