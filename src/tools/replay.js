import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/replay.js';

export function registerReplayTools(server) {
  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date', {
    date: z.string().optional().describe('Date to start replay from (YYYY-MM-DD format). If omitted, selects first available date.'),
  }, async ({ date }) => {
    try { return jsonResult(await core.start({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_step', 'Advance one bar in replay mode', {}, async () => {
    try { return jsonResult(await core.step()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_capture_chunk', 'Capture 1–25 replay bars with no autoplay. v4 records the post-step finalized target bar: it first proves the Replay clock and preview OHLCV are quiet enough for one manual step, then requires the matching postBars[-2] OHLCV and timestamped Trend/Swing PlotList rows to remain stable. Active Data Window values are preview diagnostics only and are never used as final features. Pine label checkpoints use strict pl4 physical-epoch identities, so replay-local primitive IDs and logical indices cannot suppress a later physical bar after Replay restarts. Returns strict 0822-replay.v4/post_target_final_label_epoch checkpoints.', {
    bars: z.coerce.number().int().min(1).max(core.MAX_CAPTURE_CHUNK_BARS).describe('Number of manually stepped replay bars to capture (1–25).'),
    poll_attempts: z.coerce.number().int().min(1).max(80).optional().describe('Post-step alignment polls per bar (default 24).'),
    poll_interval_ms: z.coerce.number().int().min(25).max(2000).optional().describe('Milliseconds between post-step alignment polls (default 125).'),
    settle_ms: z.coerce.number().int().min(0).max(10000).optional().describe('Minimum unchanged-OHLCV quiet duration inside the active-bar readiness gate (default 1500; supports longer 1H stabilization windows up to 10000).'),
    active_ready_timeout_ms: z.coerce.number().int().min(1000).max(core.MAX_ACTIVE_READY_TIMEOUT_MS).optional().describe('Bound for waiting on a causally settled active bar before returning a checkpoint failure (default 120000).'),
    active_ready_poll_interval_ms: z.coerce.number().int().min(50).max(1000).optional().describe('Polling interval while proving the active bar remains unchanged (default 250).'),
    active_ready_stable_polls: z.coerce.number().int().min(2).max(12).optional().describe('Consecutive identical active OHLCV observations required before stepping (default 4).'),
    active_ready_study_stable_polls: z.coerce.number().int().min(2).max(12).optional().describe('Deprecated v2 preview-study setting, retained only for request compatibility; v4 does not gate a manual step on live Data Window values.'),
    post_step_closed_bar_stable_polls: z.coerce.number().int().min(2).max(12).optional().describe('Consecutive identical post-step target OHLCV plus timestamped Trend/Swing PlotList-row evidence observations required before recording (default 4; use a lower value only for controlled tests).'),
    known_label_keys: z.array(z.string()).max(core.MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS).optional().describe('Full v4 `pl4:` Pine-label physical-epoch checkpoint persisted from seen_label_keys_after. Nonempty legacy study::id keys are rejected before Replay is stepped.'),
    known_shape_keys: z.array(z.string()).max(core.MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS).optional().describe('Full persisted Trend plotshape identities from the previous accepted checkpoint. Preserves first-seen evidence across chunks and delayed historical recalculations.'),
    shape_state_initialized: z.boolean().optional().describe('Persisted shape_state_initialized_after from the previous accepted checkpoint. Omit or false only for a clean first initialization; true with an empty known_shape_keys array still emits delayed historical additions.'),
  }, async ({
    bars,
    poll_attempts,
    poll_interval_ms,
    settle_ms,
    active_ready_timeout_ms,
    active_ready_poll_interval_ms,
    active_ready_stable_polls,
    active_ready_study_stable_polls,
    post_step_closed_bar_stable_polls,
    known_label_keys,
    known_shape_keys,
    shape_state_initialized,
  }) => {
    try {
      return jsonResult(await core.captureChunk({
        bars,
        poll_attempts,
        poll_interval_ms,
        settle_ms,
        active_ready_timeout_ms,
        active_ready_poll_interval_ms,
        active_ready_stable_polls,
        active_ready_study_stable_polls,
        post_step_closed_bar_stable_polls,
        known_label_keys,
        known_shape_keys,
        shape_state_initialized,
      }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('replay_autoplay', 'Toggle autoplay in replay mode, optionally set speed', {
    speed: z.coerce.number().optional().describe('Autoplay delay in ms (lower = faster). Valid values: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Leave empty to just toggle.'),
  }, async ({ speed }) => {
    try { return jsonResult(await core.autoplay({ speed })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try { return jsonResult(await core.stop()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    action: z.string().describe('Trade action: buy, sell, or close'),
  }, async ({ action }) => {
    try { return jsonResult(await core.trade({ action })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try { return jsonResult(await core.status()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
