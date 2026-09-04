/**
 * Exact, read-only crosshair positioning for the active TradingView pane.
 *
 * PlotList is the normal historical data path. This module is deliberately a
 * narrow verification fallback: it moves the crosshair with one CDP
 * mouseMoved event, then proves that TradingView applied that exact bar before
 * returning a stable Data Window observation. It never clicks, changes Replay,
 * or guesses that a coordinate was accepted.
 */
import { evaluateAsync as _evaluateAsync, getClient as _getClient } from '../connection.js';

export const HOVER_BAR_CAPTURE_MODE = 'data_window_hover';
export const MAX_HOVER_BAR_OFFSET = 5000;

const DEFAULT_STABLE_POLLS = 2;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 2000;

function resolve(deps) {
  return {
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

function asInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function asOptionalTime(value, field) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a finite unix timestamp`);
  return parsed;
}

function asStudyFilters(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('study_filters must be an array of non-empty strings');
  }
  return value.map(item => item.trim());
}

export function parseHoverBarOptions({
  time,
  bars_ago,
  study_filters,
  stable_polls,
  poll_interval_ms,
  timeout_ms,
} = {}) {
  const hasTime = time !== undefined && time !== null;
  const hasBarsAgo = bars_ago !== undefined && bars_ago !== null;
  if (hasTime === hasBarsAgo) {
    throw new Error('exactly one of time or bars_ago is required');
  }
  const stablePolls = asInteger(stable_polls, DEFAULT_STABLE_POLLS, 2, 12, 'stable_polls');
  const pollIntervalMs = asInteger(
    poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 25, 2000, 'poll_interval_ms'
  );
  const timeoutMs = asInteger(timeout_ms, DEFAULT_TIMEOUT_MS, 100, 10000, 'timeout_ms');
  return {
    time: hasTime ? asOptionalTime(time, 'time') : null,
    bars_ago: hasBarsAgo
      ? asInteger(bars_ago, null, 0, MAX_HOVER_BAR_OFFSET, 'bars_ago')
      : null,
    study_filters: asStudyFilters(study_filters),
    stable_polls: stablePolls,
    poll_interval_ms: pollIntervalMs,
    timeout_ms: timeoutMs,
    poll_attempts: Math.max(stablePolls, Math.floor(timeoutMs / pollIntervalMs) + 1),
  };
}

function failClosed(code, message, extra = {}) {
  return {
    success: false,
    capture_mode: HOVER_BAR_CAPTURE_MODE,
    identity_verified: false,
    error: message,
    failure: { code, message, ...extra },
    studies: [],
  };
}

function comparableTime(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.abs(parsed) > 100000000000 ? parsed / 1000 : parsed;
}

function pageHelpers() {
  return `
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
      function fail(code, message, extra) {
        var result = {
          success: false,
          capture_mode: 'data_window_hover',
          identity_verified: false,
          error: message,
          failure: { code: code, message: message },
          studies: []
        };
        if (extra && typeof extra === 'object') {
          Object.keys(extra).forEach(function(key) { result.failure[key] = extra[key]; });
        }
        return result;
      }
      function unwrap(value) {
        if (value && typeof value === 'object' && typeof value.value === 'function') {
          return value.value();
        }
        return value;
      }
      function replayActive() {
        try {
          var replay = window.TradingViewApi._replayApi;
          if (!replay || typeof replay.isReplayStarted !== 'function') return null;
          var started = unwrap(replay.isReplayStarted());
          return typeof started === 'boolean' ? started : null;
        } catch (error) {
          return null;
        }
      }
      function activeChart() {
        try { return window.TradingViewApi._activeChartWidgetWV.value(); }
        catch (error) { return null; }
      }
      function widgetFor(chart) {
        return chart && chart._chartWidget ? chart._chartWidget : chart;
      }
      function chartModel(chart) {
        try {
          var widget = widgetFor(chart);
          return widget && typeof widget.model === 'function' ? widget.model() : null;
        } catch (error) {
          return null;
        }
      }
      function mainSeries(model) {
        try { return model && typeof model.mainSeries === 'function' ? model.mainSeries() : null; }
        catch (error) { return null; }
      }
      function mainSeriesBars(model) {
        try {
          var series = mainSeries(model);
          return series && typeof series.bars === 'function' ? series.bars() : null;
        } catch (error) {
          return null;
        }
      }
      function chartSources(model) {
        try {
          var inner = model && typeof model.model === 'function' ? model.model() : null;
          return inner && typeof inner.dataSources === 'function' ? inner.dataSources() : null;
        } catch (error) {
          return null;
        }
      }
      function chartIdentity(chart, model) {
        try {
          var series = mainSeries(model);
          var symbol = chart && typeof chart.symbol === 'function' ? chart.symbol()
            : (series && typeof series.symbol === 'function' ? series.symbol() : null);
          var timeframe = chart && typeof chart.resolution === 'function' ? chart.resolution()
            : (series && typeof series.interval === 'function' ? series.interval() : null);
          if (typeof symbol !== 'string' || symbol.trim() === ''
              || typeof timeframe !== 'string' || timeframe.trim() === '') return null;
          return { symbol: symbol, timeframe: timeframe };
        } catch (error) {
          return null;
        }
      }
      function sourceVisible(source) {
        try { return typeof source.isVisible !== 'function' || source.isVisible(); }
        catch (error) { return false; }
      }
      function sourceName(source) {
        try {
          var meta = source.metaInfo();
          var name = meta && (meta.description || meta.shortDescription);
          return typeof name === 'string' && name.trim() !== '' ? name : null;
        } catch (error) {
          return null;
        }
      }
      function sourceEntityId(chart, source, name) {
        try {
          if (typeof source.id === 'function') {
            var direct = source.id();
            if (direct !== undefined && direct !== null && String(direct).trim() !== '') return String(direct);
          } else if (source.id !== undefined && source.id !== null && String(source.id).trim() !== '') {
            return String(source.id);
          }
        } catch (error) {}
        try {
          var listed = chart && typeof chart.getAllStudies === 'function' ? chart.getAllStudies() : null;
          if (Array.isArray(listed)) {
            for (var index = 0; index < listed.length; index += 1) {
              var item = listed[index];
              if (item && (item.name === name || item.title === name)
                  && item.id !== undefined && item.id !== null && String(item.id).trim() !== '') {
                return String(item.id);
              }
            }
          }
        } catch (error) {}
        return null;
      }
      function matchesFilters(name, filters) {
        if (!filters || filters.length === 0) return true;
        for (var index = 0; index < filters.length; index += 1) {
          if (name.indexOf(filters[index]) !== -1) return true;
        }
        return false;
      }
      function selectStudies(chart, sources, filters) {
        if (!Array.isArray(sources)) {
          return { error: fail('chart_sources_unavailable', 'Chart data sources are unavailable') };
        }
        var selected = [];
        var seenIds = {};
        for (var index = 0; index < sources.length; index += 1) {
          var source = sources[index];
          if (!source || !sourceVisible(source)) continue;
          var name = sourceName(source);
          if (!name || !matchesFilters(name, filters)) continue;
          var entityId = sourceEntityId(chart, source, name);
          if (typeof entityId !== 'string' || entityId.trim() === '') {
            return { error: fail('study_identity_unavailable', 'A target study is missing entity_id', {
              study_name: name
            }) };
          }
          if (seenIds[entityId]) {
            return { error: fail('study_identity_duplicate', 'Target studies share the same entity_id', {
              entity_id: entityId,
              study_name: name
            }) };
          }
          seenIds[entityId] = true;
          selected.push({ source: source, entity_id: entityId, name: name });
        }
        if (filters && filters.length > 0) {
          if (selected.length === 0) {
            return { error: fail('no_matching_study', 'No visible study matched study_filters') };
          }
          for (var filterIndex = 0; filterIndex < filters.length; filterIndex += 1) {
            var found = false;
            for (var selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
              if (selected[selectedIndex].name.indexOf(filters[filterIndex]) !== -1) { found = true; break; }
            }
            if (!found) {
              return { error: fail('no_matching_study', 'No visible study matched study_filters', {
                study_filter: filters[filterIndex]
              }) };
            }
          }
        }
        return { studies: selected };
      }
      function studyIdentity(studies) {
        return studies.map(function(study) {
          return { entity_id: study.entity_id, name: study.name };
        });
      }
      function sameStudyIdentity(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (var index = 0; index < left.length; index += 1) {
          if (!left[index] || !right[index]
              || left[index].entity_id !== right[index].entity_id
              || left[index].name !== right[index].name) return false;
        }
        return true;
      }
      function serializableValue(value) {
        if (value === undefined || value === null || value === '∅') return { ok: true, value: null };
        if (typeof value === 'number') {
          return Number.isFinite(value) ? { ok: true, value: value } : { ok: false };
        }
        if (typeof value === 'string' || typeof value === 'boolean') return { ok: true, value: value };
        return { ok: false };
      }
      function serializeBar(row) {
        if (!Array.isArray(row) || row.length < 5) return null;
        var time = comparableTime(row[0]);
        var open = Number(row[1]);
        var high = Number(row[2]);
        var low = Number(row[3]);
        var close = Number(row[4]);
        if (time === null || !Number.isFinite(open) || !Number.isFinite(high)
            || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        var volume = row.length > 5 && row[5] !== undefined && row[5] !== null ? Number(row[5]) : null;
        if (volume !== null && !Number.isFinite(volume)) return null;
        return { time: time, open: open, high: high, low: low, close: close, volume: volume };
      }
      function locateTarget(bars, selector, referenceTime) {
        if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function'
            || typeof bars.valueAt !== 'function' || typeof bars.searchByTime !== 'function') {
          return { error: fail('main_series_unavailable', 'Main series bars are unavailable') };
        }
        var first = bars.firstIndex();
        var last = bars.lastIndex();
        if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) {
          return { error: fail('main_series_unavailable', 'Main series has no readable index range') };
        }
        var activeRow = bars.valueAt(last);
        var activeTime = activeRow ? comparableTime(activeRow[0]) : null;
        if (activeTime === null) return { error: fail('active_bar_unavailable', 'Active bar time is unavailable') };
        var targetIndex = null;
        var targetTime = referenceTime;
        if (targetTime !== null && targetTime !== undefined) {
          var referenced = bars.searchByTime(targetTime);
          if (!referenced || !Number.isInteger(referenced.index) || !referenced.value
              || !sameTime(referenced.value[0], targetTime)) {
            return { error: fail('bar_not_found', 'Requested bar is no longer loaded on the main series', {
              time: targetTime
            }) };
          }
          targetIndex = referenced.index;
        } else if (selector.time !== null && selector.time !== undefined) {
          var wanted = comparableTime(selector.time);
          var found = wanted === null ? null : bars.searchByTime(wanted);
          if (!found || !Number.isInteger(found.index) || !found.value || !sameTime(found.value[0], wanted)) {
            return { error: fail('bar_not_found', 'Requested time was not found on the main series', {
              time: selector.time
            }) };
          }
          targetIndex = found.index;
          targetTime = comparableTime(found.value[0]);
        } else {
          targetIndex = last - selector.barsAgo;
          var targetRow = bars.valueAt(targetIndex);
          targetTime = targetRow ? comparableTime(targetRow[0]) : null;
        }
        if (!Number.isInteger(targetIndex) || targetIndex < first || targetIndex > last || targetTime === null) {
          return { error: fail('bar_not_found', 'Requested time or bars_ago is outside the loaded main series') };
        }
        var row = bars.valueAt(targetIndex);
        var bar = serializeBar(row);
        if (!bar || !sameTime(bar.time, targetTime)) {
          return { error: fail('bar_incomplete', 'Requested main-series bar is incomplete') };
        }
        return {
          first_index: first,
          last_index: last,
          active_bar_time: activeTime,
          target_index: targetIndex,
          target_bar_time: targetTime,
          bar: bar
        };
      }
      function paneRect(widget) {
        try {
          var pane = widget && widget._mainDiv;
          if (!pane || typeof pane.getBoundingClientRect !== 'function') return null;
          var rect = pane.getBoundingClientRect();
          var left = Number(rect && (rect.left === undefined ? rect.x : rect.left));
          var top = Number(rect && (rect.top === undefined ? rect.y : rect.top));
          var width = Number(rect && rect.width);
          var height = Number(rect && rect.height);
          if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width)
              || !Number.isFinite(height) || width <= 2 || height <= 2) return null;
          return { left: left, top: top, width: width, height: height };
        } catch (error) {
          return null;
        }
      }
      function timeScale(model) {
        try { return model && typeof model.timeScale === 'function' ? model.timeScale() : null; }
        catch (error) { return null; }
      }
      function coordinateForIndex(scale, index) {
        try {
          if (!scale || typeof scale.indexToCoordinate !== 'function') return null;
          var coordinate = Number(scale.indexToCoordinate(index));
          return Number.isFinite(coordinate) ? coordinate : null;
        } catch (error) {
          return null;
        }
      }
      function appliedCrosshairIndex(model) {
        try {
          if (!model || typeof model.crossHairSource !== 'function') return null;
          var source = model.crossHairSource();
          if (!source || typeof source.appliedIndex !== 'function') return null;
          var index = unwrap(source.appliedIndex());
          return Number.isInteger(index) ? index : null;
        } catch (error) {
          return null;
        }
      }
      function readDataWindows(studies) {
        var output = [];
        for (var studyIndex = 0; studyIndex < studies.length; studyIndex += 1) {
          var study = studies[studyIndex];
          var items;
          try {
            var view = study.source.dataWindowView();
            items = view && typeof view.items === 'function' ? view.items() : null;
          } catch (error) {
            items = null;
          }
          if (!items || typeof items.length !== 'number' || items.length < 0) {
            return { error: fail('data_window_unavailable', 'A target study Data Window is unavailable', {
              study_name: study.name,
              entity_id: study.entity_id
            }) };
          }
          var values = [];
          for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            var item = items[itemIndex];
            if (!item || typeof item._title !== 'string' || item._title.trim() === '') {
              return { error: fail('data_window_unavailable', 'A target study Data Window item has no title', {
                study_name: study.name,
                entity_id: study.entity_id
              }) };
            }
            var value = serializableValue(item._value);
            if (!value.ok) {
              return { error: fail('data_window_value_invalid', 'A target study Data Window item is not serializable', {
                study_name: study.name,
                entity_id: study.entity_id,
                title: item._title
              }) };
            }
            values.push({ title: item._title, value: value.value });
          }
          output.push({ entity_id: study.entity_id, name: study.name, values: values });
        }
        return { studies: output };
      }
  `;
}

export function buildHoverBarPositionExpression(options) {
  const payload = JSON.stringify({
    time: options.time,
    barsAgo: options.bars_ago,
    studyFilters: options.study_filters,
    pollIntervalMs: options.poll_interval_ms,
    pollAttempts: options.poll_attempts,
  });
  return `
    (async function() {
      var opt = ${payload};
      ${pageHelpers()}
      var referenceTime = null;
      var referenceIdentity = null;
      var viewportAdjusted = false;
      for (var attempt = 0; attempt < opt.pollAttempts; attempt += 1) {
        var replayStarted = replayActive();
        if (replayStarted === null) return fail('replay_state_unavailable', 'Replay state is unavailable');
        if (replayStarted) return fail('replay_active', 'chart_hover_bar is unavailable while Replay is active');
        var chart = activeChart();
        var widget = widgetFor(chart);
        var model = chartModel(chart);
        if (!chart || !widget || !model) return fail('chart_unavailable', 'Active chart widget is unavailable');
        var identity = chartIdentity(chart, model);
        if (!identity) return fail('identity_unavailable', 'Chart symbol/timeframe identity is unavailable');
        if (referenceIdentity && (referenceIdentity.symbol !== identity.symbol
            || referenceIdentity.timeframe !== identity.timeframe)) {
          return fail('identity_mismatch', 'Chart symbol/timeframe changed while positioning the crosshair', {
            previous: referenceIdentity,
            current: identity
          });
        }
        referenceIdentity = identity;
        var located = locateTarget(mainSeriesBars(model), {
          time: opt.time,
          barsAgo: opt.barsAgo
        }, referenceTime);
        if (located.error) return located.error;
        referenceTime = located.target_bar_time;
        var rect = paneRect(widget);
        if (!rect) return fail('pane_unavailable', 'Active pane bounds are unavailable');
        var scale = timeScale(model);
        if (!scale || typeof scale.indexToCoordinate !== 'function') {
          return fail('time_scale_unavailable', 'Chart time scale cannot convert bar indices to coordinates');
        }
        var relativeX = coordinateForIndex(scale, located.target_index);
        if (relativeX !== null && relativeX >= 0 && relativeX <= rect.width) {
          var selected = selectStudies(chart, chartSources(model), opt.studyFilters);
          if (selected.error) return selected.error;
          return {
            success: true,
            capture_mode: 'data_window_hover',
            identity_verified: true,
            symbol: identity.symbol,
            timeframe: identity.timeframe,
            active_bar_time: located.active_bar_time,
            target_bar_time: located.target_bar_time,
            target_logical_index: located.target_index,
            bar: located.bar,
            x: rect.left + relativeX,
            y: rect.top + rect.height / 2,
            viewport_adjusted: viewportAdjusted,
            study_identity: studyIdentity(selected.studies)
          };
        }
        if (typeof scale.zoomToBarsRange !== 'function') {
          return fail('bar_not_visible', 'Requested bar is not visible and the time scale cannot reveal it', {
            target_bar_time: located.target_bar_time
          });
        }
        try {
          var fromIndex = Math.max(located.first_index, located.target_index - 25);
          var toIndex = Math.min(located.last_index, located.target_index + 25);
          scale.zoomToBarsRange(fromIndex, toIndex);
          viewportAdjusted = true;
        } catch (error) {
          return fail('bar_not_visible', 'Requested bar could not be made visible', {
            target_bar_time: located.target_bar_time
          });
        }
        if (attempt < opt.pollAttempts - 1) await sleep(opt.pollIntervalMs);
      }
      return fail('bar_not_visible', 'Requested bar did not become visible before timeout', {
        time: referenceTime
      });
    })()
  `;
}

export function buildHoverBarReadExpression(options, position) {
  const payload = JSON.stringify({
    studyFilters: options.study_filters,
    stablePolls: options.stable_polls,
    pollIntervalMs: options.poll_interval_ms,
    pollAttempts: options.poll_attempts,
    expected: {
      symbol: position.symbol,
      timeframe: position.timeframe,
      targetBarTime: position.target_bar_time,
      studyIdentity: position.study_identity,
    },
  });
  return `
    (async function() {
      var opt = ${payload};
      ${pageHelpers()}
      var stable = 0;
      var previousFingerprint = null;
      var sawComplete = false;
      var lastFailure = null;
      for (var attempt = 0; attempt < opt.pollAttempts; attempt += 1) {
        var replayStarted = replayActive();
        if (replayStarted === null) return fail('replay_state_unavailable', 'Replay state is unavailable');
        if (replayStarted) return fail('replay_active', 'chart_hover_bar is unavailable while Replay is active');
        var chart = activeChart();
        var model = chartModel(chart);
        if (!chart || !model) {
          lastFailure = fail('chart_unavailable', 'Active chart widget is unavailable');
        } else {
          var identity = chartIdentity(chart, model);
          if (!identity) {
            lastFailure = fail('identity_unavailable', 'Chart symbol/timeframe identity is unavailable');
          } else if (identity.symbol !== opt.expected.symbol || identity.timeframe !== opt.expected.timeframe) {
            return fail('identity_mismatch', 'Chart symbol/timeframe changed after crosshair positioning', {
              previous: { symbol: opt.expected.symbol, timeframe: opt.expected.timeframe },
              current: identity
            });
          } else {
            var bars = mainSeriesBars(model);
            var located = locateTarget(bars, { time: null, barsAgo: null }, opt.expected.targetBarTime);
            if (located.error) {
              lastFailure = located.error;
            } else {
              var hoveredIndex = appliedCrosshairIndex(model);
              var hoveredRow = hoveredIndex === null || !bars ? null : bars.valueAt(hoveredIndex);
              var hoveredTime = hoveredRow ? comparableTime(hoveredRow[0]) : null;
              if (hoveredIndex === null || hoveredTime === null) {
                lastFailure = fail('crosshair_unavailable', 'Crosshair did not expose an applied bar index');
              } else if (!sameTime(hoveredTime, opt.expected.targetBarTime)) {
                lastFailure = fail('hover_time_mismatch', 'Crosshair did not land on the requested bar', {
                  target_bar_time: opt.expected.targetBarTime,
                  actual_bar_time: hoveredTime
                });
              } else {
                var selected = selectStudies(chart, chartSources(model), opt.studyFilters);
                if (selected.error) {
                  lastFailure = selected.error;
                } else if (!sameStudyIdentity(opt.expected.studyIdentity, studyIdentity(selected.studies))) {
                  return fail('study_identity_mismatch', 'Target study identities changed after crosshair positioning', {
                    previous: opt.expected.studyIdentity,
                    current: studyIdentity(selected.studies)
                  });
                } else {
                  var read = readDataWindows(selected.studies);
                  if (read.error) {
                    lastFailure = read.error;
                  } else {
                    var observation = {
                      symbol: identity.symbol,
                      timeframe: identity.timeframe,
                      active_bar_time: located.active_bar_time,
                      target_bar_time: located.target_bar_time,
                      target_logical_index: located.target_index,
                      hover_logical_index: hoveredIndex,
                      hover_bar_time: hoveredTime,
                      bar: located.bar,
                      studies: read.studies
                    };
                    var mark = JSON.stringify(observation);
                    sawComplete = true;
                    if (mark === previousFingerprint) stable += 1;
                    else {
                      stable = 1;
                      previousFingerprint = mark;
                    }
                    lastFailure = null;
                    if (stable >= opt.stablePolls) {
                      return {
                        success: true,
                        capture_mode: 'data_window_hover',
                        identity_verified: true,
                        stable_polls: stable,
                        symbol: observation.symbol,
                        timeframe: observation.timeframe,
                        active_bar_time: observation.active_bar_time,
                        target_bar_time: observation.target_bar_time,
                        target_logical_index: observation.target_logical_index,
                        hover_logical_index: observation.hover_logical_index,
                        hover_bar_time: observation.hover_bar_time,
                        bar: observation.bar,
                        studies: observation.studies
                      };
                    }
                  }
                }
              }
            }
          }
        }
        if (attempt < opt.pollAttempts - 1) await sleep(opt.pollIntervalMs);
      }
      if (sawComplete) {
        return fail('data_window_unstable', 'Data Window values did not remain identical for stable_polls observations', {
          stable_polls: stable,
          required: opt.stablePolls
        });
      }
      if (lastFailure) return lastFailure;
      return fail('hover_timeout', 'Crosshair did not settle before timeout');
    })()
  `;
}

function normalizeFailure(raw, fallbackCode, fallbackMessage) {
  if (raw && raw.failure && typeof raw.failure === 'object'
      && typeof raw.failure.code === 'string' && raw.failure.code !== '') {
    return failClosed(raw.failure.code, raw.failure.message || raw.error || fallbackMessage, raw.failure);
  }
  return failClosed(fallbackCode, raw?.error || fallbackMessage);
}

function validIdentity(raw) {
  return raw && typeof raw.symbol === 'string' && raw.symbol.trim() !== ''
    && typeof raw.timeframe === 'string' && raw.timeframe.trim() !== '';
}

function validStudyIdentity(value) {
  return Array.isArray(value) && value.every(study => study
    && typeof study.entity_id === 'string' && study.entity_id.trim() !== ''
    && typeof study.name === 'string' && study.name.trim() !== '');
}

export function validateHoverBarPosition(raw) {
  if (!raw || typeof raw !== 'object') {
    return failClosed('invalid_response', 'page returned no structured hover position');
  }
  if (raw.success !== true) return normalizeFailure(raw, 'positioning_failed', 'crosshair positioning failed');
  if (raw.capture_mode !== HOVER_BAR_CAPTURE_MODE || raw.identity_verified !== true) {
    return failClosed('invalid_response', 'page response is not an identity-verified hover position');
  }
  if (!validIdentity(raw)) return failClosed('identity_unavailable', 'hover position is missing chart identity');
  if (!Number.isFinite(Number(raw.target_bar_time)) || !Number.isInteger(raw.target_logical_index)
      || !Number.isFinite(Number(raw.x)) || !Number.isFinite(Number(raw.y))) {
    return failClosed('invalid_response', 'hover position is missing a target bar or finite coordinates');
  }
  if (!validStudyIdentity(raw.study_identity)) {
    return failClosed('study_identity_unavailable', 'hover position has invalid target study identities');
  }
  return {
    success: true,
    symbol: raw.symbol,
    timeframe: raw.timeframe,
    target_bar_time: comparableTime(raw.target_bar_time),
    target_logical_index: raw.target_logical_index,
    x: Number(raw.x),
    y: Number(raw.y),
    viewport_adjusted: raw.viewport_adjusted === true,
    study_identity: raw.study_identity.map(study => ({
      entity_id: study.entity_id,
      name: study.name,
    })),
  };
}

function sameStudyIdentity(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((study, index) => study?.entity_id === right[index]?.entity_id
      && study?.name === right[index]?.name);
}

function validDataWindowValue(value) {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

export function validateHoverBarResult(raw, options, position) {
  if (!raw || typeof raw !== 'object') {
    return failClosed('invalid_response', 'page returned no structured Data Window observation');
  }
  if (raw.success !== true) return normalizeFailure(raw, 'hover_failed', 'Data Window hover failed');
  if (raw.capture_mode !== HOVER_BAR_CAPTURE_MODE || raw.identity_verified !== true) {
    return failClosed('invalid_response', 'page response is not an identity-verified Data Window hover');
  }
  if (!validIdentity(raw)) return failClosed('identity_unavailable', 'Data Window response is missing chart identity');
  if (raw.symbol !== position.symbol || raw.timeframe !== position.timeframe) {
    return failClosed('identity_mismatch', 'Data Window response identity differs from positioned chart', {
      previous: { symbol: position.symbol, timeframe: position.timeframe },
      current: { symbol: raw.symbol, timeframe: raw.timeframe },
    });
  }
  const targetTime = comparableTime(raw.target_bar_time);
  const hoverTime = comparableTime(raw.hover_bar_time);
  if (targetTime === null || hoverTime === null || targetTime !== position.target_bar_time
      || hoverTime !== position.target_bar_time) {
    return failClosed('hover_time_mismatch', 'Data Window response did not verify the requested bar time', {
      target_bar_time: position.target_bar_time,
      returned_target_bar_time: raw.target_bar_time,
      returned_hover_bar_time: raw.hover_bar_time,
    });
  }
  if (!Number.isInteger(raw.target_logical_index) || !Number.isInteger(raw.hover_logical_index)
      || !Number.isFinite(Number(raw.active_bar_time))) {
    return failClosed('invalid_response', 'Data Window response has incomplete bar identity');
  }
  if (!raw.bar || typeof raw.bar !== 'object' || comparableTime(raw.bar.time) !== position.target_bar_time
      || !['open', 'high', 'low', 'close'].every(key => Number.isFinite(Number(raw.bar[key])))
      || (raw.bar.volume !== null && raw.bar.volume !== undefined && !Number.isFinite(Number(raw.bar.volume)))) {
    return failClosed('bar_incomplete', 'Data Window response has an incomplete target bar');
  }
  if (!Array.isArray(raw.studies) || raw.studies.length !== position.study_identity.length) {
    return failClosed('study_identity_mismatch', 'Data Window response has a different target study set');
  }
  const responseIdentity = raw.studies.map(study => ({
    entity_id: study?.entity_id,
    name: study?.name,
  }));
  if (!validStudyIdentity(responseIdentity) || !sameStudyIdentity(position.study_identity, responseIdentity)) {
    return failClosed('study_identity_mismatch', 'Data Window response study identities differ from positioned chart');
  }
  for (const study of raw.studies) {
    if (!Array.isArray(study.values) || study.values.some(item => !item
        || typeof item.title !== 'string' || item.title.trim() === ''
        || !validDataWindowValue(item.value))) {
      return failClosed('data_window_unavailable', 'Data Window response contains an invalid study value');
    }
  }
  if (!Number.isInteger(raw.stable_polls) || raw.stable_polls < options.stable_polls) {
    return failClosed('data_window_unstable', 'Data Window response did not meet stable_polls');
  }
  return {
    success: true,
    capture_mode: HOVER_BAR_CAPTURE_MODE,
    identity_verified: true,
    stable_polls: raw.stable_polls,
    symbol: raw.symbol,
    timeframe: raw.timeframe,
    active_bar_time: comparableTime(raw.active_bar_time),
    target_bar_time: targetTime,
    target_logical_index: raw.target_logical_index,
    hover_logical_index: raw.hover_logical_index,
    hover_bar_time: hoverTime,
    bar: {
      time: comparableTime(raw.bar.time),
      open: Number(raw.bar.open),
      high: Number(raw.bar.high),
      low: Number(raw.bar.low),
      close: Number(raw.bar.close),
      volume: raw.bar.volume === null || raw.bar.volume === undefined ? null : Number(raw.bar.volume),
    },
    studies: raw.studies.map(study => ({
      entity_id: study.entity_id,
      name: study.name,
      values: study.values.map(item => ({ title: item.title, value: item.value })),
    })),
    hover: {
      x: position.x,
      y: position.y,
      viewport_adjusted: position.viewport_adjusted,
    },
  };
}

export async function hoverBar(options = {}) {
  const parsed = parseHoverBarOptions(options);
  const { evaluateAsync, getClient } = resolve(options._deps);
  let rawPosition;
  try {
    rawPosition = await evaluateAsync(buildHoverBarPositionExpression(parsed));
  } catch (error) {
    return failClosed('positioning_failed', `Could not position crosshair: ${error.message}`);
  }
  const position = validateHoverBarPosition(rawPosition);
  if (position.success !== true) return position;
  try {
    const client = await getClient();
    if (!client?.Input || typeof client.Input.dispatchMouseEvent !== 'function') {
      return failClosed('mouse_move_unavailable', 'CDP Input.dispatchMouseEvent is unavailable');
    }
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: position.x, y: position.y });
  } catch (error) {
    return failClosed('mouse_move_failed', `Could not move crosshair: ${error.message}`);
  }
  let rawResult;
  try {
    rawResult = await evaluateAsync(buildHoverBarReadExpression(parsed, position));
  } catch (error) {
    return failClosed('hover_failed', `Could not read Data Window after moving crosshair: ${error.message}`);
  }
  return validateHoverBarResult(rawResult, parsed, position);
}
