/**
 * Atomic, read-only capture of the visible 0822 studies on realtime charts.
 *
 * This deliberately does not use Replay.  The newest returned target is the
 * bar immediately before the live active bar; older rows are feature-only
 * tail data and never claim reconstructed first-seen events.
 */
import { evaluateAsync as _evaluateAsync } from '../connection.js';
import {
  REPLAY_LABEL_IDENTITY_VERSION,
  REPLAY_PERSISTENT_LABEL_KEY_PREFIX,
  is0822ResearchStudyName,
  isPersistentReplayLabelKey,
  stableReplayLabelIdentity,
} from './replay.js';

export const LIVE_CAPTURE_SCHEMA_VERSION = '0822-live.v1/closed_tail';
export const MAX_LIVE_CAPTURE_COUNT = 5;
export const MAX_LIVE_CHECKPOINT_KEYS = 50000;
export const LIVE_STRATEGY_CHECKPOINT_SCOPE = 'live_strategy_tail_v1';

const DEFAULT_COUNT = 3;
const DEFAULT_POLL_ATTEMPTS = 16;
const DEFAULT_POLL_INTERVAL_MS = 125;
const DEFAULT_STABLE_POLLS = 2;
const DEFAULT_SETTLE_MS = 0;

function resolve(deps) {
  return { evaluateAsync: deps?.evaluateAsync || _evaluateAsync };
}

export function validateLiveCaptureCount(value) {
  if (value === undefined || value === null) return DEFAULT_COUNT;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_LIVE_CAPTURE_COUNT) {
    throw new Error(`count must be an integer from 1 to ${MAX_LIVE_CAPTURE_COUNT}`);
  }
  return count;
}

function validateInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function validateCheckpointKeys(value, field, predicate = item => typeof item === 'string') {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIVE_CHECKPOINT_KEYS || value.some(item => !predicate(item))) {
    throw new Error(`${field} must contain at most ${MAX_LIVE_CHECKPOINT_KEYS} valid checkpoint strings`);
  }
  return [...new Set(value)];
}

function validateBoolean(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function invalidResponse(requestedCount, message, extra = {}) {
  return {
    success: true,
    schema_version: LIVE_CAPTURE_SCHEMA_VERSION,
    label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
    replay_advanced: false,
    complete: false,
    partial: false,
    records: [],
    requested_count: requestedCount,
    returned_count: 0,
    seen_shape_keys_after: [],
    shape_state_initialized_after: false,
    seen_label_keys_after: [],
    label_state_initialized_after: false,
    failure: {
      code: 'invalid_live_capture_response',
      stage: 'node_validation',
      message,
      ...extra,
    },
  };
}

/**
 * Keep the Node boundary deliberately small.  The page evaluation is atomic;
 * this rejects only responses that would violate the live collector's core
 * no-active-bar/no-retroactive-event contract.
 */
export function validateLiveCaptureResult(raw, requestedCount) {
  if (!raw || typeof raw !== 'object') {
    return invalidResponse(requestedCount, 'page returned no structured result');
  }
  if (raw.schema_version !== LIVE_CAPTURE_SCHEMA_VERSION
      || raw.label_identity_version !== REPLAY_LABEL_IDENTITY_VERSION
      || raw.replay_advanced !== false) {
    return invalidResponse(requestedCount, 'page response does not declare the read-only live 0822 contract');
  }
  if (raw.complete !== true) {
    const failure = raw.failure && typeof raw.failure === 'object'
      ? raw.failure
      : { code: 'incomplete_live_capture', stage: 'page_capture', message: 'page did not return complete capture metadata' };
    return {
      ...raw,
      success: raw.success !== false,
      complete: false,
      partial: false,
      records: [],
      returned_count: 0,
      failure,
    };
  }
  if (!Array.isArray(raw.records) || raw.records.length !== requestedCount) {
    return invalidResponse(requestedCount, 'complete response has an unexpected record count');
  }
  if (typeof raw.symbol !== 'string' || raw.symbol.trim() === ''
      || typeof raw.timeframe !== 'string' || raw.timeframe.trim() === '') {
    return invalidResponse(requestedCount, 'complete response is missing the atomically read chart symbol or timeframe');
  }
  if (!Number.isSafeInteger(raw.observed_at_epoch_ms) || raw.observed_at_epoch_ms <= 0) {
    return invalidResponse(requestedCount, 'complete response is missing a positive integer stable-capture observation time');
  }
  if (!Array.isArray(raw.seen_shape_keys_after)
      || !Array.isArray(raw.seen_label_keys_after)
      || raw.seen_shape_keys_after.some(key => typeof key !== 'string')
      || raw.seen_label_keys_after.some(key => !isPersistentReplayLabelKey(key))
      || typeof raw.shape_state_initialized_after !== 'boolean'
      || typeof raw.label_state_initialized_after !== 'boolean') {
    return invalidResponse(requestedCount, 'response is missing valid persistent checkpoints');
  }
  const latest = raw.records.at(-1);
  if (!latest || latest.replay_advanced !== false || latest.target_is_latest_closed !== true
      || latest.event_eligible !== true || latest.strategy_event_eligible !== true
      || !latest.target_bar || !latest.active_bar
      || latest.target_bar.time === latest.active_bar.time
      || latest.availability_open_time !== latest.active_bar.time) {
    return invalidResponse(requestedCount, 'latest record is not the bar immediately before the active bar');
  }
  for (let index = 0; index < raw.records.length; index += 1) {
    const record = raw.records[index];
    if (!record || record.replay_advanced !== false || !record.target_bar
        || record.target_bar.time === record.active_bar?.time) {
      return invalidResponse(requestedCount, `record ${index + 1} contains an active or malformed target bar`);
    }
    if (record.symbol !== raw.symbol || record.timeframe !== raw.timeframe
        || record.target_bar.open_time !== record.target_bar.time
        || record.bar?.open_time !== record.target_bar.time
        || record.observed_at_epoch_ms !== raw.observed_at_epoch_ms) {
      return invalidResponse(requestedCount, `record ${index + 1} does not preserve the atomic chart identity or canonical bar aliases`);
    }
    if (index < raw.records.length - 1
        && (record.event_eligible !== false || record.strategy_event_eligible !== false)) {
      return invalidResponse(requestedCount, `older tail record ${index + 1} incorrectly claims causal event eligibility`);
    }
    if (record.raw_study_values?.source !== 'plot_list_closed_row'
        || record.shape_values?.source !== 'plot_list_closed_row') {
      return invalidResponse(requestedCount, `record ${index + 1} is missing PlotList closed-row features`);
    }
  }
  return raw;
}

/**
 * Build a single page-context operation.  It samples a full closed tail twice
 * (or more), resetting when either the live bar, PlotList rows, shapes, or
 * label primitive collection changes.  It never touches the Replay API.
 */
export function buildLiveCapture0822ClosedExpression({
  count,
  pollAttempts,
  pollIntervalMs,
  stablePolls,
  settleMs = DEFAULT_SETTLE_MS,
  knownLabelKeys = [],
  knownShapeKeys = [],
  shapeStateInitialized = false,
  labelStateInitialized = false,
}) {
  const is0822 = is0822ResearchStudyName.toString();
  const stableIdentity = stableReplayLabelIdentity.toString();
  return `
    (async function() {
      var requestedCount = ${count};
      var maxPollAttempts = ${pollAttempts};
      var pollIntervalMs = ${pollIntervalMs};
      var requiredStablePolls = ${stablePolls};
      var settleMs = ${settleMs};
      var schemaVersion = ${JSON.stringify(LIVE_CAPTURE_SCHEMA_VERSION)};
      var labelIdentityVersion = ${JSON.stringify(REPLAY_LABEL_IDENTITY_VERSION)};
      var checkpointScope = ${JSON.stringify(LIVE_STRATEGY_CHECKPOINT_SCOPE)};
      var knownLabelKeys = ${JSON.stringify(knownLabelKeys)};
      var knownShapeKeys = ${JSON.stringify(knownShapeKeys)};
      var shapeStateInitialized = ${JSON.stringify(shapeStateInitialized)};
      var labelStateInitialized = ${JSON.stringify(labelStateInitialized)};

      ${is0822}
      ${stableIdentity}

      function sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      }
      function comparableTime(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          return Math.abs(value) > 100000000000 ? value / 1000 : value;
        }
        if (typeof value === 'string' && value.trim() !== '') {
          var parsed = Number(value);
          if (Number.isFinite(parsed)) return Math.abs(parsed) > 100000000000 ? parsed / 1000 : parsed;
        }
        return null;
      }
      function sameTime(left, right) {
        var a = comparableTime(left);
        var b = comparableTime(right);
        return a !== null && b !== null && a === b;
      }
      function isLaterTime(left, right) {
        var a = comparableTime(left);
        var b = comparableTime(right);
        return a !== null && b !== null && a > b;
      }
      function usableValue(value) {
        return (typeof value === 'number' && Number.isFinite(value))
          || typeof value === 'string' || typeof value === 'boolean';
      }
      function usableCoreValue(value) {
        return usableValue(value) && (typeof value !== 'string' || value.trim() !== '');
      }
      function safeShapeValue(value) {
        return value === null || usableValue(value);
      }
      function canonicalValue(value) {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (typeof value === 'number') return Number.isFinite(value) ? 'number:' + String(value) : null;
        if (typeof value === 'string') return 'string:' + value;
        if (typeof value === 'boolean') return 'boolean:' + String(value);
        return null;
      }
      function failure(code, stage, message, extra) {
        var result = { code: code, stage: stage, message: message };
        if (extra && typeof extra === 'object') {
          Object.keys(extra).forEach(function(key) { result[key] = extra[key]; });
        }
        return result;
      }
      function result(records, failureValue, observation, seenShapes, seenLabels) {
        return {
          success: true,
          schema_version: schemaVersion,
          label_identity_version: labelIdentityVersion,
          replay_advanced: false,
          complete: !failureValue,
          partial: false,
          capture_contract: schemaVersion,
          capture_transport: 'data_capture_0822_closed',
          checkpoint_scope: checkpointScope,
          checkpoint_semantics: 'causal_live_closed_tail_only',
          records: records || [],
          requested_count: requestedCount,
          returned_count: records ? records.length : 0,
          active_bar: observation ? observation.active_bar : null,
          symbol: observation ? observation.chart_identity.symbol : null,
          timeframe: observation ? observation.chart_identity.timeframe : null,
          resolution: observation ? observation.chart_identity.resolution : null,
          observed_at_epoch_ms: observation ? observation.observed_at_epoch_ms : null,
          latest_closed_open_time: observation ? observation.latest_closed_open_time : null,
          availability_open_time: observation ? observation.availability_open_time : null,
          stable_polls: observation ? observation.stable_polls : 0,
          seen_shape_keys_after: Array.from(seenShapes || []).sort(),
          shape_state_initialized_after: shapeStateInitialized,
          seen_label_keys_after: Array.from(seenLabels || []).sort(),
          label_state_initialized_after: labelStateInitialized,
          failure: failureValue || null,
        };
      }
      function safeStudyName(source) {
        try {
          var meta = source.metaInfo();
          return meta.description || meta.shortDescription || '';
        } catch (error) {
          return '';
        }
      }
      function sourceVisible(source) {
        try { return typeof source.isVisible !== 'function' || source.isVisible(); }
        catch (error) { return true; }
      }
      function chartSources() {
        try {
          return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget
            .model().model().dataSources();
        } catch (error) {
          return null;
        }
      }
      function chartIdentity() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var symbol = typeof chart.symbol === 'function' ? chart.symbol() : null;
          var timeframe = typeof chart.resolution === 'function' ? chart.resolution() : null;
          if (typeof symbol !== 'string' || symbol.trim() === ''
              || typeof timeframe !== 'string' || timeframe.trim() === '') return null;
          return { symbol: symbol, timeframe: timeframe, resolution: timeframe };
        } catch (error) {
          return null;
        }
      }
      function mainSeriesBars() {
        try {
          return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget
            .model().mainSeries().bars();
        } catch (error) {
          return null;
        }
      }
      function readRecentBars(limit) {
        try {
          var bars = mainSeriesBars();
          if (!bars || typeof bars.lastIndex !== 'function' || typeof bars.firstIndex !== 'function'
              || typeof bars.valueAt !== 'function') return [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - limit + 1);
          var result = [];
          for (var index = start; index <= end; index += 1) {
            var row = bars.valueAt(index);
            if (!row) continue;
            var bar = { time: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] || 0 };
            if (comparableTime(bar.time) === null
                || !Number.isFinite(Number(bar.open)) || !Number.isFinite(Number(bar.high))
                || !Number.isFinite(Number(bar.low)) || !Number.isFinite(Number(bar.close))
                || !Number.isFinite(Number(bar.volume))) return [];
            result.push(bar);
          }
          return result;
        } catch (error) {
          return [];
        }
      }
      function activeLogicalIndexForTime(openTime) {
        try {
          var bars = mainSeriesBars();
          if (!bars || typeof bars.searchByTime !== 'function') return null;
          var found = bars.searchByTime(openTime);
          return found && Number.isInteger(found.index) && found.value && sameTime(found.value[0], openTime)
            ? found.index : null;
        } catch (error) {
          return null;
        }
      }
      function isTrend0822(name) {
        return is0822ResearchStudyName(name) && String(name).indexOf('趋势过滤器') !== -1;
      }
      function isSwing0822(name) {
        return is0822ResearchStudyName(name) && String(name).indexOf('波段过滤器') !== -1;
      }
      function compactTitle(value) {
        return String(value === undefined || value === null ? '' : value)
          .replace(/[\\s_－-]/g, '').toUpperCase();
      }
      function trendCoreKey(title) {
        var normalized = compactTitle(title);
        var emaAliases = { EMA21: 'EMA1', EMA55: 'EMA2', EMA100: 'EMA3', EMA200: 'EMA4' };
        if (emaAliases[normalized]) return emaAliases[normalized];
        if (normalized === 'EMA1' || normalized === 'EMA2' || normalized === 'EMA3' || normalized === 'EMA4') return normalized;
        var aliases = {
          TL: 'TL', 顺势多: 'TL', TS: 'TS', 顺势空: 'TS', PB: 'PB', 回调: 'PB',
          RB: 'RB', 反弹: 'RB', RL: 'RL', 区间反弹: 'RL', RS: 'RS', 区间回落: 'RS',
          TZ: 'TZ', 潜在顶部: 'TZ', BZ: 'BZ', 潜在底部: 'BZ'
        };
        return aliases[normalized] || null;
      }
      function swingCoreKey(title) {
        var normalized = compactTitle(title);
        if (normalized.indexOf('背离线') !== -1) return 'DIVERGENCE_LINE';
        if (normalized.indexOf('超买区域') !== -1) return 'OVERBOUGHT_ZONE';
        if (normalized.indexOf('超卖区域') !== -1) return 'OVERSOLD_ZONE';
        return null;
      }
      function coreKeyForStudy(name, title) {
        return isTrend0822(name) ? trendCoreKey(title) : (isSwing0822(name) ? swingCoreKey(title) : null);
      }
      function coreSnapshot(title, value, definition) {
        var absent = value === undefined || value === null || value === '∅';
        var result = {
          title: String(title),
          value_present: !absent,
          value: absent ? null : value,
          plot_id: definition.plot_id,
          row_index: definition.row_index,
          mapping_source: definition.mapping_source,
        };
        if (!absent && !usableValue(value)) {
          result.value_present = false;
          result.value = null;
          result.value_invalid = true;
        }
        return result;
      }
      function setCoreField(fields, key, title, value, definition) {
        if (!key) return;
        var next = coreSnapshot(title, value, definition);
        var current = fields[key];
        if (!current || (!current.value_present && next.value_present)) fields[key] = next;
      }
      function coreFieldsComplete(name, fields) {
        function hasValue(key) {
          var field = fields[key];
          return !!(field && field.value_present === true && usableCoreValue(field.value));
        }
        function hasSignal(key) {
          var field = fields[key];
          return !!(field && typeof field.value_present === 'boolean' && field.value_invalid !== true
            && (field.value_present !== true || usableValue(field.value)));
        }
        if (isTrend0822(name)) {
          var ema = ['EMA1', 'EMA2', 'EMA3', 'EMA4'];
          var signals = ['TL', 'TS', 'PB', 'RB', 'RL', 'RS', 'TZ', 'BZ'];
          for (var index = 0; index < ema.length; index += 1) if (!hasValue(ema[index])) return false;
          for (var signalIndex = 0; signalIndex < signals.length; signalIndex += 1) {
            if (!hasSignal(signals[signalIndex])) return false;
          }
          return true;
        }
        if (isSwing0822(name)) {
          var swing = ['DIVERGENCE_LINE', 'OVERBOUGHT_ZONE', 'OVERSOLD_ZONE'];
          for (var swingIndex = 0; swingIndex < swing.length; swingIndex += 1) {
            if (!hasValue(swing[swingIndex])) return false;
          }
          return true;
        }
        return false;
      }
      function studyCoreDefinitions(meta, name) {
        var plots = meta && Array.isArray(meta.plots) ? meta.plots : [];
        var styles = meta && meta.styles && typeof meta.styles === 'object' ? meta.styles : {};
        var definitions = [];
        for (var index = 0; index < plots.length; index += 1) {
          var plot = plots[index];
          if (!plot) continue;
          if (isTrend0822(name) && String(plot.type || '').toLowerCase() === 'colorer') continue;
          var style = styles[plot.id] || {};
          var candidates = [style.title, style.text, plot.title, plot.id];
          var key = null;
          var title = '';
          for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
            var candidate = candidates[candidateIndex];
            if (candidate === undefined || candidate === null || candidate === '') continue;
            key = coreKeyForStudy(name, candidate);
            if (key) { title = String(candidate); break; }
          }
          if (key) definitions.push({
            core_key: key,
            title: title || key,
            plot_id: String(plot.id || ''),
            row_index: index + 1,
            mapping_source: 'meta_title_alias',
          });
        }
        // The verified 0822 Trend layout includes colorer columns.  This
        // fallback is only used when metadata omits an EMA title, and retains
        // the original PlotList column positions used by the replay capture.
        if (isTrend0822(name)) {
          var fallback = [
            { core_key: 'EMA1', title: 'EMA21', plot_id: 'plot_0', row_index: 1 },
            { core_key: 'EMA2', title: 'EMA55', plot_id: 'plot_2', row_index: 3 },
            { core_key: 'EMA3', title: 'EMA100', plot_id: 'plot_4', row_index: 5 },
            { core_key: 'EMA4', title: 'EMA200', plot_id: 'plot_6', row_index: 7 },
          ];
          var plotIds = {};
          for (var plotIndex = 0; plotIndex < plots.length; plotIndex += 1) {
            if (plots[plotIndex] && plots[plotIndex].id !== undefined && plots[plotIndex].id !== null) {
              plotIds[String(plots[plotIndex].id)] = true;
            }
          }
          for (var fallbackIndex = 0; fallbackIndex < fallback.length; fallbackIndex += 1) {
            var fallbackDefinition = fallback[fallbackIndex];
            if (!plotIds[fallbackDefinition.plot_id]) continue;
            var currentIndex = -1;
            var exactIndex = -1;
            for (var definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
              var definition = definitions[definitionIndex];
              if (definition.core_key !== fallbackDefinition.core_key) continue;
              if (currentIndex === -1) currentIndex = definitionIndex;
              if (definition.plot_id === fallbackDefinition.plot_id) { exactIndex = definitionIndex; break; }
            }
            if (exactIndex !== -1) continue;
            if (currentIndex !== -1) definitions.splice(currentIndex, 1);
            definitions.push({
              core_key: fallbackDefinition.core_key,
              title: fallbackDefinition.title,
              plot_id: fallbackDefinition.plot_id,
              row_index: fallbackDefinition.row_index,
              mapping_source: 'trend0822_fixed_plot_id_fallback',
            });
          }
        }
        return definitions;
      }
      function shapeCode(style) {
        var title = String((style && (style.title || style.text)) || '').trim();
        var codes = {
          顺势多: 'TL', TL: 'TL', 顺势空: 'TS', TS: 'TS', 回调: 'PB', PB: 'PB',
          反弹: 'RB', RB: 'RB', 区间反弹: 'RL', RL: 'RL', 区间回落: 'RS', RS: 'RS',
          潜在顶部: 'TZ', TZ: 'TZ', 潜在底部: 'BZ', BZ: 'BZ'
        };
        return codes[title] || null;
      }
      function trendShapeDefinitions(meta) {
        var plots = meta && Array.isArray(meta.plots) ? meta.plots : [];
        var styles = meta && meta.styles && typeof meta.styles === 'object' ? meta.styles : {};
        var definitions = [];
        for (var index = 0; index < plots.length; index += 1) {
          var plot = plots[index];
          if (!plot) continue;
          var style = styles[plot.id] || {};
          var code = shapeCode(style);
          if (!code) continue;
          definitions.push({
            plot_id: String(plot.id || ''), row_index: index + 1, code: code,
            title: style.title === undefined || style.title === null ? '' : String(style.title),
            text: style.text === undefined || style.text === null ? '' : String(style.text),
          });
        }
        return definitions;
      }
      function readClosedStudyRow(source, name, targetOpenTime) {
        var result = {
          name: name,
          study_value_source: 'plot_list_closed_row',
          observed_open_time: targetOpenTime,
          row_time: null,
          target_row_read_ok: false,
          data_window_read_ok: false,
          data_window_core_ok: false,
          core_fields: {},
          values: {},
          reason: null,
        };
        try {
          var definitions = studyCoreDefinitions(source.metaInfo(), name);
          if (definitions.length === 0) { result.reason = 'core_plot_definitions_unavailable'; return result; }
          var data = source._data;
          if (!data || typeof data.searchByTime !== 'function') { result.reason = 'study_plot_list_unavailable'; return result; }
          var found = data.searchByTime(targetOpenTime);
          var row = found && found.value;
          if (!found || !Array.isArray(row) || !sameTime(row[0], targetOpenTime)) {
            result.reason = 'closed_study_row_unavailable'; return result;
          }
          result.row_time = row[0];
          result.target_row_read_ok = true;
          result.data_window_read_ok = true;
          for (var index = 0; index < definitions.length; index += 1) {
            var definition = definitions[index];
            var value = definition.row_index < row.length ? row[definition.row_index] : undefined;
            setCoreField(result.core_fields, definition.core_key, definition.title, value, definition);
            if (value !== undefined && value !== null && value !== '∅' && !usableValue(value)) {
              result.data_window_read_ok = false;
              result.reason = 'closed_study_row_value_invalid';
            }
          }
          result.data_window_core_ok = result.data_window_read_ok && coreFieldsComplete(name, result.core_fields);
          if (!result.data_window_core_ok && result.reason === null) result.reason = 'closed_study_row_core_unavailable';
          Object.keys(result.core_fields).forEach(function(key) {
            var field = result.core_fields[key];
            if (field.value_present === true) result.values[key] = field.value;
          });
          return result;
        } catch (error) {
          result.reason = 'closed_study_row_read_error';
          return result;
        }
      }
      function readTrendShapeRow(source, name, targetOpenTime) {
        var result = {
          source: name,
          study_name: name,
          active_open_time: targetOpenTime,
          history_calculation_may_change: false,
          available: false,
          reason: null,
          row_index: null,
          row_time: null,
          shape_fields: [],
          study_value_source: 'plot_list_closed_row',
          target_row_read_ok: false,
        };
        try {
          var meta = source.metaInfo();
          var definitions = trendShapeDefinitions(meta);
          result.history_calculation_may_change = !!(meta && meta.historyCalculationMayChange);
          if (definitions.length === 0) { result.reason = 'shape_plots_unavailable'; return result; }
          var data = source._data;
          if (!data || typeof data.searchByTime !== 'function') { result.reason = 'plot_list_unavailable'; return result; }
          var found = data.searchByTime(targetOpenTime);
          var row = found && found.value;
          if (!found || !Array.isArray(row) || !sameTime(row[0], targetOpenTime)) {
            result.reason = 'closed_shape_row_unavailable'; return result;
          }
          var fields = [];
          for (var index = 0; index < definitions.length; index += 1) {
            var definition = definitions[index];
            var hasValue = definition.row_index < row.length;
            var value = hasValue ? row[definition.row_index] : null;
            if (!hasValue || !safeShapeValue(value)) {
              result.reason = !hasValue ? 'closed_shape_row_truncated' : 'closed_shape_row_value_invalid';
              return result;
            }
            fields.push({
              plot_id: definition.plot_id, row_index: definition.row_index, code: definition.code,
              title: definition.title, text: definition.text, value_present: true, value: value,
              value_invalid: false,
            });
          }
          result.available = true;
          result.target_row_read_ok = true;
          result.row_index = found.index === undefined || found.index === null ? null : found.index;
          result.row_time = row[0];
          result.shape_fields = fields;
          return result;
        } catch (error) {
          result.reason = 'closed_shape_row_read_error';
          return result;
        }
      }
      function readClosedStudySnapshot(targetOpenTime) {
        var values = [];
        var shapes = [];
        var trendCount = 0;
        var swingCount = 0;
        var sources = chartSources();
        if (!Array.isArray(sources)) return { ok: false, reason: 'chart_sources_unavailable' };
        for (var index = 0; index < sources.length; index += 1) {
          var source = sources[index];
          if (!source || !source.metaInfo || !sourceVisible(source)) continue;
          var name = safeStudyName(source);
          if (!isTrend0822(name) && !isSwing0822(name)) continue;
          var study = readClosedStudyRow(source, name, targetOpenTime);
          if (!study.target_row_read_ok || !study.data_window_read_ok || !study.data_window_core_ok
              || Object.keys(study.values).length === 0) {
            return { ok: false, reason: study.reason || 'closed_study_row_invalid', study_name: name };
          }
          values.push(study);
          if (isTrend0822(name)) {
            trendCount += 1;
            var shape = readTrendShapeRow(source, name, targetOpenTime);
            if (!shape.available || !shape.target_row_read_ok) {
              return { ok: false, reason: shape.reason || 'closed_shape_row_invalid', study_name: name };
            }
            shapes.push(shape);
          } else {
            swingCount += 1;
          }
        }
        if (trendCount === 0 || swingCount === 0 || shapes.length !== trendCount) {
          return { ok: false, reason: 'required_visible_0822_studies_unavailable' };
        }
        return {
          ok: true,
          raw_study_values: {
            success: true,
            observation_phase: 'closed_target_plot_list',
            observation_open_time: targetOpenTime,
            target_open_time: targetOpenTime,
            source: 'plot_list_closed_row',
            study_count: values.length,
            studies: values,
          },
          shape_values: {
            success: true,
            observation_phase: 'closed_target_plot_list',
            observation_open_time: targetOpenTime,
            target_open_time: targetOpenTime,
            source: 'plot_list_closed_row',
            study_count: shapes.length,
            studies: shapes,
          },
        };
      }
      function nonzeroShapeValue(value) {
        return (typeof value === 'number' ? Number.isFinite(value) : (typeof value === 'string' || typeof value === 'boolean'))
          && value !== null && value !== false && value !== ''
          && !(typeof value === 'number' && value === 0)
          && !(typeof value === 'string' && (value === '0' || value === '0.0'));
      }
      function shapeIdentity(studyName, plotId, signalTime, value) {
        return String(studyName) + '::' + String(plotId) + '::' + String(signalTime) + '::' + canonicalValue(value);
      }
      function scanTrendShapes(targetRows) {
        var signals = [];
        var failures = [];
        var semantic = new Set();
        if (!Array.isArray(targetRows) || targetRows.length === 0) {
          return { ok: false, reason: 'closed_tail_shape_rows_unavailable', signals: [] };
        }
        for (var targetIndex = 0; targetIndex < targetRows.length; targetIndex += 1) {
          var target = targetRows[targetIndex];
          var targetTime = target && target.target_bar ? target.target_bar.time : null;
          var studies = target && target.features && target.features.shape_values
            && Array.isArray(target.features.shape_values.studies)
            ? target.features.shape_values.studies : null;
          if (comparableTime(targetTime) === null || !studies) {
            failures.push({ study_name: null, reason: 'closed_tail_shape_row_unavailable' });
            continue;
          }
          for (var studyIndex = 0; studyIndex < studies.length; studyIndex += 1) {
            var study = studies[studyIndex];
            var name = study && (study.study_name || study.source);
            var fields = study && Array.isArray(study.shape_fields) ? study.shape_fields : null;
            if (!name || !fields) {
              failures.push({ study_name: name || null, reason: 'closed_tail_shape_fields_unavailable' });
              continue;
            }
            for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
              var field = fields[fieldIndex];
              if (!field || !field.code || !field.plot_id || !nonzeroShapeValue(field.value)) continue;
              var semanticKey = name + '::' + field.code + '::' + String(targetTime);
              if (semantic.has(semanticKey)) continue;
              semantic.add(semanticKey);
              signals.push({
                identity: shapeIdentity(name, field.plot_id, targetTime, field.value),
                study_name: name, source: name, plot_id: field.plot_id, code: field.code,
                text: field.text || field.title, title: field.title, value: field.value,
                signal_bar_time: targetTime,
                history_calculation_may_change: !!study.history_calculation_may_change,
              });
            }
          }
        }
        return failures.length === 0
          ? { ok: true, signals: signals }
          : { ok: false, reason: 'shape_signal_scan_failed', failures: failures, signals: signals };
      }
      function readLabelPrimitives(source, name) {
        if (isTrend0822(name)) {
          return { label_read_ok: true, label_collection_available: false, reason: 'trend_labels_optional_unavailable', labels: [] };
        }
        var result = { label_read_ok: false, label_collection_available: false, reason: null, labels: [] };
        try {
          var graphics = source._graphics;
          var primitives = graphics && graphics._primitivesCollection;
          var outer = primitives && primitives.dwglabels;
          var inner = outer && outer.get('labels');
          var collection = inner && inner.get(false);
          var map = collection && collection._primitivesDataById;
          if (!map || !map.forEach) { result.reason = 'dwglabels_collection_unavailable'; return result; }
          result.label_collection_available = true;
          map.forEach(function(value, id) {
            if (!value) return;
            var hasText = Object.prototype.hasOwnProperty.call(value, 't');
            var hasPrice = Object.prototype.hasOwnProperty.call(value, 'y');
            var hasX = Object.prototype.hasOwnProperty.call(value, 'x');
            var text = hasText && value.t !== undefined && value.t !== null ? String(value.t) : '';
            var price = hasPrice && value.y !== undefined && value.y !== null ? Number(value.y) : null;
            if (price !== null && !Number.isFinite(price)) { result.reason = 'label_price_invalid'; return; }
            if (text === '' && price === null) return;
            result.labels.push({
              id: id === undefined || id === null ? null : String(id), text: text,
              price: price === null ? null : Math.round(price * 100) / 100,
              x: hasX ? value.x : null, yloc: value.yl,
            });
          });
          if (result.reason === null) result.label_read_ok = true;
          return result;
        } catch (error) {
          result.reason = 'label_read_error';
          return result;
        }
      }
      function numericLabelX(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
          var parsed = Number(value); if (Number.isFinite(parsed)) return parsed;
        }
        return null;
      }
      function labelRelation(labelX, targetOpenTime, targetLogicalIndex) {
        var rawX = numericLabelX(labelX);
        var targetTime = comparableTime(targetOpenTime);
        if (rawX === null || targetTime === null) return { comparable: false, reason: 'label_x_uncomparable' };
        var normalized = Math.abs(rawX) > 100000000000 ? rawX / 1000 : rawX;
        if (Math.abs(targetTime) >= 100000000 && Math.abs(normalized) < 100000000) {
          if (!Number.isInteger(targetLogicalIndex) || !Number.isInteger(rawX)) {
            return { comparable: false, reason: 'logical_index_unavailable' };
          }
          return { comparable: true, kind: 'logical', value: rawX, active: targetLogicalIndex };
        }
        return { comparable: true, kind: 'time', value: normalized, active: targetTime };
      }
      function verifiedLogicalBar(logicalIndex) {
        try {
          var bars = mainSeriesBars();
          if (!Number.isInteger(logicalIndex) || !bars || typeof bars.valueAt !== 'function'
              || typeof bars.searchByTime !== 'function') return null;
          var row = bars.valueAt(logicalIndex);
          var seconds = row && comparableTime(row[0]);
          var found = row && bars.searchByTime(row[0]);
          if (!row || seconds === null || !Number.isInteger(seconds) || !found || found.index !== logicalIndex
              || !found.value || !sameTime(found.value[0], row[0])) return null;
          return { physical_epoch: seconds, signal_bar_time: seconds, logical_index: logicalIndex, source: 'main_series_value_at_verified' };
        } catch (error) { return null; }
      }
      function verifiedEpochBar(epoch) {
        try {
          var bars = mainSeriesBars();
          if (!Number.isInteger(epoch) || !bars || typeof bars.searchByTime !== 'function'
              || typeof bars.valueAt !== 'function') return null;
          var found = bars.searchByTime(epoch);
          var reverse = found && Number.isInteger(found.index) ? bars.valueAt(found.index) : null;
          var seconds = found && found.value ? comparableTime(found.value[0]) : null;
          if (!found || !found.value || !reverse || seconds === null || !Number.isInteger(seconds)
              || !sameTime(found.value[0], epoch) || !sameTime(reverse[0], found.value[0])) return null;
          return { physical_epoch: seconds, signal_bar_time: seconds, logical_index: found.index, source: 'main_series_epoch_verified' };
        } catch (error) { return null; }
      }
      function sourceDiscriminator(label) {
        if (label.id !== undefined && label.id !== null && String(label.id) !== '') return 'id:' + String(label.id);
        var parts = [label.x, label.text, label.price, label.yloc].map(canonicalValue);
        return parts.some(function(part) { return part === null; }) ? null : 'fallback:' + parts.join('|');
      }
      function persistentLabelIdentity(studyName, physicalEpoch, source) {
        if (!studyName || !Number.isInteger(physicalEpoch) || !source) return null;
        return '${REPLAY_PERSISTENT_LABEL_KEY_PREFIX}' + encodeURIComponent(String(studyName)) + ':'
          + String(physicalEpoch) + ':' + encodeURIComponent(String(source));
      }
      function persistentLabelSourceKey(identity) {
        try {
          var prefix = '${REPLAY_PERSISTENT_LABEL_KEY_PREFIX}';
          if (typeof identity !== 'string' || identity.indexOf(prefix) !== 0) return null;
          var body = identity.slice(prefix.length);
          var first = body.indexOf(':');
          var second = first < 0 ? -1 : body.indexOf(':', first + 1);
          if (first <= 0 || second <= first + 1 || second >= body.length - 1) return null;
          var epoch = Number(body.slice(first + 1, second));
          if (!Number.isInteger(epoch)) return null;
          return decodeURIComponent(body.slice(0, first)) + '::'
            + decodeURIComponent(body.slice(second + 1));
        } catch (error) {
          return null;
        }
      }
      function candidateLabelSourceKey(candidate) {
        if (!candidate || !candidate.study_name || !candidate.source_discriminator) return null;
        return String(candidate.study_name) + '::' + String(candidate.source_discriminator);
      }
      function resolveLabelPhysical(label, targetOpenTime, availabilityOpenTime, targetLogicalIndex, availabilityLogicalIndex) {
        var relation = labelRelation(label.x, targetOpenTime, targetLogicalIndex);
        if (!relation.comparable || relation.value > relation.active) {
          return { verified: false, relation: relation, reason: relation.comparable ? 'label_future_at_target' : relation.reason };
        }
        var physical = relation.kind === 'logical' ? verifiedLogicalBar(relation.value) : verifiedEpochBar(relation.value);
        var availabilitySeconds = comparableTime(availabilityOpenTime);
        if (!physical || (availabilitySeconds !== null && physical.physical_epoch > availabilitySeconds)) {
          return { verified: false, relation: relation, reason: 'physical_signal_epoch_unavailable' };
        }
        return {
          verified: true, relation: relation, physical_epoch: physical.physical_epoch,
          signal_bar_time: physical.signal_bar_time, logical_index: physical.logical_index,
          source: physical.source, target_logical_index: targetLogicalIndex,
          availability_logical_index: availabilityLogicalIndex,
        };
      }
      function readPineLabelSnapshot(targetOpenTime, availabilityOpenTime) {
        var sources = chartSources();
        if (!Array.isArray(sources)) return { ok: false, reason: 'chart_sources_unavailable' };
        var targetLogicalIndex = activeLogicalIndexForTime(targetOpenTime);
        var availabilityLogicalIndex = activeLogicalIndexForTime(availabilityOpenTime);
        var studies = [];
        var allLabelsByStudy = [];
        var candidates = [];
        var trendCount = 0;
        var swingCount = 0;
        for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
          var source = sources[sourceIndex];
          if (!source || !source.metaInfo || !sourceVisible(source)) continue;
          var name = safeStudyName(source);
          if (!isTrend0822(name) && !isSwing0822(name)) continue;
          var labelRead = readLabelPrimitives(source, name);
          if (!labelRead.label_read_ok) return { ok: false, reason: labelRead.reason || 'label_read_failed', study_name: name };
          var rawLabels = labelRead.labels;
          var hasNumeric = rawLabels.some(function(label) {
            return (typeof label.price === 'number' && Number.isFinite(label.price))
              || (label.text !== '' && Number.isFinite(Number(label.text)));
          });
          if (isSwing0822(name) && (!labelRead.label_collection_available || !hasNumeric)) {
            return { ok: false, reason: 'swing_label_collection_unavailable', study_name: name };
          }
          var studyCandidates = [];
          for (var labelIndex = 0; labelIndex < rawLabels.length; labelIndex += 1) {
            var label = rawLabels[labelIndex];
            var targetRelation = labelRelation(label.x, targetOpenTime, targetLogicalIndex);
            if (!targetRelation.comparable || targetRelation.value !== targetRelation.active) continue;
            var physical = resolveLabelPhysical(
              label, targetOpenTime, availabilityOpenTime, targetLogicalIndex, availabilityLogicalIndex
            );
            if (!physical.verified || physical.physical_epoch > comparableTime(targetOpenTime)) continue;
            var sourceKey = sourceDiscriminator(label);
            var identity = persistentLabelIdentity(name, physical.physical_epoch, sourceKey);
            if (!identity) continue;
            var candidate = {
              id: label.id,
              label_identity_version: labelIdentityVersion,
              label_identity: identity,
              source_label_identity: stableReplayLabelIdentity(name, label),
              source_discriminator: sourceKey,
              study_name: name,
              text: label.text,
              price: label.price,
              label_x: label.x,
              label_coordinate_kind: physical.relation.kind,
              label_coordinate_value: physical.relation.value,
              label_coordinate_active: physical.relation.active,
              label_coordinate_comparable: true,
              target_open_time: targetOpenTime,
              availability_open_time: availabilityOpenTime,
              label_physical_epoch: physical.physical_epoch,
              signal_bar_time: physical.signal_bar_time,
              signal_bar_logical_index: physical.logical_index,
              signal_time_mapping_source: physical.source,
              signal_time_mapping_verified: true,
              signal_time_mapping_logical_index: physical.logical_index,
              target_logical_index: physical.target_logical_index,
              availability_logical_index: physical.availability_logical_index,
              target_aligned: physical.relation.value === physical.relation.active,
              delayed: physical.relation.value !== physical.relation.active,
              strategy_eligible: false,
            };
            studyCandidates.push(candidate);
            candidates.push(candidate);
          }
          studies.push({
            name: name,
            label_read_ok: true,
            label_collection_available: labelRead.label_collection_available,
            label_read_reason: labelRead.reason,
            total_labels_visible_now: rawLabels.length,
            labels: studyCandidates,
          });
          allLabelsByStudy.push({
            name: name,
            target_aligned_label_identities: studyCandidates.map(function(candidate) {
              return candidate.label_identity;
            }),
          });
          if (isTrend0822(name)) trendCount += 1;
          if (isSwing0822(name)) swingCount += 1;
        }
        if (trendCount === 0 || swingCount === 0) return { ok: false, reason: 'required_label_studies_unavailable' };
        candidates.sort(function(left, right) {
          return left.label_identity < right.label_identity ? -1 : (left.label_identity > right.label_identity ? 1 : 0);
        });
        return {
          ok: true,
          candidates: candidates,
          all_labels_by_study: allLabelsByStudy,
          raw_pine_labels: {
            success: true,
            label_identity_version: labelIdentityVersion,
            observation_phase: 'live_active_after_target',
            observation_open_time: availabilityOpenTime,
            target_open_time: targetOpenTime,
            active_logical_index: availabilityLogicalIndex,
            study_count: studies.length,
            studies: studies,
          },
        };
      }
      function stableFingerprint(observation) {
        try {
          return JSON.stringify({
            chart_identity: observation.chart_identity,
            active_bar: observation.active_bar,
            targets: observation.targets.map(function(target) {
              return {
                target_bar: target.target_bar,
                next_bar: target.next_bar,
                raw_study_values: target.features.raw_study_values,
                shape_values: target.features.shape_values,
              };
            }),
            shape_scan: observation.shape_scan.signals,
            labels_visible_now: observation.labels.all_labels_by_study,
            label_candidates: observation.labels.candidates,
          });
        } catch (error) {
          return null;
        }
      }
      function observe() {
        var identity = chartIdentity();
        if (!identity) {
          return { ok: false, failure: failure('chart_identity_unavailable', 'chart_identity', 'Chart symbol or resolution could not be read atomically.') };
        }
        var bars = readRecentBars(requestedCount + 1);
        if (bars.length < requestedCount + 1) {
          return { ok: false, failure: failure('not_enough_closed_bars', 'read_bars', 'Chart does not expose the requested closed-bar tail plus an active bar.', { returned_bars: bars.length }) };
        }
        var active = bars[bars.length - 1];
        var targets = bars.slice(bars.length - requestedCount - 1, bars.length - 1);
        if (targets.length !== requestedCount || !isLaterTime(active.time, targets[targets.length - 1].time)) {
          return { ok: false, failure: failure('active_bar_unavailable', 'read_bars', 'The final chart row is not a later active bar.') };
        }
        for (var barIndex = 1; barIndex < targets.length; barIndex += 1) {
          if (!isLaterTime(targets[barIndex].time, targets[barIndex - 1].time)) {
            return { ok: false, failure: failure('bar_order_invalid', 'read_bars', 'Closed bars are not strictly chronological.') };
          }
        }
        var targetRows = [];
        for (var targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
          var target = targets[targetIndex];
          var nextBar = targetIndex + 1 < targets.length ? targets[targetIndex + 1] : active;
          var features = readClosedStudySnapshot(target.time);
          if (!features.ok) {
            return { ok: false, failure: failure('closed_plot_list_unavailable', 'read_closed_features', 'A required 0822 PlotList row is unavailable for a closed target.', { target_open_time: target.time, reason: features.reason, study_name: features.study_name || null }) };
          }
          targetRows.push({ target_bar: target, next_bar: nextBar, features: features });
        }
        var latestTarget = targetRows[targetRows.length - 1].target_bar;
        var labels = readPineLabelSnapshot(latestTarget.time, active.time);
        if (!labels.ok) {
          return { ok: false, failure: failure('pine_label_checkpoint_unavailable', 'read_labels', 'Pine label primitives could not be resolved into physical checkpoint identities.', { target_open_time: latestTarget.time, reason: labels.reason, study_name: labels.study_name || null }) };
        }
        var shapeScan = scanTrendShapes(targetRows);
        if (!shapeScan.ok) {
          return { ok: false, failure: failure('plotshape_signal_scan_failed', 'scan_shapes', 'The Trend0822 PlotList scan could not be completed.', { reason: shapeScan.reason, failures: shapeScan.failures || [] }) };
        }
        var observation = {
          ok: true,
          chart_identity: identity,
          active_bar: active,
          latest_closed_open_time: latestTarget.time,
          availability_open_time: active.time,
          targets: targetRows,
          labels: labels,
          shape_scan: shapeScan,
        };
        observation.fingerprint = stableFingerprint(observation);
        if (observation.fingerprint === null) {
          return { ok: false, failure: failure('capture_fingerprint_unavailable', 'fingerprint', 'The closed-tail evidence could not be fingerprinted safely.') };
        }
        return observation;
      }
      function materializeShapeEvents(signals, targetOpenTime, availabilityOpenTime, seen) {
        var events = [];
        var targetSeconds = comparableTime(targetOpenTime);
        var seed = !shapeStateInitialized;
        for (var index = 0; index < signals.length; index += 1) {
          var signal = signals[index];
          var signalSeconds = comparableTime(signal.signal_bar_time);
          if (!signal || !signal.identity || signalSeconds === null || targetSeconds === null || signalSeconds > targetSeconds) continue;
          if (seen.has(signal.identity)) continue;
          seen.add(signal.identity);
          var targetAligned = signalSeconds === targetSeconds;
          if (seed && !targetAligned) continue;
          events.push({
            identity: signal.identity, study_name: signal.study_name, source: signal.source,
            plot_id: signal.plot_id, code: signal.code, text: signal.text, title: signal.title,
            value: signal.value, signal_bar_time: signal.signal_bar_time,
            target_open_time: targetOpenTime, availability_open_time: availabilityOpenTime,
            first_observed_at_open_time: availabilityOpenTime,
            first_seen_semantics: 'live_checkpoint_delta_not_historical_replay',
            first_seen_historically_proven: false,
            delayed: !targetAligned, event_eligible: targetAligned,
            strategy_eligible: targetAligned,
            history_calculation_may_change: signal.history_calculation_may_change,
          });
        }
        shapeStateInitialized = true;
        return events;
      }
      function materializeLabelEvents(candidates, targetOpenTime, availabilityOpenTime, seen) {
        var events = [];
        var seeded = [];
        var seed = !labelStateInitialized;
        var seenSources = new Set();
        seen.forEach(function(identity) {
          var sourceKey = persistentLabelSourceKey(identity);
          if (sourceKey) seenSources.add(sourceKey);
        });
        for (var index = 0; index < candidates.length; index += 1) {
          var candidate = candidates[index];
          if (!candidate || !candidate.label_identity || seen.has(candidate.label_identity)) continue;
          var sourceKey = candidateLabelSourceKey(candidate);
          var sourcePreviouslySeen = sourceKey !== null && seenSources.has(sourceKey);
          seen.add(candidate.label_identity);
          if (sourceKey !== null) seenSources.add(sourceKey);
          if (seed) { seeded.push(candidate.label_identity); continue; }
          var strategyEligible = candidate.target_aligned === true && !sourcePreviouslySeen;
          events.push({
            ...candidate,
            target_open_time: targetOpenTime,
            availability_open_time: availabilityOpenTime,
            first_observed_at_open_time: availabilityOpenTime,
            first_seen_semantics: sourcePreviouslySeen
              ? 'existing_live_label_source_relocated'
              : 'first_observed_since_live_checkpoint',
            first_seen_historically_proven: false,
            source_previously_seen: sourcePreviouslySeen,
            delayed: sourcePreviouslySeen || candidate.target_aligned !== true,
            event_eligible: strategyEligible,
            strategy_eligible: strategyEligible,
          });
        }
        labelStateInitialized = true;
        return { events: events, seeded: seeded };
      }
      function fieldValue(study, key) {
        var field = study && study.core_fields ? study.core_fields[key] : null;
        return field && field.value_present === true ? field.value : null;
      }
      // A deliberately small, stable projection for the collector. The raw
      // PlotList evidence stays alongside it, so this map is never the only
      // source of truth for later research.
      function normalizedFeatures(rawStudyValues, targetOpenTime, availabilityOpenTime) {
        var studies = rawStudyValues && Array.isArray(rawStudyValues.studies)
          ? rawStudyValues.studies : [];
        var trendStudies = studies.filter(function(study) { return isTrend0822(study && study.name); });
        var swingStudies = studies.filter(function(study) { return isSwing0822(study && study.name); });
        var trend = trendStudies[0] || null;
        var swing = swingStudies[0] || null;
        return {
          TL: fieldValue(trend, 'TL'), TS: fieldValue(trend, 'TS'),
          PB: fieldValue(trend, 'PB'), RB: fieldValue(trend, 'RB'),
          RL: fieldValue(trend, 'RL'), RS: fieldValue(trend, 'RS'),
          TZ: fieldValue(trend, 'TZ'), BZ: fieldValue(trend, 'BZ'),
          ema21: fieldValue(trend, 'EMA1'), ema55: fieldValue(trend, 'EMA2'),
          ema100: fieldValue(trend, 'EMA3'), ema200: fieldValue(trend, 'EMA4'),
          ema_source_version: '0822',
          ema_source_study: trend ? trend.name : null,
          swing_value: fieldValue(swing, 'DIVERGENCE_LINE'),
          swing_overbought: fieldValue(swing, 'OVERBOUGHT_ZONE'),
          swing_oversold: fieldValue(swing, 'OVERSOLD_ZONE'),
          trend_study_names: trendStudies.map(function(study) { return study.name; }),
          swing_study_names: swingStudies.map(function(study) { return study.name; }),
          source_study_names: studies.map(function(study) { return study.name; }),
          target_open_time: targetOpenTime,
          availability_open_time: availabilityOpenTime,
        };
      }
      function buildRecords(observation, stablePollCount, quietMs, observedAtEpochMs, seenShapes, seenLabels) {
        var latest = observation.targets[observation.targets.length - 1];
        var shapeEvents = materializeShapeEvents(
          observation.shape_scan.signals, latest.target_bar.time, observation.active_bar.time, seenShapes
        );
        var labels = materializeLabelEvents(
          observation.labels.candidates, latest.target_bar.time, observation.active_bar.time, seenLabels
        );
        var shapeCheckpoint = Array.from(seenShapes).sort();
        var labelCheckpoint = Array.from(seenLabels).sort();
        var records = [];
        for (var index = 0; index < observation.targets.length; index += 1) {
          var item = observation.targets[index];
          var isLatest = item === latest;
          var targetBar = {
            time: item.target_bar.time,
            open_time: item.target_bar.time,
            open: item.target_bar.open,
            high: item.target_bar.high,
            low: item.target_bar.low,
            close: item.target_bar.close,
            volume: item.target_bar.volume,
          };
          records.push({
            schema_version: schemaVersion,
            capture_contract: schemaVersion,
            capture_kind: 'live_closed_tail',
            capture_transport: 'data_capture_0822_closed',
            checkpoint_scope: checkpointScope,
            checkpoint_semantics: 'causal_live_closed_tail_only',
            label_identity_version: labelIdentityVersion,
            capture_phase: 'live_closed_tail_stable',
            feature_phase: 'closed_target_plot_list',
            ohlcv_phase: 'closed_confirmed_tail',
            replay_advanced: false,
            sequence: index + 1,
            symbol: observation.chart_identity.symbol,
            timeframe: observation.chart_identity.timeframe,
            resolution: observation.chart_identity.resolution,
            observed_at_epoch_ms: observedAtEpochMs,
            active_bar: observation.active_bar,
            observed_active_open_time: observation.active_bar.time,
            target_open_time: targetBar.time,
            target_bar: targetBar,
            bar: {
              open_time: targetBar.time,
              open: targetBar.open,
              high: targetBar.high,
              low: targetBar.low,
              close: targetBar.close,
              volume: targetBar.volume,
            },
            confirmed_bar: targetBar,
            confirmed_closed_open_time: targetBar.time,
            availability_open_time: item.next_bar.time,
            next_active_open_time: item.next_bar.time,
            target_is_latest_closed: isLatest,
            raw_study_values: item.features.raw_study_values,
            shape_values: item.features.shape_values,
            normalized: normalizedFeatures(
              item.features.raw_study_values, targetBar.time, item.next_bar.time
            ),
            raw_pine_labels: isLatest ? observation.labels.raw_pine_labels : null,
            labels_visible_now: isLatest ? observation.labels.candidates : [],
            labels_visible_now_are_first_seen_events: false,
            newly_visible_labels: isLatest ? labels.events : [],
            new_label_events: isLatest ? labels.events : [],
            seeded_label_keys: isLatest ? labels.seeded : [],
            plotshape_signals: isLatest ? shapeEvents : [],
            new_trend_shape_events: isLatest ? shapeEvents : [],
            ...(isLatest ? {
              seen_shape_keys_after: shapeCheckpoint,
              shape_state_initialized_after: shapeStateInitialized,
              seen_label_keys_after: labelCheckpoint,
              label_state_initialized_after: labelStateInitialized,
            } : {}),
            event_eligible: isLatest,
            strategy_event_eligible: isLatest,
            event_causality: isLatest
              ? 'latest_closed_observed_at_live_active_bar'
              : 'tail_feature_only_noncausal',
            events_reconstructed: false,
            feature_stable_polls: stablePollCount,
            feature_quiet_ms: quietMs,
          });
        }
        return records;
      }

      try {
        var stable = null;
        var stableCount = 0;
        var stableSince = null;
        var lastFailure = null;
        var lastObservation = null;
        if (settleMs > 0) await sleep(settleMs);
        for (var attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
          var observation = observe();
          if (!observation.ok) {
            // Symbol/timeframe switches can expose the new chart identity before
            // all PlotList sources have repopulated. Treat that as transient and
            // keep the whole operation read-only; an exhausted retry window still
            // returns no records and therefore cannot contaminate the store.
            stable = null;
            stableCount = 0;
            stableSince = null;
            lastFailure = observation.failure;
            lastObservation = null;
            if (attempt < maxPollAttempts) await sleep(pollIntervalMs);
            continue;
          }
          if (stable && stable.fingerprint === observation.fingerprint) {
            stableCount += 1;
          } else {
            stable = observation;
            stableCount = 1;
            stableSince = Date.now();
          }
          if (stableCount >= requiredStablePolls) {
            stable.stable_polls = stableCount;
            // This is intentionally fixed once, after the full stable evidence
            // set is accepted. It is a wall-clock observation audit field, not
            // a replacement for the indicator's A=open availability semantics.
            stable.observed_at_epoch_ms = Date.now();
            var seenShapes = new Set(knownShapeKeys);
            var seenLabels = new Set(knownLabelKeys);
            var records = buildRecords(
              stable, stableCount, Date.now() - stableSince, stable.observed_at_epoch_ms, seenShapes, seenLabels
            );
            return result(records, null, stable, seenShapes, seenLabels);
          }
          lastFailure = null;
          lastObservation = {
            active_bar: observation.active_bar,
            latest_closed_open_time: observation.latest_closed_open_time,
            stable_polls: stableCount,
          };
          if (attempt < maxPollAttempts) await sleep(pollIntervalMs);
        }
        return result([], failure(
          'live_capture_not_settled', 'stability_poll',
          'The closed tail, PlotList features, shapes, or label primitive snapshot changed before the required stable polls completed.',
          {
            required_stable_polls: requiredStablePolls,
            poll_attempts: maxPollAttempts,
            last_observation: lastObservation,
            last_failure: lastFailure,
          }
        ), null, new Set(knownShapeKeys), new Set(knownLabelKeys));
      } catch (error) {
        return result([], failure('live_capture_exception', 'page_capture', String(error && error.message ? error.message : error)), null, new Set(knownShapeKeys), new Set(knownLabelKeys));
      }
    })()
  `;
}

export async function capture0822Closed({
  count,
  poll_attempts,
  poll_interval_ms,
  stable_polls,
  settle_ms,
  known_label_keys,
  known_shape_keys,
  shape_state_initialized,
  label_state_initialized,
  _deps,
} = {}) {
  const requestedCount = validateLiveCaptureCount(count);
  const pollAttempts = validateInteger(poll_attempts, DEFAULT_POLL_ATTEMPTS, 2, 80, 'poll_attempts');
  const pollIntervalMs = validateInteger(poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 25, 2000, 'poll_interval_ms');
  const stablePolls = validateInteger(stable_polls, DEFAULT_STABLE_POLLS, 2, 12, 'stable_polls');
  const settleMs = validateInteger(settle_ms, DEFAULT_SETTLE_MS, 0, 10000, 'settle_ms');
  if (pollAttempts < stablePolls) throw new Error('poll_attempts must be greater than or equal to stable_polls');
  const knownLabelKeys = validateCheckpointKeys(
    known_label_keys, 'known_label_keys', isPersistentReplayLabelKey
  );
  const knownShapeKeys = validateCheckpointKeys(known_shape_keys, 'known_shape_keys');
  const shapeStateInitialized = validateBoolean(shape_state_initialized, false, 'shape_state_initialized');
  const labelStateInitialized = validateBoolean(label_state_initialized, false, 'label_state_initialized');
  if (!shapeStateInitialized && knownShapeKeys.length > 0) {
    throw new Error('known_shape_keys must be empty when shape_state_initialized is false');
  }
  if (!labelStateInitialized && knownLabelKeys.length > 0) {
    throw new Error('known_label_keys must be empty when label_state_initialized is false');
  }
  const { evaluateAsync } = resolve(_deps);
  const raw = await evaluateAsync(buildLiveCapture0822ClosedExpression({
    count: requestedCount,
    pollAttempts,
    pollIntervalMs,
    stablePolls,
    settleMs,
    knownLabelKeys,
    knownShapeKeys,
    shapeStateInitialized,
    labelStateInitialized,
  }));
  return validateLiveCaptureResult(raw, requestedCount);
}
