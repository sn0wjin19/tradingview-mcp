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
import { hydrateStudyFromPlotList } from './plot_list.js';

export const BAR_SNAPSHOT_CAPTURE_MODE = 'plot_list';
export const MAX_BAR_SNAPSHOT_COUNT = 20;
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
      function chartIdentity(chart) {
        try {
          var symbol = typeof chart.symbol === 'function' ? chart.symbol() : null;
          var timeframe = typeof chart.resolution === 'function' ? chart.resolution() : null;
          if (typeof symbol !== 'string' || symbol.trim() === ''
              || typeof timeframe !== 'string' || timeframe.trim() === '') return null;
          return { symbol: symbol, timeframe: timeframe };
        } catch (error) {
          return null;
        }
      }
      function mainSeriesBars(chart) {
        try { return chart._chartWidget.model().mainSeries().bars(); }
        catch (error) { return null; }
      }
      function chartSources(chart) {
        try { return chart._chartWidget.model().model().dataSources(); }
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
      function locateBars(bars) {
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
        if (opt.time != null) {
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
        var startIndex = endIndex - opt.count + 1;
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
        return { activeTime: activeTime, records: records };
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
              name: study.name,
              history_calculation_may_change: !!(study.meta && study.meta.historyCalculationMayChange),
              meta: study.meta,
              row: cloneRow(row)
            });
          }
          studiesByBar.push(studies);
        }
        return { studiesByBar: studiesByBar };
      }
      function fingerprint(snapshot) {
        return JSON.stringify({
          symbol: snapshot.symbol,
          timeframe: snapshot.timeframe,
          active_bar_time: snapshot.active_bar_time,
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
      function observe() {
        var chart = chartWidget();
        if (!chart) return fail('chart_unavailable', 'Active chart widget is unavailable');
        var identity = chartIdentity(chart);
        if (!identity) return fail('identity_unavailable', 'Chart symbol/timeframe identity is unavailable');
        var located = locateBars(mainSeriesBars(chart));
        if (located.error) return located.error;
        var studies = readStudies(chart, chartSources(chart), located.records);
        if (studies.error) return studies.error;
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
        return {
          success: true,
          capture_mode: 'plot_list',
          symbol: identity.symbol,
          timeframe: identity.timeframe,
          active_bar_time: located.activeTime,
          records: records
        };
      }

      var stable = 0;
      var previousFingerprint = null;
      var previousIdentity = null;
      var lastComplete = null;
      for (var attempt = 0; attempt < opt.pollAttempts; attempt += 1) {
        var snapshot = observe();
        if (!snapshot || snapshot.success !== true) {
          if (snapshot && snapshot.failure && (
            snapshot.failure.code === 'identity_unavailable'
            || snapshot.failure.code === 'no_matching_study'
            || snapshot.failure.code === 'bar_not_found'
            || snapshot.failure.code === 'active_bar_excluded'
            || snapshot.failure.code === 'main_series_unavailable'
            || snapshot.failure.code === 'chart_unavailable'
            || snapshot.failure.code === 'study_identity_unavailable'
            || snapshot.failure.code === 'study_identity_duplicate'
          )) {
            return snapshot;
          }
          stable = 0;
          previousFingerprint = null;
          lastComplete = snapshot;
        } else {
          if (previousIdentity
              && (previousIdentity.symbol !== snapshot.symbol || previousIdentity.timeframe !== snapshot.timeframe)) {
            return fail('identity_mismatch', 'Chart symbol/timeframe changed before the snapshot was stable', {
              previous: previousIdentity,
              current: { symbol: snapshot.symbol, timeframe: snapshot.timeframe }
            });
          }
          previousIdentity = { symbol: snapshot.symbol, timeframe: snapshot.timeframe };
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
            return lastComplete;
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
  if (raw.records.length !== options.count) {
    return failClosed('insufficient_bars', 'complete response did not return the requested bar count', {
      requested: options.count,
      returned: raw.records.length,
    });
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
