import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';
import * as live0822 from '../core/live_capture_0822.js';
import { getBarSnapshot, MAX_BAR_SNAPSHOT_COUNT, scanPanes } from '../core/bar_snapshot.js';

export function registerDataTools(server) {
  server.tool('data_capture_0822_closed', 'Atomically capture 1–5 confirmed 0822 closed bars from the live chart without entering or advancing Replay. The newest target is the bar immediately before the active bar and is the only row allowed to emit strategy-eligible checkpoint deltas; older tail rows are finalized PlotList features only and explicitly non-causal for events. The tool requires at least two identical full observations and returns symbol/timeframe from that same page evaluation.', {
    count: z.coerce.number().int().min(1).max(5).optional().describe('Closed bars to capture, newest last (default 3). The active live bar is always excluded.'),
    poll_attempts: z.coerce.number().int().min(2).max(80).optional().describe('Maximum atomic stability observations (default 16). Must be at least stable_polls.'),
    poll_interval_ms: z.coerce.number().int().min(25).max(2000).optional().describe('Milliseconds between stability observations (default 125).'),
    stable_polls: z.coerce.number().int().min(2).max(12).optional().describe('Identical complete snapshots required before capture (default 2).'),
    settle_ms: z.coerce.number().int().min(0).max(10000).optional().describe('Read-only delay before polling, allowing a just-switched chart to repopulate PlotList sources.'),
    known_label_keys: z.array(z.string()).max(live0822.MAX_LIVE_CHECKPOINT_KEYS).optional().describe('Persisted pl4 physical-epoch label checkpoint. Leave empty only for first live seed.'),
    known_shape_keys: z.array(z.string()).max(live0822.MAX_LIVE_CHECKPOINT_KEYS).optional().describe('Persisted Trend PlotList shape checkpoint.'),
    shape_state_initialized: z.boolean().optional().describe('Whether known_shape_keys is an initialized live checkpoint.'),
    label_state_initialized: z.boolean().optional().describe('Whether known_label_keys is an initialized live checkpoint. A false first seed never turns labels already visible now into historical first-seen events.'),
  }, async ({
    count,
    poll_attempts,
    poll_interval_ms,
    stable_polls,
    settle_ms,
    known_label_keys,
    known_shape_keys,
    shape_state_initialized,
    label_state_initialized,
  }) => {
    try {
      return jsonResult(await live0822.capture0822Closed({
        count,
        poll_attempts,
        poll_interval_ms,
        stable_polls,
        settle_ms,
        known_label_keys,
        known_shape_keys,
        shape_state_initialized,
        label_state_initialized,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('data_get_bar_snapshot', 'Atomically read a small closed-bar PlotList snapshot from the active pane without moving the mouse. time and bars_ago are mutually exclusive; omit both for the latest closed bar. Requires consecutive identical complete snapshots before success.', {
    time: z.coerce.number().optional().describe('Unix bar time (seconds or milliseconds). Mutually exclusive with bars_ago.'),
    bars_ago: z.coerce.number().int().min(0).max(5000).optional().describe('Offset from the last loaded bar. 1 is the latest closed bar when closed_only is true. Mutually exclusive with time.'),
    count: z.coerce.number().int().min(1).max(MAX_BAR_SNAPSHOT_COUNT).optional().describe('Closed bars to return, newest last (default 1, max 20).'),
    closed_only: z.boolean().optional().describe('Exclude the active bar (default true).'),
    study_filters: z.array(z.string().min(1)).optional().describe('Substring filters for study names. If set, every filter must match a visible PlotList study.'),
    stable_polls: z.coerce.number().int().min(2).max(12).optional().describe('Identical complete snapshots required before success (default 2).'),
    poll_interval_ms: z.coerce.number().int().min(25).max(2000).optional().describe('Milliseconds between stability observations (default 100).'),
  }, async ({
    time,
    bars_ago,
    count,
    closed_only,
    study_filters,
    stable_polls,
    poll_interval_ms,
  }) => {
    try {
      const result = await getBarSnapshot({
        time,
        bars_ago,
        count,
        closed_only,
        study_filters,
        stable_polls,
        poll_interval_ms,
      });
      return jsonResult(result, result.success !== true);
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('data_scan_panes', 'Atomically read closed-bar PlotList snapshots from every pane in the current layout. The whole layout must remain complete, ordered, identity-stable, and identical for consecutive polls.', {
    count: z.coerce.number().int().min(1).max(MAX_BAR_SNAPSHOT_COUNT).optional().describe('Bars per pane, newest last (default 1, max 20).'),
    closed_only: z.boolean().optional().describe('Exclude each pane active bar (default true).'),
    study_filters: z.array(z.string().min(1)).optional().describe('Substring filters for study names. Every pane must contain every requested visible PlotList study.'),
    stable_polls: z.coerce.number().int().min(2).max(12).optional().describe('Identical complete whole-layout snapshots required before success (default 2).'),
    poll_interval_ms: z.coerce.number().int().min(25).max(2000).optional().describe('Milliseconds between whole-layout observations (default 100).'),
  }, async ({ count, closed_only, study_filters, stable_polls, poll_interval_ms }) => {
    try {
      const result = await scanPanes({
        count,
        closed_only,
        study_filters,
        stable_polls,
        poll_interval_ms,
      });
      return jsonResult(result, result.success !== true);
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
  }, async ({ count, summary }) => {
    try { return jsonResult(await core.getOhlcv({ count, summary })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_strategy_results', 'Get strategy performance metrics from Strategy Tester', {}, async () => {
    try { return jsonResult(await core.getStrategyResults()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_trades', 'Get trade list from Strategy Tester', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
  }, async ({ max_trades }) => {
    try { return jsonResult(await core.getTrades({ max_trades })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_equity', 'Get equity curve data from Strategy Tester', {}, async () => {
    try { return jsonResult(await core.getEquity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume)', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  }, async ({ study_filter, max_labels, verbose }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await core.getPineTables({ study_filter })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {}, async () => {
    try { return jsonResult(await core.getStudyValues()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
