/**
 * Atomic PlotList bar snapshot for the current active pane.
 *
 * One page evaluation locates the requested closed bars, reads the main
 * series and matching studies together, and requires consecutive identical
 * complete snapshots before returning. Node then maps raw rows through
 * plot_list.js. This does not move the mouse, enter Replay, or change 0822
 * capture contracts.
 */
import { evaluateAsync as _evaluateAsync } from '../connection.js';
import {
  hydrateStudyFromPlotList,
  mapPlotListRow,
  parseFilledAreas,
} from './plot_list.js';

export const BAR_SNAPSHOT_CAPTURE_MODE = 'plot_list';
export const MAX_BAR_SNAPSHOT_COUNT = 20;
export const MAX_REPLAY_BAR_SNAPSHOT_COUNT = 3000;
const DEFAULT_COUNT = 1;
const DEFAULT_STABLE_POLLS = 2;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_POLL_ATTEMPTS = 16;

function resolve(deps) {
  return { evaluateAsync: deps?.evaluateAsync || _evaluateAsync };
}

function asInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function asBoolean(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
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

function asPaneCursorTimes(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error('after_time_by_pane must contain 1 to 16 unix timestamps');
  }
  return value.map((item, index) => {
    if (item === null) return null;
    if (typeof item === 'boolean' || (typeof item === 'string' && item.trim() === '')) {
      throw new Error(`after_time_by_pane[${index}] must be a finite unix timestamp`);
    }
    const parsed = asOptionalTime(item, `after_time_by_pane[${index}]`);
    const normalized = Math.abs(parsed) > 100000000000 ? parsed / 1000 : parsed;
    if (!Number.isInteger(normalized)) {
      throw new Error(`after_time_by_pane[${index}] must resolve to a whole-second unix timestamp`);
    }
    return normalized;
  });
}

export function parseBarSnapshotOptions({
  time,
  bars_ago,
  count,
  closed_only,
  study_filters,
  stable_polls,
  poll_interval_ms,
} = {}) {
  const hasTime = time !== undefined && time !== null;
  const hasBarsAgo = bars_ago !== undefined && bars_ago !== null;
  if (hasTime && hasBarsAgo) {
    throw new Error('time and bars_ago are mutually exclusive');
  }
  const closedOnly = asBoolean(closed_only, true, 'closed_only');
  const barsAgo = hasBarsAgo ? asInteger(bars_ago, null, 0, 5000, 'bars_ago') : null;
  if (closedOnly && barsAgo === 0) {
    throw new Error('bars_ago=0 selects the active bar; closed_only snapshots require bars_ago >= 1');
  }
  const stablePolls = asInteger(stable_polls, DEFAULT_STABLE_POLLS, 2, 12, 'stable_polls');
  return {
    time: hasTime ? asOptionalTime(time, 'time') : null,
    bars_ago: barsAgo,
    count: asInteger(count, DEFAULT_COUNT, 1, MAX_BAR_SNAPSHOT_COUNT, 'count'),
    closed_only: closedOnly,
    study_filters: asStudyFilters(study_filters),
    stable_polls: stablePolls,
    poll_interval_ms: asInteger(
      poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 25, 2000, 'poll_interval_ms'
    ),
    poll_attempts: Math.max(DEFAULT_POLL_ATTEMPTS, stablePolls),
  };
}

export function parsePaneScanOptions({
  after_time_by_pane,
  count,
  closed_only,
  study_filters,
  stable_polls,
  poll_interval_ms,
} = {}) {
  const stablePolls = asInteger(stable_polls, DEFAULT_STABLE_POLLS, 2, 12, 'stable_polls');
  const closedOnly = asBoolean(closed_only, true, 'closed_only');
  const afterTimes = asPaneCursorTimes(after_time_by_pane);
  if (afterTimes !== null && !closedOnly) {
    throw new Error('forward pane scans require closed_only=true');
  }
  return {
    time: null,
    bars_ago: null,
    after_time_by_pane: afterTimes,
    count: asInteger(count, DEFAULT_COUNT, 1, MAX_BAR_SNAPSHOT_COUNT, 'count'),
    closed_only: closedOnly,
    study_filters: asStudyFilters(study_filters),
    stable_polls: stablePolls,
    poll_interval_ms: asInteger(
      poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 25, 2000, 'poll_interval_ms'
    ),
    poll_attempts: Math.max(DEFAULT_POLL_ATTEMPTS, stablePolls),
    scan_panes: true,
  };
}

export function parseReplayBarSnapshotOptions({
  bars_ago,
  count,
  study_filters,
  stable_polls,
  poll_interval_ms,
} = {}) {
  const stablePolls = asInteger(stable_polls, DEFAULT_STABLE_POLLS, 2, 12, 'stable_polls');
  return {
    time: null,
    bars_ago: asInteger(bars_ago, 1, 1, 5000, 'bars_ago'),
    after_time_by_pane: null,
    count: asInteger(count, DEFAULT_COUNT, 1, MAX_REPLAY_BAR_SNAPSHOT_COUNT, 'count'),
    closed_only: true,
    study_filters: asStudyFilters(study_filters),
    stable_polls: stablePolls,
    poll_interval_ms: asInteger(
      poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 25, 2000, 'poll_interval_ms'
    ),
    poll_attempts: Math.max(80, stablePolls),
    scan_panes: false,
    replay_policy: 'require',
    load_history: true,
    compact_replay: true,
  };
}

export function parseBarHistoryOptions(options = {}) {
  return {
    ...parseReplayBarSnapshotOptions(options),
    replay_policy: 'forbid',
  };
}

function failClosed(code, message, extra = {}) {
  return {
    success: false,
    capture_mode: BAR_SNAPSHOT_CAPTURE_MODE,
    identity_verified: false,
    error: message,
    failure: { code, message, ...extra },
    records: [],
  };
}

export function buildBarSnapshotExpression(options) {
  const payload = JSON.stringify({
    time: options.time,
    barsAgo: options.bars_ago,
    count: options.count,
    closedOnly: options.closed_only,
    studyFilters: options.study_filters,
    stablePolls: options.stable_polls,
    pollIntervalMs: options.poll_interval_ms,
    pollAttempts: options.poll_attempts,
    scanPanes: options.scan_panes === true,
    afterTimes: options.after_time_by_pane || null,
    replayPolicy: options.replay_policy || 'forbid',
    loadHistory: options.load_history === true,
    compactReplay: options.compact_replay === true,
  });
  return `
    (async function() {
      var opt = ${payload};
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
          capture_mode: 'plot_list',
          identity_verified: false,
          error: message,
          failure: { code: code, message: message },
          records: []
        };
        if (extra && typeof extra === 'object') {
          Object.keys(extra).forEach(function(key) { result.failure[key] = extra[key]; });
        }
        return result;
      }
      function chartWidget() {
        try { return window.TradingViewApi._activeChartWidgetWV.value(); }
        catch (error) { return null; }
      }
      function replayActive() {
        try {
          var replay = window.TradingViewApi._replayApi;
          if (!replay || typeof replay.isReplayStarted !== 'function') return null;
          var started = replay.isReplayStarted();
          if (started && typeof started === 'object' && typeof started.value === 'function') {
            started = started.value();
          }
          return started === true;
        } catch (error) {
          return null;
        }
      }
      function chartIdentity(chart) {
        try {
          var activeWrapper = chart && chart._chartWidget ? chart : null;
          var widget = activeWrapper ? chart._chartWidget : chart;
          var model = widget && typeof widget.model === 'function' ? widget.model() : null;
          var mainSeries = model && typeof model.mainSeries === 'function' ? model.mainSeries() : null;
          var symbol = activeWrapper && typeof chart.symbol === 'function' ? chart.symbol()
            : (mainSeries && typeof mainSeries.symbol === 'function' ? mainSeries.symbol() : null);
          var timeframe = activeWrapper && typeof chart.resolution === 'function' ? chart.resolution()
            : (mainSeries && typeof mainSeries.interval === 'function' ? mainSeries.interval() : null);
          if (typeof symbol !== 'string' || symbol.trim() === ''
              || typeof timeframe !== 'string' || timeframe.trim() === '') return null;
          return { symbol: symbol, timeframe: timeframe };
        } catch (error) {
          return null;
        }
      }
      function mainSeriesBars(chart) {
        try {
          var widget = chart._chartWidget || chart;
          return widget.model().mainSeries().bars();
        }
        catch (error) { return null; }
      }
      function chartSources(chart) {
        try {
          var widget = chart._chartWidget || chart;
          return widget.model().model().dataSources();
        }
        catch (error) { return null; }
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
      function studyMatches(name) {
        if (!opt.studyFilters || opt.studyFilters.length === 0) return true;
        for (var i = 0; i < opt.studyFilters.length; i += 1) {
          if (name.indexOf(opt.studyFilters[i]) !== -1) return true;
        }
        return false;
      }
      function studyEntityId(chart, source, name) {
        try {
          if (typeof source.id === 'function') {
            var direct = source.id();
            if (direct != null && String(direct).trim() !== '') return String(direct);
          } else if (source.id != null && String(source.id).trim() !== '') {
            return String(source.id);
          }
        } catch (error) {}
        try {
          var listed = chart.getAllStudies();
          if (Array.isArray(listed)) {
            for (var i = 0; i < listed.length; i += 1) {
              var item = listed[i];
              if (item && (item.name === name || item.title === name) && item.id != null) {
                return String(item.id);
              }
            }
          }
        } catch (error) {}
        return null;
      }
      function serializeMapLike(value) {
        if (value == null) return {};
        var out = {};
        if (typeof value.forEach === 'function' && typeof value.get === 'function') {
          value.forEach(function(entry, key) { out[String(key)] = entry; });
          return out;
        }
        if (typeof value === 'object') {
          Object.keys(value).forEach(function(key) { out[key] = value[key]; });
        }
        return out;
      }
      function serializeColors(colors) {
        if (colors == null) return colors;
        if (Array.isArray(colors)) {
          return colors.map(function(entry) {
            if (entry && typeof entry === 'object') {
              return { color: entry.color == null ? null : String(entry.color), alpha: entry.alpha };
            }
            return entry;
          });
        }
        var out = {};
        var mapped = serializeMapLike(colors);
        Object.keys(mapped).forEach(function(key) {
          var entry = mapped[key];
          if (entry && typeof entry === 'object') {
            out[key] = { color: entry.color == null ? null : String(entry.color), alpha: entry.alpha };
          } else {
            out[key] = entry;
          }
        });
        return out;
      }
      function serializeStudyMeta(source) {
        var meta = source.metaInfo();
        var plots = [];
        var rawPlots = meta && Array.isArray(meta.plots) ? meta.plots : [];
        for (var i = 0; i < rawPlots.length; i += 1) {
          var plot = rawPlots[i] || {};
          plots.push({
            id: plot.id == null ? null : String(plot.id),
            type: plot.type == null ? null : String(plot.type),
            target: plot.target == null ? null : String(plot.target),
            palette: plot.palette == null ? null : String(plot.palette),
            title: plot.title == null ? null : String(plot.title),
            text: plot.text == null ? null : String(plot.text)
          });
        }
        var styles = {};
        var rawStyles = serializeMapLike(meta && meta.styles);
        Object.keys(rawStyles).forEach(function(key) {
            var style = rawStyles[key] || {};
            styles[key] = {
              title: style.title == null ? null : String(style.title),
              text: style.text == null ? null : String(style.text)
            };
        });
        var filledAreas = [];
        var rawFills = (meta && (meta.filledAreas || meta.filled_areas)) || [];
        if (Array.isArray(rawFills)) {
          for (var f = 0; f < rawFills.length; f += 1) {
            var fill = rawFills[f] || {};
            filledAreas.push({
              id: fill.id == null ? null : String(fill.id),
              title: fill.title == null ? null : String(fill.title),
              objAId: fill.objAId == null ? null : String(fill.objAId),
              objBId: fill.objBId == null ? null : String(fill.objBId),
              palette: fill.palette == null ? null : String(fill.palette)
            });
          }
        }
        var palettes = {};
        var rawPalettes = serializeMapLike(meta && meta.palettes);
        Object.keys(rawPalettes).forEach(function(key) {
            var palette = rawPalettes[key] || {};
            palettes[key] = { valToIndex: serializeMapLike(palette.valToIndex), colors: serializeColors(palette.colors) };
        });
        var defaultsPalettes = {};
        var rawDefaults = serializeMapLike(meta && meta.defaults && meta.defaults.palettes);
        Object.keys(rawDefaults).forEach(function(key) {
            var def = rawDefaults[key] || {};
            defaultsPalettes[key] = { colors: serializeColors(def.colors) };
        });
        return {
          plots: plots,
          styles: styles,
          filledAreas: filledAreas,
          palettes: palettes,
          defaults: { palettes: defaultsPalettes },
          historyCalculationMayChange: !!(meta && meta.historyCalculationMayChange)
        };
      }
      function ohlcvFromRow(row) {
        if (!Array.isArray(row) || row.length < 5) return null;
        var open = Number(row[1]);
        var high = Number(row[2]);
        var low = Number(row[3]);
        var close = Number(row[4]);
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
          return null;
        }
        var volume = row.length > 5 && row[5] !== undefined && row[5] !== null ? Number(row[5]) : null;
        if (volume !== null && !Number.isFinite(volume)) volume = null;
        return { open: open, high: high, low: low, close: close, volume: volume };
      }
      function cloneRow(row) {
        if (!Array.isArray(row)) return null;
        var copy = [];
        for (var i = 0; i < row.length; i += 1) copy.push(row[i] === undefined ? null : row[i]);
        return copy;
      }
      function locateBars(bars, paneIndex) {
        if (!bars || typeof bars.lastIndex !== 'function' || typeof bars.firstIndex !== 'function'
            || typeof bars.valueAt !== 'function' || typeof bars.searchByTime !== 'function') {
          return { error: fail('main_series_unavailable', 'Main series bars are unavailable') };
        }
        var first = bars.firstIndex();
        var last = bars.lastIndex();
        if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) {
          return { error: fail('main_series_unavailable', 'Main series has no readable index range') };
        }
        var activeRow = bars.valueAt(last);
        var activeTime = activeRow && comparableTime(activeRow[0]);
        if (activeTime === null) {
          return { error: fail('active_bar_unavailable', 'Active bar time is unavailable') };
        }
        var endIndex;
        var cursorTime = null;
        var hasMore = false;
        var cursorStartIndex = null;
        var forwardPane = opt.afterTimes != null && opt.afterTimes[paneIndex] != null;
        if (forwardPane) {
          cursorTime = comparableTime(opt.afterTimes[paneIndex]);
          var cursor = bars.searchByTime(cursorTime);
          if (!cursor || !cursor.value || !sameTime(cursor.value[0], cursorTime)
              || !Number.isInteger(cursor.index)) {
            return { error: fail('cursor_not_loaded', 'Pane watermark is not loaded on the main series', {
              cursor_time: opt.afterTimes[paneIndex]
            }) };
          }
          if (cursor.index >= last) {
            return { error: fail('active_bar_excluded', 'Pane watermark must be a closed bar') };
          }
          endIndex = Math.min(cursor.index + opt.count, last - 1);
          hasMore = endIndex < last - 1;
          cursorStartIndex = cursor.index;
        } else if (opt.time != null) {
          var wanted = comparableTime(opt.time);
          var found = bars.searchByTime(wanted);
          if (!found || !found.value || !sameTime(found.value[0], wanted) || !Number.isInteger(found.index)) {
            return { error: fail('bar_not_found', 'Requested time was not found on the main series', { time: opt.time }) };
          }
          endIndex = found.index;
        } else if (opt.barsAgo != null) {
          endIndex = last - opt.barsAgo;
        } else {
          endIndex = opt.closedOnly ? last - 1 : last;
        }
        if (!Number.isInteger(endIndex) || endIndex < first || endIndex > last) {
          return { error: fail('bar_not_found', 'Requested bars_ago/time is outside the loaded main series') };
        }
        if (opt.closedOnly && endIndex >= last) {
          return { error: fail('active_bar_excluded', 'closed_only snapshots cannot return the active bar') };
        }
        var startIndex = forwardPane ? cursorStartIndex : endIndex - opt.count + 1;
        if (startIndex < first) {
          return { error: fail('insufficient_bars', 'The loaded main series has fewer bars than requested', {
            requested: opt.count,
            available: endIndex - first + 1
          }) };
        }
        var records = [];
        for (var index = startIndex; index <= endIndex; index += 1) {
          var row = bars.valueAt(index);
          var ohlcv = ohlcvFromRow(row);
          var barTime = row ? comparableTime(row[0]) : null;
          if (barTime === null || !ohlcv) {
            return { error: fail('bar_incomplete', 'A requested main-series bar is incomplete', { index: index }) };
          }
          var closed = index < last;
          if (opt.closedOnly && (!closed || sameTime(barTime, activeTime))) {
            return { error: fail('active_bar_excluded', 'closed_only snapshots cannot return the active bar') };
          }
          records.push({
            bar_time: barTime,
            closed: closed,
            ohlcv: ohlcv,
            logical_index: index
          });
        }
        if (records.length === 0) {
          return { error: fail('bar_not_found', 'No bars matched the snapshot request') };
        }
        return {
          activeTime: activeTime,
          records: records,
          cursorTime: cursorTime,
          hasMore: hasMore,
          forwardPane: forwardPane
        };
      }
      function readStudies(chart, sources, records) {
        if (!Array.isArray(sources)) {
          return { error: fail('chart_sources_unavailable', 'Chart data sources are unavailable') };
        }
        var matched = [];
        for (var i = 0; i < sources.length; i += 1) {
          var source = sources[i];
          if (!source || !source.metaInfo || !sourceVisible(source)) continue;
          var name = safeStudyName(source);
          if (!name || !studyMatches(name)) continue;
          var data = source._data;
          if (!data || typeof data.searchByTime !== 'function') {
            if (opt.studyFilters && opt.studyFilters.length > 0) {
              return { error: fail('study_plot_list_unavailable', 'A matched study has no PlotList searchByTime', { study_name: name }) };
            }
            continue;
          }
          matched.push({
            source: source,
            name: name,
            entity_id: studyEntityId(chart, source, name),
            meta: serializeStudyMeta(source)
          });
        }
        var seenEntityIds = {};
        for (var idIndex = 0; idIndex < matched.length; idIndex += 1) {
          var matchedStudy = matched[idIndex];
          if (typeof matchedStudy.entity_id !== 'string' || matchedStudy.entity_id.trim() === '') {
            return { error: fail('study_identity_unavailable', 'A matched study is missing entity_id', {
              study_name: matchedStudy.name
            }) };
          }
          if (seenEntityIds[matchedStudy.entity_id]) {
            return { error: fail('study_identity_duplicate', 'Matched studies share the same entity_id', {
              entity_id: matchedStudy.entity_id,
              study_name: matchedStudy.name
            }) };
          }
          seenEntityIds[matchedStudy.entity_id] = true;
        }
        if (opt.studyFilters && opt.studyFilters.length > 0) {
          if (matched.length === 0) {
            return { error: fail('no_matching_study', 'No visible study matched study_filters') };
          }
          for (var f = 0; f < opt.studyFilters.length; f += 1) {
            var filterFound = false;
            for (var m = 0; m < matched.length; m += 1) {
              if (matched[m].name.indexOf(opt.studyFilters[f]) !== -1) { filterFound = true; break; }
            }
            if (!filterFound) {
              return { error: fail('no_matching_study', 'No visible study matched study_filters', {
                study_filter: opt.studyFilters[f]
              }) };
            }
          }
        }
        var requireAllMatched = opt.studyFilters && opt.studyFilters.length > 0;
        var studiesByBar = [];
        for (var r = 0; r < records.length; r += 1) {
          var bar = records[r];
          var studies = [];
          for (var s = 0; s < matched.length; s += 1) {
            var study = matched[s];
            var found = study.source._data.searchByTime(bar.bar_time);
            var row = found && found.value;
            if (!found || !Array.isArray(row) || !sameTime(row[0], bar.bar_time)) {
              if (requireAllMatched) {
                return {
                  error: fail('study_row_unavailable', 'A matched study has no PlotList row at the requested bar', {
                    study_name: study.name,
                    bar_time: bar.bar_time
                  })
                };
              }
              continue;
            }
            studies.push({
              entity_id: study.entity_id,
              ...(opt.compactReplay ? {} : {
                name: study.name,
                history_calculation_may_change: !!(study.meta && study.meta.historyCalculationMayChange),
                meta: study.meta
              }),
              row: cloneRow(row)
            });
          }
          studiesByBar.push(studies);
        }
        return {
          studiesByBar: studiesByBar,
          studyDefinitions: opt.compactReplay ? matched.map(function(study) {
            return {
              entity_id: study.entity_id,
              name: study.name,
              history_calculation_may_change: !!(study.meta && study.meta.historyCalculationMayChange),
              meta: study.meta
            };
          }) : null
        };
      }
      function fingerprint(snapshot) {
        if (snapshot && Array.isArray(snapshot.panes)) {
          return JSON.stringify(snapshot.panes.map(function(pane) {
            return JSON.parse(fingerprint(pane));
          }));
        }
        if (Array.isArray(snapshot.study_definitions)) {
          return JSON.stringify({
            symbol: snapshot.symbol,
            timeframe: snapshot.timeframe,
            active_bar_time: snapshot.active_bar_time,
            study_definitions: snapshot.study_definitions,
            records: snapshot.records
          });
        }
        return JSON.stringify({
          symbol: snapshot.symbol,
          timeframe: snapshot.timeframe,
          active_bar_time: snapshot.active_bar_time,
          cursor_time: snapshot.cursor_time,
          has_more: snapshot.has_more,
          records: snapshot.records.map(function(record) {
            return {
              bar_time: record.bar_time,
              closed: record.closed,
              ohlcv: record.ohlcv,
              studies: record.studies.map(function(study) {
                return {
                  entity_id: study.entity_id,
                  name: study.name,
                  history_calculation_may_change: study.history_calculation_may_change,
                  meta: study.meta,
                  row: study.row
                };
              })
            };
          })
        });
      }
      function compactReplaySnapshot(snapshot) {
        if (!Array.isArray(snapshot.study_definitions)) {
          return fail('invalid_response', 'Compact snapshot has no study definitions');
        }
        return {
          ...snapshot,
          capture_mode: 'plot_list.compact.raw.v1',
          records: snapshot.records.map(function(record) {
            return {
              bar_time: record.bar_time,
              closed: record.closed,
              ohlcv: record.ohlcv,
              study_rows: record.studies
            };
          })
        };
      }
      function observe(chart, paneIndex) {
        chart = chart || chartWidget();
        if (!chart) return fail('chart_unavailable', 'Chart widget is unavailable', {
          pane_index: paneIndex
        });
        var identity = chartIdentity(chart);
        if (!identity) return fail('identity_unavailable', 'Chart symbol/timeframe identity is unavailable', {
          pane_index: paneIndex
        });
        var located = locateBars(mainSeriesBars(chart), paneIndex);
        if (located.error) {
          if (located.error.failure && paneIndex != null) located.error.failure.pane_index = paneIndex;
          return located.error;
        }
        var studies = readStudies(chart, chartSources(chart), located.records);
        if (studies.error) {
          if (studies.error.failure && paneIndex != null) studies.error.failure.pane_index = paneIndex;
          return studies.error;
        }
        var records = [];
        for (var i = 0; i < located.records.length; i += 1) {
          var bar = located.records[i];
          records.push({
            bar_time: bar.bar_time,
            closed: bar.closed,
            ohlcv: bar.ohlcv,
            studies: studies.studiesByBar[i]
          });
        }
        var result = {
          success: true,
          capture_mode: 'plot_list',
          pane_index: paneIndex,
          symbol: identity.symbol,
          timeframe: identity.timeframe,
          active_bar_time: located.activeTime,
          records: records
        };
        if (opt.compactReplay) result.study_definitions = studies.studyDefinitions;
        if (located.forwardPane) {
          result.cursor_time = located.cursorTime;
          result.has_more = located.hasMore;
        }
        return result;
      }

      if (opt.loadHistory) {
        var initialReplayState = replayActive();
        if (initialReplayState === null) {
          return fail('replay_state_unavailable', 'Replay state is unavailable');
        }
        if (opt.replayPolicy === 'require' && initialReplayState !== true) {
          return fail('replay_not_active', 'Replay PlotList snapshots require active Replay');
        }
        if (opt.replayPolicy !== 'require' && initialReplayState === true) {
          return fail('replay_active', 'Live PlotList history is unavailable while Replay is active');
        }
        var historyChart = chartWidget();
        var historyWidget = historyChart && (historyChart._chartWidget || historyChart);
        var historyModel = historyWidget && typeof historyWidget.model === 'function'
          ? historyWidget.model() : null;
        var historySeries = historyModel && typeof historyModel.mainSeries === 'function'
          ? historyModel.mainSeries() : null;
        var historyBars = historySeries && typeof historySeries.bars === 'function'
          ? historySeries.bars() : null;
        if (!historyBars || typeof historyBars.firstIndex !== 'function'
            || typeof historyBars.lastIndex !== 'function') {
          return fail('history_request_unavailable', 'Chart history request API is unavailable');
        }
        var historyAvailable = historyBars.lastIndex() - historyBars.firstIndex() + 1;
        var historyRequired = opt.barsAgo + opt.count;
        if (historyAvailable < historyRequired) {
          if (typeof historySeries.requestMoreData !== 'function') {
            return fail('history_request_unavailable', 'Chart history request API is unavailable');
          }
          historySeries.requestMoreData(historyRequired - historyAvailable);
        }
      }

      var previousChartOrder = null;
      function observeLayout() {
        var collection;
        var charts;
        try {
          collection = window.TradingViewApi._chartWidgetCollection;
          charts = collection.getAll();
        } catch (error) {
          return fail('layout_unavailable', 'Chart widget collection is unavailable');
        }
        if (!Array.isArray(charts) || charts.length === 0) {
          return previousChartOrder
            ? fail('layout_changed', 'Pane count changed before the layout snapshot was stable', {
                previous_pane_count: previousChartOrder.length,
                current_pane_count: Array.isArray(charts) ? charts.length : null
              })
            : fail('layout_unavailable', 'Current layout has no readable panes');
        }
        if (opt.afterTimes != null && opt.afterTimes.length !== charts.length) {
          return fail('invalid_cursor_count', 'after_time_by_pane must match the current pane count', {
            expected: charts.length,
            received: opt.afterTimes.length
          });
        }
        if (previousChartOrder) {
          if (previousChartOrder.length !== charts.length) {
            return fail('layout_changed', 'Pane count changed before the layout snapshot was stable', {
              previous_pane_count: previousChartOrder.length,
              current_pane_count: charts.length
            });
          }
          for (var orderIndex = 0; orderIndex < charts.length; orderIndex += 1) {
            if (previousChartOrder[orderIndex] !== charts[orderIndex]) {
              return fail('layout_changed', 'Pane order changed before the layout snapshot was stable', {
                pane_index: orderIndex
              });
            }
          }
        } else {
          previousChartOrder = charts.slice();
        }
        var panes = [];
        for (var paneIndex = 0; paneIndex < charts.length; paneIndex += 1) {
          var pane = observe(charts[paneIndex], paneIndex);
          if (!pane || pane.success !== true) return pane;
          panes.push(pane);
        }
        return {
          success: true,
          capture_mode: 'plot_list',
          pane_count: panes.length,
          panes: panes
        };
      }

      function snapshotIdentity(snapshot) {
        if (opt.scanPanes) {
          return snapshot.panes.map(function(pane) {
            return { symbol: pane.symbol, timeframe: pane.timeframe };
          });
        }
        return { symbol: snapshot.symbol, timeframe: snapshot.timeframe };
      }

      function identityFailure(previous, current) {
        if (!opt.scanPanes) {
          if (previous.symbol === current.symbol && previous.timeframe === current.timeframe) return null;
          return fail('identity_mismatch', 'Chart symbol/timeframe changed before the snapshot was stable', {
            previous: previous,
            current: current
          });
        }
        if (previous.length !== current.length) {
          return fail('layout_changed', 'Pane count changed before the layout snapshot was stable', {
            previous_pane_count: previous.length,
            current_pane_count: current.length
          });
        }
        for (var paneIndex = 0; paneIndex < current.length; paneIndex += 1) {
          var before = previous[paneIndex];
          var after = current[paneIndex];
          if (before.symbol !== after.symbol || before.timeframe !== after.timeframe) {
            var beforeKeys = previous.map(function(item) { return item.symbol + '\\u0000' + item.timeframe; }).sort();
            var afterKeys = current.map(function(item) { return item.symbol + '\\u0000' + item.timeframe; }).sort();
            var reordered = JSON.stringify(beforeKeys) === JSON.stringify(afterKeys);
            return fail(reordered ? 'layout_changed' : 'identity_mismatch',
              reordered ? 'Pane order changed before the layout snapshot was stable'
                : 'Pane symbol/timeframe changed before the layout snapshot was stable', {
                pane_index: paneIndex,
                previous: before,
                current: after
              });
          }
        }
        return null;
      }

      var stable = 0;
      var previousFingerprint = null;
      var previousIdentity = null;
      var lastComplete = null;
      for (var attempt = 0; attempt < opt.pollAttempts; attempt += 1) {
        var replayStarted = replayActive();
        var snapshot = replayStarted === null
          ? fail('replay_state_unavailable', 'Replay state is unavailable')
          : (opt.replayPolicy === 'require'
              ? (replayStarted
                  ? observe()
                  : fail('replay_not_active', 'Replay PlotList snapshots require active Replay'))
              : (replayStarted
                  ? fail('replay_active', 'Forward-only PlotList snapshots are unavailable while Replay is active')
                  : (opt.scanPanes ? observeLayout() : observe())));
        if (!snapshot || snapshot.success !== true) {
          if (snapshot && snapshot.failure && (
            snapshot.failure.code === 'active_bar_excluded'
            || snapshot.failure.code === 'replay_active'
            || snapshot.failure.code === 'replay_not_active'
            || snapshot.failure.code === 'replay_state_unavailable'
          )) {
            return snapshot;
          }
          stable = 0;
          previousFingerprint = null;
          lastComplete = snapshot;
        } else {
          var currentIdentity = snapshotIdentity(snapshot);
          if (previousIdentity) {
            var changed = identityFailure(previousIdentity, currentIdentity);
            if (changed) return changed;
          }
          previousIdentity = currentIdentity;
          var mark = fingerprint(snapshot);
          if (mark === previousFingerprint) stable += 1;
          else {
            stable = 1;
            previousFingerprint = mark;
          }
          lastComplete = snapshot;
          if (stable >= opt.stablePolls) {
            lastComplete.stable_polls = stable;
            lastComplete.identity_verified = true;
            if (opt.scanPanes) {
              for (var paneIndex = 0; paneIndex < lastComplete.panes.length; paneIndex += 1) {
                lastComplete.panes[paneIndex].stable_polls = stable;
                lastComplete.panes[paneIndex].identity_verified = true;
              }
            }
            return opt.compactReplay ? compactReplaySnapshot(lastComplete) : lastComplete;
          }
        }
        if (attempt < opt.pollAttempts - 1) await sleep(opt.pollIntervalMs);
      }
      if (lastComplete && lastComplete.success === false) return lastComplete;
      return fail('snapshot_unstable', 'PlotList snapshot did not remain identical for stable_polls observations', {
        stable_polls: stable,
        required: opt.stablePolls
      });
    })()
  `;
}

export function buildPaneScanExpression(options) {
  return buildBarSnapshotExpression({ ...options, scan_panes: true });
}

export function hydrateBarSnapshot(raw) {
  if (!raw || raw.success !== true || !Array.isArray(raw.records)) return raw;
  return {
    ...raw,
    capture_mode: BAR_SNAPSHOT_CAPTURE_MODE,
    identity_verified: raw.identity_verified === true,
    records: raw.records.map(record => ({
      bar_time: record.bar_time,
      closed: record.closed === true,
      ohlcv: record.ohlcv && typeof record.ohlcv === 'object' ? record.ohlcv : {},
      studies: Array.isArray(record.studies)
        ? record.studies.map(hydrateStudyFromPlotList)
        : [],
    })),
  };
}

export function validateBarSnapshotResult(raw, options) {
  if (!raw || typeof raw !== 'object') {
    return failClosed('invalid_response', 'page returned no structured result');
  }
  if (raw.success !== true) {
    return {
      success: false,
      capture_mode: BAR_SNAPSHOT_CAPTURE_MODE,
      identity_verified: false,
      error: raw.error || raw.failure?.message || 'bar snapshot failed',
      failure: raw.failure && typeof raw.failure === 'object' ? raw.failure : {
        code: 'snapshot_failed',
        message: raw.error || 'bar snapshot failed',
      },
      records: [],
      symbol: raw.symbol,
      timeframe: raw.timeframe,
      active_bar_time: raw.active_bar_time,
    };
  }
  if (raw.capture_mode !== BAR_SNAPSHOT_CAPTURE_MODE) {
    return failClosed('invalid_response', 'page response is not a plot_list snapshot');
  }
  if (raw.identity_verified !== true) {
    return failClosed('identity_unverified', 'snapshot did not verify chart identity');
  }
  if (typeof raw.symbol !== 'string' || raw.symbol.trim() === ''
      || typeof raw.timeframe !== 'string' || raw.timeframe.trim() === '') {
    return failClosed('identity_unavailable', 'complete response is missing symbol or timeframe');
  }
  if (raw.active_bar_time == null || !Number.isFinite(Number(raw.active_bar_time))) {
    return failClosed('active_bar_unavailable', 'complete response is missing active_bar_time');
  }
  if (!Array.isArray(raw.records) || raw.records.length === 0) {
    return failClosed('bar_not_found', 'complete response has no records');
  }
  const forwardPane = Array.isArray(options.after_time_by_pane)
    && Number.isInteger(raw.pane_index)
    && options.after_time_by_pane[raw.pane_index] != null;
  if (!forwardPane && raw.records.length !== options.count) {
    return failClosed('insufficient_bars', 'complete response did not return the requested bar count', {
      requested: options.count,
      returned: raw.records.length,
    });
  }
  if (forwardPane) {
    const cursorTime = Number(options.after_time_by_pane[raw.pane_index]);
    if (raw.records.length < 1 || raw.records.length > options.count + 1
        || Number(raw.cursor_time) !== cursorTime
        || Number(raw.records[0]?.bar_time) !== cursorTime
        || typeof raw.has_more !== 'boolean') {
      return failClosed('invalid_response', 'forward pane response has an invalid cursor window');
    }
    if (raw.has_more && raw.records.length !== options.count + 1) {
      return failClosed('invalid_response', 'forward pane with has_more=true did not return a full page');
    }
  }
  for (let index = 0; index < raw.records.length; index += 1) {
    const record = raw.records[index];
    if (!record || record.bar_time == null || !record.ohlcv || typeof record.ohlcv !== 'object') {
      return failClosed('bar_incomplete', `record ${index + 1} is missing bar time or OHLCV`);
    }
    if (options.closed_only && (record.closed !== true || record.bar_time === raw.active_bar_time)) {
      return failClosed('active_bar_excluded', 'closed_only snapshot included the active bar');
    }
    if (options.study_filters.length > 0) {
      const names = Array.isArray(record.studies) ? record.studies.map(study => study && study.name) : [];
      const missing = options.study_filters.filter(filter => !names.some(name => typeof name === 'string' && name.includes(filter)));
      if (missing.length > 0) {
        return failClosed('no_matching_study', 'complete response is missing a filtered study', { missing });
      }
    }
    const entityIds = [];
    for (const study of Array.isArray(record.studies) ? record.studies : []) {
      if (!study || typeof study.entity_id !== 'string' || study.entity_id.trim() === '') {
        return failClosed('study_identity_unavailable', `record ${index + 1} has a study without entity_id`, {
          study_name: study && study.name,
        });
      }
      if (entityIds.includes(study.entity_id)) {
        return failClosed('study_identity_duplicate', `record ${index + 1} has duplicate study entity_id`, {
          entity_id: study.entity_id,
        });
      }
      entityIds.push(study.entity_id);
    }
  }
  if (!Number.isInteger(raw.stable_polls) || raw.stable_polls < options.stable_polls) {
    return failClosed('snapshot_unstable', 'complete response did not meet stable_polls');
  }
  return raw;
}

export async function getBarSnapshot(options = {}) {
  const parsed = parseBarSnapshotOptions(options);
  const { evaluateAsync } = resolve(options._deps);
  const raw = await evaluateAsync(buildBarSnapshotExpression(parsed));
  return hydrateBarSnapshot(validateBarSnapshotResult(raw, parsed));
}

export async function getReplayBarSnapshot(options = {}) {
  const parsed = parseReplayBarSnapshotOptions(options);
  const { evaluateAsync } = resolve(options._deps);
  const raw = await evaluateAsync(buildBarSnapshotExpression(parsed));
  if (!raw || raw.success !== true) return validateBarSnapshotResult(raw, parsed);
  const expanded = expandCompactReplaySnapshot(raw);
  const validated = validateBarSnapshotResult(expanded, parsed);
  return compactValidatedReplaySnapshot(validated, raw);
}

export async function getBarHistory(options = {}) {
  const parsed = parseBarHistoryOptions(options);
  const { evaluateAsync } = resolve(options._deps);
  const raw = await evaluateAsync(buildBarSnapshotExpression(parsed));
  if (!raw || raw.success !== true) return validateBarSnapshotResult(raw, parsed);
  const expanded = expandCompactReplaySnapshot(raw);
  const validated = validateBarSnapshotResult(expanded, parsed);
  return compactValidatedReplaySnapshot(validated, raw);
}

function expandCompactReplaySnapshot(raw) {
  if (raw.capture_mode !== 'plot_list.compact.raw.v1'
      || !Array.isArray(raw.study_definitions) || !Array.isArray(raw.records)) {
    return raw;
  }
  return {
    ...raw,
    capture_mode: BAR_SNAPSHOT_CAPTURE_MODE,
    records: raw.records.map(record => ({
      bar_time: record.bar_time,
      closed: record.closed,
      ohlcv: record.ohlcv,
      studies: Array.isArray(record.study_rows)
        ? record.study_rows.map((studyRow, index) => ({
            ...raw.study_definitions[index],
            entity_id: studyRow && studyRow.entity_id,
            row: studyRow && studyRow.row,
          }))
        : [],
    })),
  };
}

function compactColor(color) {
  if (!color || typeof color !== 'object') return null;
  return [color.hex ?? null, color.alpha ?? null];
}

function compactValidatedReplaySnapshot(snapshot, compactRaw) {
  if (!snapshot || snapshot.success !== true || !Array.isArray(snapshot.records)) return snapshot;
  if (!compactRaw || !Array.isArray(compactRaw.study_definitions)
      || !Array.isArray(compactRaw.records)) return snapshot;
  const definitions = compactRaw.study_definitions.map(definition => (
    hydrateStudyFromPlotList({ ...definition, row: [] })
  ));
  return {
    success: true,
    capture_mode: 'plot_list.compact.v1',
    identity_verified: snapshot.identity_verified === true,
    stable_polls: snapshot.stable_polls,
    symbol: snapshot.symbol,
    timeframe: snapshot.timeframe,
    active_bar_time: snapshot.active_bar_time,
    study_definitions: definitions.map(study => ({
      entity_id: study.entity_id,
      name: study.name,
      history_calculation_may_change: study.history_calculation_may_change,
      manifest: study.manifest,
    })),
    records: compactRaw.records.map(record => ({
      bar_time: record.bar_time,
      closed: record.closed,
      ohlcv: record.ohlcv,
      study_values: record.study_rows.map((studyRow, index) => {
        const definition = compactRaw.study_definitions[index];
        const plots = mapPlotListRow(definition.meta, studyRow.row);
        const fills = parseFilledAreas(definition.meta, studyRow.row, plots);
        return {
          entity_id: studyRow.entity_id,
          plots: plots.map(plot => [plot.value, compactColor(plot.color)]),
          fills: fills.map(fill => [fill.upper, fill.lower, compactColor(fill.color)]),
        };
      }),
    })),
  };
}

export function hydratePaneScan(raw) {
  if (!raw || raw.success !== true || !Array.isArray(raw.panes)) return raw;
  return {
    ...raw,
    panes: raw.panes.map(pane => ({
      ...hydrateBarSnapshot(pane),
      pane_index: pane.pane_index,
    })),
  };
}

export function validatePaneScanResult(raw, options) {
  if (!raw || typeof raw !== 'object' || raw.success !== true) {
    const failed = validateBarSnapshotResult(raw, options);
    return { ...failed, pane_count: 0, panes: [] };
  }
  if (!Number.isInteger(raw.pane_count) || raw.pane_count < 1
      || !Array.isArray(raw.panes) || raw.panes.length !== raw.pane_count) {
    return { ...failClosed('invalid_response', 'page response has an invalid pane layout'), pane_count: 0, panes: [] };
  }
  for (let paneIndex = 0; paneIndex < raw.panes.length; paneIndex += 1) {
    const pane = raw.panes[paneIndex];
    if (!pane || pane.pane_index !== paneIndex) {
      return { ...failClosed('layout_changed', 'page response has an invalid pane order', { pane_index: paneIndex }), pane_count: 0, panes: [] };
    }
    const validated = validateBarSnapshotResult({
      ...pane,
      identity_verified: raw.identity_verified,
      stable_polls: raw.stable_polls,
    }, options);
    if (validated.success !== true) {
      return {
        ...validated,
        failure: { ...validated.failure, pane_index: paneIndex },
        pane_count: raw.pane_count,
        panes: [],
      };
    }
  }
  return raw;
}

export async function scanPanes(options = {}) {
  const parsed = parsePaneScanOptions(options);
  const { evaluateAsync } = resolve(options._deps);
  const raw = await evaluateAsync(buildPaneScanExpression(parsed));
  return hydratePaneScan(validatePaneScanResult(raw, parsed));
}
