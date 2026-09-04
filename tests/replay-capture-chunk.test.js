/**
 * Focused unit tests for the no-autoplay replay capture checkpoint tool.
 * These exercise the Node boundary; no live TradingView or CDP connection is
 * required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplayCaptureChunkExpression,
  captureChunk,
  MAX_ACTIVE_READY_TIMEOUT_MS,
  MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS,
  replayResolutionToSeconds,
  selectCurrentOrMaxXReplayLabels,
  stableReplayLabelIdentity,
  stop,
  validateCaptureChunkBars,
  validateReplayCaptureChunkResult,
} from '../src/core/replay.js';
import {
  buildLiveCapture0822ClosedExpression,
  capture0822Closed,
  validateLiveCaptureCount,
} from '../src/core/live_capture_0822.js';
import { registerDataTools } from '../src/tools/data.js';

const TREND_0822 = '趋势过滤器 | 百万Eric | 0822';
const SWING_0822 = '波段过滤器 | 百万Eric | 0822';
const TRAINER_0906 = '一百单实盘训练器 | 百万Eric | 0906';
const TREND_SHAPE_PLOTS = [
  [8, 'TL', '顺势多'], [10, 'TL', 'TL'],
  [12, 'TS', '顺势空'], [14, 'TS', 'TS'],
  [16, 'PB', '回调'], [18, 'PB', 'PB'],
  [20, 'RB', '反弹'], [22, 'RB', 'RB'],
  [24, 'RL', '区间反弹'], [26, 'RL', 'RL'],
  [28, 'RS', '区间回落'], [30, 'RS', 'RS'],
  [32, 'TZ', '潜在顶部'], [34, 'TZ', 'TZ'],
  [36, 'BZ', '潜在底部'], [38, 'BZ', 'BZ'],
];
const TREND_CORE_VALUES = {
  EMA1: '100', EMA2: '101', EMA3: '102', EMA4: '103',
  TL: 0, TS: 0, PB: 0, RB: 0, RL: 0, RS: 0, TZ: 0, BZ: 0,
};
const SWING_CORE_VALUES = {
  背离线: 1,
  超买区域: 2,
  超卖区域: 0,
};

it('exports the Replay limits consumed by the MCP tool schema', () => {
  assert.equal(MAX_ACTIVE_READY_TIMEOUT_MS, 120000);
  assert.equal(MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS, 50000);
});

it('derives fixed Replay readiness intervals from TradingView resolutions', () => {
  assert.equal(replayResolutionToSeconds('5'), 300);
  assert.equal(replayResolutionToSeconds('30'), 1800);
  assert.equal(replayResolutionToSeconds('240'), 14400);
  assert.equal(replayResolutionToSeconds('1D'), 86400);
  assert.equal(replayResolutionToSeconds('D'), 86400);
  assert.equal(replayResolutionToSeconds('4h'), 14400);
  assert.equal(replayResolutionToSeconds('1M'), null, 'monthly bars are calendar-relative, not a fixed duration');
});

function coreField(title, value, valuePresent = true) {
  return { title, value_present: valuePresent, value: valuePresent ? value : null };
}

function trendCoreFields(values = TREND_CORE_VALUES) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, coreField(key, value)]));
}

function swingCoreFields(values = SWING_CORE_VALUES) {
  return {
    DIVERGENCE_LINE: coreField('背离线', values.背离线),
    OVERBOUGHT_ZONE: coreField('超买区域', values.超买区域),
    OVERSOLD_ZONE: coreField('超卖区域', values.超卖区域),
  };
}

function makeRecord({
  activeTime = 100,
  confirmedTime = activeTime,
  nextTime = activeTime + 5,
  stepCount = 1,
  labels = [],
  newlyVisibleLabels = [],
  seenLabelKeysAfter = [],
  activeLogicalIndex = null,
  shapeStateInitializedAfter = true,
} = {}) {
  return {
    schema_version: '0822-replay.v4/post_target_final_label_epoch',
    label_identity_version: 'pine-label/v4/physical-epoch',
    feature_phase: 'post_target_final',
    ohlcv_phase: 'post_target_final',
    sequence: 1,
    capture_phase: 'pre_step_preview_confirmed_post_step_final',
    active_bar: { time: activeTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    pre_step_active_bar: { time: activeTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    observed_active_open_time: activeTime,
    target_open_time: activeTime,
    target_bar: { time: activeTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    availability_open_time: nextTime,
    study_observation_phase: 'post_target_final',
    raw_study_values: {
      success: true,
      observation_phase: 'post_target_final',
      observation_open_time: activeTime,
      target_open_time: activeTime,
      source: 'plot_list_closed_row',
      study_count: 2,
      studies: [
        {
          name: TREND_0822,
          study_value_source: 'plot_list_closed_row',
          observed_open_time: activeTime,
          row_time: activeTime,
          target_row_read_ok: true,
          data_window_read_ok: true,
          data_window_core_ok: true,
          core_fields: trendCoreFields(),
          values: TREND_CORE_VALUES,
        },
        {
          name: SWING_0822,
          study_value_source: 'plot_list_closed_row',
          observed_open_time: activeTime,
          row_time: activeTime,
          target_row_read_ok: true,
          data_window_read_ok: true,
          data_window_core_ok: true,
          core_fields: swingCoreFields(),
          values: SWING_CORE_VALUES,
        },
      ],
    },
    shape_values: {
      success: true,
      observation_phase: 'post_target_final',
      observation_open_time: activeTime,
      target_open_time: activeTime,
      source: 'plot_list_closed_row',
      study_count: 1,
      studies: [{
        source: TREND_0822,
        study_name: TREND_0822,
        study_value_source: 'plot_list_closed_row',
        target_row_read_ok: true,
        active_open_time: activeTime,
        row_time: activeTime,
        available: true,
        shape_fields: [{
          plot_id: 'plot_8',
          row_index: 9,
          code: 'TL',
          title: '顺势多',
          text: '顺势多',
          value_present: true,
          value: 0,
        }],
      }],
    },
    plotshape_signals: [],
    plotshape_scan_phase: 'post_target_final',
    plotshape_scan_observed_active_open_time: activeTime,
    plotshape_scan_first_visible_open_time: nextTime,
    seen_shape_keys_after: [],
    shape_state_initialized_after: shapeStateInitializedAfter,
    raw_pine_labels: {
      success: true,
      label_identity_version: 'pine-label/v4/physical-epoch',
      observation_phase: 'post_availability_next_active',
      observation_open_time: nextTime,
      target_open_time: activeTime,
      study_count: 2,
      active_logical_index: activeLogicalIndex,
      studies: [
        {
          name: TREND_0822,
          label_read_ok: true,
          label_collection_available: false,
          label_read_reason: 'trend_labels_optional_unavailable',
          selection: 'none',
          labels,
        },
        {
          name: SWING_0822,
          label_read_ok: true,
          label_collection_available: true,
          selection: 'current_x',
          labels: [{
            id: 'swing-current',
            source_label_identity: stableReplayLabelIdentity(SWING_0822, { id: 'swing-current' }),
            text: '1', price: 1, x: nextTime,
            observed_at: nextTime, observed_at_open_time: nextTime, selection: 'current_x',
            label_coordinate_kind: 'time',
            label_coordinate_value: nextTime,
            label_coordinate_active: nextTime,
            label_coordinate_comparable: true,
          }],
        },
      ],
    },
    newly_visible_labels: newlyVisibleLabels,
    seen_label_keys_after: seenLabelKeysAfter,
    confirmed_bar: { time: confirmedTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    confirmed_closed_open_time: confirmedTime,
    next_active_open_time: nextTime,
    label_observation_open_time: nextTime,
    confirmation_poll_attempt: 1,
    post_step_closed_bar_stable_polls: 4,
    post_target_stable_polls: 4,
    post_target_quiet_ms: 1500,
    step_count: stepCount,
  };
}

function depsReturning(raw, expressions = []) {
  const lastRecord = Array.isArray(raw?.records) ? raw.records.at(-1) : null;
  const normalized = raw && typeof raw === 'object' ? {
    ...raw,
    schema_version: raw.schema_version || '0822-replay.v4/post_target_final_label_epoch',
    label_identity_version: raw.label_identity_version || 'pine-label/v4/physical-epoch',
    feature_phase: raw.feature_phase || 'post_target_final',
    ohlcv_phase: raw.ohlcv_phase || 'post_target_final',
    seen_shape_keys_after: Array.isArray(raw.seen_shape_keys_after)
      ? raw.seen_shape_keys_after
      : (Array.isArray(lastRecord?.seen_shape_keys_after) ? lastRecord.seen_shape_keys_after : []),
    shape_state_initialized_after: typeof raw.shape_state_initialized_after === 'boolean'
      ? raw.shape_state_initialized_after
      : (typeof lastRecord?.shape_state_initialized_after === 'boolean'
        ? lastRecord.shape_state_initialized_after
        : true),
    seen_label_keys_after: Array.isArray(raw.seen_label_keys_after)
      ? raw.seen_label_keys_after
      : (Array.isArray(lastRecord?.seen_label_keys_after) ? lastRecord.seen_label_keys_after : []),
  } : raw;
  return {
    getReplayApi: async () => 'window.fakeReplay',
    evaluateAsync: async expression => {
      expressions.push(expression);
      return normalized;
    },
  };
}

function makePageRuntime(timeline, {
  clockDelayWaits = 0,
  neverAdvanceClock = false,
  preStepFrames = null,
  cyclePreStepFrames = false,
  advancePreStepFrameOnSleep = true,
  advancePreStepFrameOnStudyReadNumber = null,
  postStepFrames = null,
  cyclePostStepFrames = false,
  advancePostStepFrameOnSleep = true,
  studyFrames = null,
  cycleStudyFrames = false,
  advanceStudyFrameOnLabelRead = false,
  advanceStudyFrameOnLabelReadNumber = null,
  shapeFrames = null,
  cycleShapeFrames = false,
  advanceShapeFrameOnSleep = true,
  shapeScanFrames = null,
  advanceShapeFrameOnLabelRead = false,
  advanceShapeFrameOnStep = false,
  labelFrames = null,
  cycleLabelFrames = false,
  advanceLabelFrameOnSleep = true,
  advanceLabelFrameOnLabelReadNumber = null,
  swingLabelCollectionFrames = null,
  cycleSwingLabelCollectionFrames = false,
  trainerVisible = false,
  trendGraphicsMode = 'normal',
  trendMetaMode = 'period_titles',
  logicalIndexOffset = 0,
  trendEachThrows = false,
  resolution = '5',
  barTimeCloseByOpen = {},
} = {}) {
  let cursor = 0;
  let steps = 0;
  let preStepFrame = 0;
  let postStepFrame = -1;
  let studyFrame = 0;
  let shapeFrame = 0;
  let labelFrame = 0;
  let swingLabelCollectionFrame = 0;
  let studyReadCount = 0;
  let labelReadCount = 0;
  let mainSeriesSearchCount = 0;
  let trendEachCalls = 0;
  const steppedActiveCloses = [];
  const activeCloseTime = bars => {
    const active = bars.at(-1)[0];
    const suppliedClose = Number(barTimeCloseByOpen[active]);
    if (Number.isFinite(suppliedClose) && suppliedClose > active) return suppliedClose - 1;
    const nominalSeconds = replayResolutionToSeconds(resolution);
    if (nominalSeconds !== null) return active + nominalSeconds - 1;
    const previous = bars.at(-2)[0];
    return active + (active - previous) - 1;
  };
  // TradingView label coordinates use the series' stable logical index, rather
  // than the position in the currently materialized recent-bars window. Keep a
  // single index map across the fixture timeline so a bar that falls out of the
  // local window does not make a future label appear permanently future.
  const logicalTimes = [...new Set([
    ...timeline,
    ...(Array.isArray(preStepFrames) ? preStepFrames : []),
    ...(Array.isArray(postStepFrames) ? postStepFrames : []),
  ].flatMap(frame => (Array.isArray(frame) ? frame : []))
    .map(bar => bar?.[0])
    .filter(Number.isFinite))].sort((left, right) => left - right);
  const logicalIndexForTime = time => {
    const localIndex = logicalTimes.indexOf(time);
    return localIndex < 0 ? -1 : localIndex + logicalIndexOffset;
  };
  const currentBars = () => {
    if (cursor === 0 && Array.isArray(preStepFrames) && preStepFrames.length > 0) {
      const index = cyclePreStepFrames
        ? preStepFrame % preStepFrames.length
        : Math.min(preStepFrame, preStepFrames.length - 1);
      return preStepFrames[index];
    }
    if (cursor > 0 && Array.isArray(postStepFrames) && postStepFrames.length > 0) {
      const frame = Math.max(0, postStepFrame);
      const index = cyclePostStepFrames
        ? frame % postStepFrames.length
        : Math.min(frame, postStepFrames.length - 1);
      return postStepFrames[index];
    }
    return timeline[Math.min(cursor, timeline.length - 1)];
  };
  const currentStudyFrame = () => {
    if (!Array.isArray(studyFrames) || studyFrames.length === 0) return null;
    const index = cycleStudyFrames
      ? studyFrame % studyFrames.length
      : Math.min(studyFrame, studyFrames.length - 1);
    return studyFrames[index];
  };
  const studyItems = (key, fallback) => {
    studyReadCount += 1;
    if (Number.isInteger(advancePreStepFrameOnStudyReadNumber)
        && studyReadCount === advancePreStepFrameOnStudyReadNumber
        && cursor === 0 && Array.isArray(preStepFrames) && preStepFrames.length > 1) {
      preStepFrame += 1;
    }
    const frame = currentStudyFrame();
    const overrides = frame && Object.prototype.hasOwnProperty.call(frame, key) ? frame[key] : {};
    const values = { ...fallback, ...overrides };
    return Object.entries(values).map(([title, value]) => ({ _title: title, _value: value }));
  };
  const currentShapeFrame = () => {
    if (!Array.isArray(shapeFrames) || shapeFrames.length === 0) return null;
    const index = cycleShapeFrames
      ? shapeFrame % shapeFrames.length
      : Math.min(shapeFrame, shapeFrames.length - 1);
    return shapeFrames[index];
  };
  const currentShapeScanFrame = () => {
    if (!Array.isArray(shapeScanFrames) || shapeScanFrames.length === 0) return currentShapeFrame();
    const index = cycleShapeFrames
      ? shapeFrame % shapeScanFrames.length
      : Math.min(shapeFrame, shapeScanFrames.length - 1);
    return shapeScanFrames[index];
  };
  const currentLabelFrame = () => {
    if (!Array.isArray(labelFrames) || labelFrames.length === 0) return null;
    const index = cycleLabelFrames
      ? labelFrame % labelFrames.length
      : Math.min(labelFrame, labelFrames.length - 1);
    return labelFrames[index];
  };
  const labelMapForActiveBar = () => {
    const activeTime = currentBars().at(-1)[0];
    const frame = currentLabelFrame();
    const rows = Array.isArray(frame)
      ? frame
      : [{ id: `swing-${activeTime}`, t: '1', y: 1, x: activeTime }];
    return new Map(rows.map((row, index) => [
      row.id === undefined || row.id === null ? `swing-${activeTime}-${index}` : String(row.id),
      { t: row.t, y: row.y, x: row.x, yl: row.yl },
    ]));
  };
  const swingLabelCollectionAvailable = () => {
    if (!Array.isArray(swingLabelCollectionFrames) || swingLabelCollectionFrames.length === 0) return true;
    const index = cycleSwingLabelCollectionFrames
      ? swingLabelCollectionFrame % swingLabelCollectionFrames.length
      : Math.min(swingLabelCollectionFrame, swingLabelCollectionFrames.length - 1);
    return swingLabelCollectionFrames[index] === true;
  };
  const trendShapeRow = (time, frame = currentShapeFrame()) => {
    const values = frame || {};
    const studyValues = { ...TREND_CORE_VALUES, ...(currentStudyFrame()?.trend || {}) };
    const row = Array(40).fill(null);
    row[0] = time;
    row[1] = studyValues.EMA1;
    row[3] = studyValues.EMA2;
    row[5] = studyValues.EMA3;
    row[7] = studyValues.EMA4;
    for (const [plotIndex, code, title] of TREND_SHAPE_PLOTS) {
      // The live 0822 pair exposes the Chinese display plot as the non-zero
      // shape and the short-code companion as 0. Keep the fixture faithful so
      // semantic de-duplication is tested without inventing a duplicate signal.
      row[plotIndex + 1] = title === code
        ? 0
        : (Object.prototype.hasOwnProperty.call(values, code) ? values[code] : 0);
    }
    return row;
  };
  const trendShapeRows = () => currentBars().map((bar, index) => ({ index, value: trendShapeRow(bar[0]) }));
  const trendShapeRowsForScan = () => currentBars().map((bar, index) => ({
    index,
    value: trendShapeRow(bar[0], currentShapeScanFrame()),
  }));
  const trendMeta = () => {
    const plots = Array.from({ length: 39 }, (_, index) => ({ id: `plot_${index}`, type: 'line' }));
    const styles = {};
    const emaTitles = trendMetaMode === 'legacy_ema_titles_with_colorer'
      ? [[0, 'EMA1'], [2, 'EMA2'], [4, 'EMA3'], [6, 'EMA4']]
      : (trendMetaMode === 'missing_ema_titles_with_colorer'
        ? []
        : [[0, 'EMA21'], [2, 'EMA55'], [4, 'EMA100'], [6, 'EMA200']]);
    if (trendMetaMode === 'legacy_ema_titles_with_colorer'
        || trendMetaMode === 'missing_ema_titles_with_colorer') {
      for (const plotIndex of [1, 3, 5]) {
        plots[plotIndex] = { id: `plot_${plotIndex}`, type: 'colorer' };
      }
    }
    for (const [plotIndex, title] of emaTitles) {
      styles[`plot_${plotIndex}`] = { title, text: title };
    }
    for (const [plotIndex, code, title] of TREND_SHAPE_PLOTS) {
      plots[plotIndex] = { id: `plot_${plotIndex}`, type: 'shapes' };
      styles[`plot_${plotIndex}`] = { title, text: title === code ? code : title };
    }
    return {
      description: TREND_0822,
      historyCalculationMayChange: true,
      plots,
      styles,
    };
  };
  let replayCurrentDate = activeCloseTime(currentBars());
  let pendingReplayCurrentDate = null;
  let remainingClockWaits = 0;
  const valueWithTimeClose = row => {
    if (!row) return row;
    const value = [...row];
    const suppliedClose = Number(barTimeCloseByOpen[row[0]]);
    if (Number.isFinite(suppliedClose) && suppliedClose > row[0]) value.timeClose = suppliedClose;
    return value;
  };
  const bars = {
    firstIndex: () => logicalIndexForTime(currentBars()[0]?.[0]),
    lastIndex: () => logicalIndexForTime(currentBars().at(-1)?.[0]),
    valueAt: index => {
      const time = logicalTimes[index - logicalIndexOffset];
      return valueWithTimeClose(currentBars().find(bar => bar[0] === time));
    },
    searchByTime: time => {
      mainSeriesSearchCount += 1;
      const localIndex = currentBars().findIndex(bar => bar[0] === time);
      if (localIndex < 0) return null;
      const logicalIndex = logicalIndexForTime(time);
      return {
        index: logicalIndex >= 0 ? logicalIndex : localIndex,
        value: valueWithTimeClose(currentBars()[localIndex]),
      };
    },
  };
  const trend = {
    metaInfo: trendMeta,
    isVisible: () => true,
    dataWindowView: () => ({ items: () => studyItems('trend', TREND_CORE_VALUES) }),
    get _data() {
      return {
        searchByTime: time => trendShapeRows().find(entry => entry.value[0] === time) || null,
        each: callback => {
          trendEachCalls += 1;
          if (trendEachThrows) throw new Error('full-history trend iteration is forbidden');
          trendShapeRowsForScan().forEach(entry => callback(entry.index, entry.value));
        },
      };
    },
    get _graphics() {
      if (trendGraphicsMode === 'missing_graphics') return null;
      if (trendGraphicsMode === 'missing_dwglabels') return { _primitivesCollection: {} };
      if (trendGraphicsMode === 'missing_map') {
        return { _primitivesCollection: { dwglabels: { get: () => ({ get: () => ({}) }) } } };
      }
      return {
        _primitivesCollection: {
          dwglabels: { get: () => ({ get: () => ({ _primitivesDataById: new Map() }) }) },
        },
      };
    },
  };
  const trainer = {
    metaInfo: () => ({
      description: TRAINER_0906,
      plots: [0, 1, 2, 3].map(index => ({ id: `plot_${index}`, type: 'line' })),
      styles: {
        plot_0: { title: 'EMA1' }, plot_1: { title: 'EMA2' },
        plot_2: { title: 'EMA3' }, plot_3: { title: 'EMA4' },
      },
    }),
    isVisible: () => trainerVisible,
    dataWindowView: () => ({ items: () => studyItems('trainer', {
      EMA1: '100', EMA2: '101', EMA3: '102', EMA4: '103',
    }) }),
    get _data() {
      const values = { EMA1: '100', EMA2: '101', EMA3: '102', EMA4: '103', ...(currentStudyFrame()?.trainer || {}) };
      const rows = currentBars().map((bar, index) => ({
        index,
        value: [bar[0], values.EMA1, values.EMA2, values.EMA3, values.EMA4],
      }));
      return {
        searchByTime: time => rows.find(entry => entry.value[0] === time) || null,
        each: callback => rows.forEach(entry => callback(entry.index, entry.value)),
      };
    },
  };
  const swing = {
    metaInfo: () => ({
      description: SWING_0822,
      plots: [
        { id: 'swing_plot_0', type: 'line' }, { id: 'swing_plot_1', type: 'line' },
        { id: 'swing_plot_2', type: 'line' }, { id: 'swing_plot_3', type: 'line' },
        { id: 'swing_plot_4', type: 'line' },
      ],
      styles: {
        swing_plot_0: { title: '背离线' },
        swing_plot_2: { title: '超买区域' },
        swing_plot_4: { title: '超卖区域' },
      },
    }),
    isVisible: () => true,
    dataWindowView: () => ({ items: () => studyItems('swing', SWING_CORE_VALUES) }),
    get _data() {
      const values = { ...SWING_CORE_VALUES, ...(currentStudyFrame()?.swing || {}) };
      const rows = currentBars().map((bar, index) => ({
        index,
        value: [bar[0], values.背离线, null, values.超买区域, null, values.超卖区域],
      }));
      return {
        searchByTime: time => rows.find(entry => entry.value[0] === time) || null,
        each: callback => rows.forEach(entry => callback(entry.index, entry.value)),
      };
    },
    get _graphics() {
      if (advanceStudyFrameOnLabelRead && Array.isArray(studyFrames) && studyFrames.length > 0) {
        studyFrame += 1;
      }
      if (advanceShapeFrameOnLabelRead && Array.isArray(shapeFrames) && shapeFrames.length > 0) {
        shapeFrame += 1;
      }
      labelReadCount += 1;
      if (Number.isInteger(advanceStudyFrameOnLabelReadNumber)
          && labelReadCount === advanceStudyFrameOnLabelReadNumber
          && Array.isArray(studyFrames) && studyFrames.length > 0) {
        studyFrame += 1;
      }
      if (Number.isInteger(advanceLabelFrameOnLabelReadNumber)
          && labelReadCount === advanceLabelFrameOnLabelReadNumber
          && Array.isArray(labelFrames) && labelFrames.length > 0) {
        labelFrame += 1;
      }
      if (!swingLabelCollectionAvailable()) return { _primitivesCollection: {} };
      const labels = labelMapForActiveBar();
      return {
        _primitivesCollection: {
          dwglabels: { get: () => ({ get: () => ({
            _primitivesDataById: labels,
          }) }) },
        },
      };
    },
  };
  const chartWidget = {
    model: () => ({
      mainSeries: () => ({ bars: () => bars }),
      model: () => ({ dataSources: () => [trend, swing, trainer] }),
    }),
  };
  const pageWindow = {
    TradingViewApi: {
      _activeChartWidgetWV: { value: () => ({
        _chartWidget: chartWidget,
        symbol: () => 'BYBIT:BTCUSDT.P',
        resolution: () => resolution,
      }) },
      fakeReplay: {
        isReplayStarted: () => true,
        isAutoplayStarted: () => false,
        currentDate: () => replayCurrentDate,
        doStep: () => {
          steppedActiveCloses.push(currentBars().at(-1)[4]);
          steps += 1;
          cursor += 1;
          postStepFrame = -1;
          if (advanceShapeFrameOnStep && Array.isArray(shapeFrames) && shapeFrames.length > 0) {
            shapeFrame += 1;
          }
          pendingReplayCurrentDate = activeCloseTime(currentBars());
          remainingClockWaits = clockDelayWaits;
          if (!neverAdvanceClock && remainingClockWaits === 0) {
            replayCurrentDate = pendingReplayCurrentDate;
            pendingReplayCurrentDate = null;
          }
        },
      },
    },
  };
  return {
    pageWindow,
    getSteps: () => steps,
    getSteppedActiveCloses: () => steppedActiveCloses,
    getMainSeriesSearchCount: () => mainSeriesSearchCount,
    getTrendEachCalls: () => trendEachCalls,
    onSleep: () => {
      if (advancePreStepFrameOnSleep && cursor === 0
          && Array.isArray(preStepFrames) && preStepFrames.length > 1) {
        preStepFrame += 1;
      }
      if (advancePostStepFrameOnSleep && cursor > 0
          && Array.isArray(postStepFrames) && postStepFrames.length > 1) {
        postStepFrame += 1;
      }
      if (Array.isArray(studyFrames) && studyFrames.length > 1) {
        studyFrame += 1;
      }
      if (advanceShapeFrameOnSleep && Array.isArray(shapeFrames) && shapeFrames.length > 1) {
        shapeFrame += 1;
      }
      if (advanceLabelFrameOnSleep && Array.isArray(labelFrames) && labelFrames.length > 1) {
        labelFrame += 1;
      }
      if (Array.isArray(swingLabelCollectionFrames) && swingLabelCollectionFrames.length > 1) {
        swingLabelCollectionFrame += 1;
      }
      if (!pendingReplayCurrentDate || neverAdvanceClock) return;
      remainingClockWaits -= 1;
      if (remainingClockWaits <= 0) {
        replayCurrentDate = pendingReplayCurrentDate;
        pendingReplayCurrentDate = null;
      }
    },
  };
}

async function runPageExpression(runtime, expression) {
  let nowMs = 0;
  const fakeDate = { now: () => nowMs };
  const run = new Function('window', 'setTimeout', 'Date', `return (${expression.trim()});`);
  return run(runtime.pageWindow, (callback, delay = 0) => {
    runtime.onSleep(delay);
    nowMs += Number(delay) || 0;
    callback();
    return 0;
  }, fakeDate);
}

describe('replay_capture_chunk', () => {
  it('validates the 1–25 checkpoint bound before any browser operation', async () => {
    assert.equal(validateCaptureChunkBars(1), 1);
    assert.equal(validateCaptureChunkBars(25), 25);
    assert.throws(() => validateCaptureChunkBars(0), /1 to 25/);
    assert.throws(() => validateCaptureChunkBars(26), /1 to 25/);
    assert.throws(() => validateCaptureChunkBars(1.5), /integer/);

    let touched = false;
    await assert.rejects(
      captureChunk({ bars: 0, _deps: { getReplayApi: async () => { touched = true; } } }),
      /1 to 25/
    );
    assert.equal(touched, false, 'invalid count must not contact TradingView');

    const defaultExpression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.fakeReplay', bars: 1, pollAttempts: 1, pollIntervalMs: 75,
    });
    assert.match(defaultExpression, /var settleMs = 1500;/, 'default follows the proven 5m replay settle interval');

    const tenSecondSettle = await captureChunk({
      bars: 1,
      settle_ms: 10000,
      _deps: depsReturning({ success: true, records: [makeRecord()], steps_invoked: 1, failure: null }),
    });
    assert.equal(tenSecondSettle.complete, true, JSON.stringify(tenSecondSettle));

    let settleTouched = false;
    await assert.rejects(
      captureChunk({
        bars: 1,
        settle_ms: 10001,
        _deps: { getReplayApi: async () => { settleTouched = true; } },
      }),
      /0 to 10000/
    );
    assert.equal(settleTouched, false, 'invalid settle duration must not contact TradingView');
  });

  it('rejects malformed or oversized replay checkpoints without touching TradingView', async () => {
    let touched = false;
    const deps = { getReplayApi: async () => { touched = true; } };
    await assert.rejects(
      captureChunk({
        bars: 1,
        known_shape_keys: ['already-seen'],
        shape_state_initialized: false,
        _deps: deps,
      }),
      /known_shape_keys must be empty/
    );
    assert.equal(touched, false);

    await assert.rejects(
      captureChunk({ bars: 1, known_label_keys: ['波段过滤器::id:12920'], _deps: deps }),
      /pl4: v4 physical-epoch/
    );
    assert.equal(touched, false, 'legacy raw Pine identities must be rejected before any browser operation');

    await assert.rejects(
      captureChunk({ bars: 1, known_label_keys: ['pl4:replay-local-id'], _deps: deps }),
      /pl4: v4 physical-epoch/
    );
    assert.equal(touched, false, 'a prefix without encoded study, physical epoch, and source must also be rejected');

    const tooMany = Array.from(
      { length: MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS + 1 },
      (_, index) => `key-${index}`,
    );
    await assert.rejects(
      captureChunk({ bars: 1, known_label_keys: tooMany, _deps: deps }),
      /at most 50000/
    );
    assert.equal(touched, false);
    assert.throws(() => buildReplayCaptureChunkExpression({
      replayApiPath: 'window.fakeReplay', bars: 1, pollAttempts: 1, pollIntervalMs: 25,
      knownShapeKeys: tooMany, shapeStateInitialized: true,
    }), /at most 50000/);
  });

  it('accepts only a record whose pre-step active bar is post-step closed', async () => {
    const expressions = [];
    const good = makeRecord();
    const accepted = await captureChunk({
      bars: 1,
      _deps: depsReturning({ success: true, records: [good], steps_invoked: 1, failure: null }, expressions),
    });
    assert.equal(accepted.complete, true, JSON.stringify(accepted));
    assert.equal(accepted.records.length, 1);
    assert.equal(accepted.records[0].confirmed_closed_open_time, accepted.records[0].observed_active_open_time);
    assert.equal(expressions.length, 1, 'the chunk is one page-context evaluation');

    const bad = makeRecord({ confirmedTime: 95 });
    const rejected = await captureChunk({
      bars: 1,
      _deps: depsReturning({ success: true, records: [bad], steps_invoked: 1, failure: null }),
    });
    assert.equal(rejected.complete, false);
    assert.equal(rejected.records.length, 0);
    assert.equal(rejected.failure.code, 'invalid_chunk_response');
    assert.match(rejected.failure.message, /not confirmed/);

    const changedOhlcv = makeRecord();
    changedOhlcv.confirmed_bar.close = 1.6;
    const changedRejected = await captureChunk({
      bars: 1,
      _deps: depsReturning({ success: true, records: [changedOhlcv], steps_invoked: 1, failure: null }),
    });
    assert.match(changedRejected.failure.message, /OHLCV target aliases differ/);

    const staleNext = await captureChunk({
      bars: 1,
      _deps: depsReturning({ success: true, records: [makeRecord({ nextTime: 100 })], steps_invoked: 1, failure: null }),
    });
    assert.match(staleNext.failure.message, /numerically later/);

    const v2Rejected = validateReplayCaptureChunkResult({
      records: [makeRecord()],
      steps_invoked: 1,
      seen_shape_keys_after: [],
      shape_state_initialized_after: true,
      seen_label_keys_after: [],
      failure: null,
    }, 1);
    assert.equal(v2Rejected.complete, false);
    assert.match(v2Rejected.failure.message, /post-target-final v4 label-epoch schema/);
  });

  it('normalizes an invalid top-level shape checkpoint to the last confirmed record', () => {
    const record = makeRecord({ shapeStateInitializedAfter: true });
    const result = validateReplayCaptureChunkResult({
      schema_version: '0822-replay.v4/post_target_final_label_epoch',
      label_identity_version: 'pine-label/v4/physical-epoch',
      feature_phase: 'post_target_final',
      ohlcv_phase: 'post_target_final',
      records: [record],
      steps_invoked: 1,
      seen_shape_keys_after: ['unexpected-shape-key'],
      shape_state_initialized_after: false,
      seen_label_keys_after: [],
      failure: null,
    }, 1);

    assert.equal(result.complete, false);
    assert.equal(result.failure.code, 'invalid_chunk_response');
    assert.match(result.failure.message, /checkpoint/);
    assert.deepEqual(result.seen_shape_keys_after, record.seen_shape_keys_after);
    assert.equal(result.shape_state_initialized_after, record.shape_state_initialized_after);
  });

  it('normalizes an invalid top-level label checkpoint to the last confirmed record', () => {
    const record = makeRecord({ seenLabelKeysAfter: ['pl4:checkpoint-study:100:id%3Aconfirmed-label'] });
    const result = validateReplayCaptureChunkResult({
      schema_version: '0822-replay.v4/post_target_final_label_epoch',
      label_identity_version: 'pine-label/v4/physical-epoch',
      feature_phase: 'post_target_final',
      ohlcv_phase: 'post_target_final',
      records: [record],
      steps_invoked: 1,
      seen_shape_keys_after: [],
      shape_state_initialized_after: true,
      seen_label_keys_after: ['pl4:checkpoint-study:105:id%3Aunconfirmed-label'],
      failure: null,
    }, 1);

    assert.equal(result.complete, false);
    assert.match(result.failure.message, /checkpoint/);
    assert.deepEqual(result.seen_label_keys_after, ['pl4:checkpoint-study:100:id%3Aconfirmed-label']);
  });

  it('has one manual doStep call in the page loop and rejects any record claiming more than one step', async () => {
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.fakeReplay',
      bars: 2,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 25,
      settleMs: 0,
    });
    assert.equal((expression.match(/r\.doStep\(\)/g) || []).length, 1, 'source contains one manual step operation inside the loop');
    assert.doesNotMatch(expression, /toggleAutoplay|changeAutoplayDelay/);
    assert.match(expression, /Date\.now\(\) - stableSinceMs >= settleMs/, 'settle_ms is a measured quiet duration, not a blind sleep');
    assert.match(expression, /currentDate\(\)/, 'next manual step is gated on Replay currentDate readiness');

    const doubleStep = await captureChunk({
      bars: 1,
      _deps: depsReturning({ success: true, records: [makeRecord({ stepCount: 2 })], steps_invoked: 2, failure: null }),
    });
    assert.equal(doubleStep.complete, false);
    assert.equal(doubleStep.failure.code, 'invalid_chunk_response');
    assert.match(doubleStep.failure.message, /exactly one replay step/);
  });

  it('awaits public replay_stop completion and throws instead of reporting a stuck stop as success', async () => {
    let publicStopAwaited = false;
    let statusChecks = 0;
    const stopped = await stop({
      _deps: {
        getReplayApi: async () => 'window.fakeReplay',
        evaluate: async () => {
          statusChecks += 1;
          if (statusChecks === 1) return true;
          assert.equal(publicStopAwaited, true, 'status polling starts after public stop completion');
          return false;
        },
        evaluateAsync: async expression => {
          assert.match(expression, /stopReplay\(\)/);
          await Promise.resolve();
          publicStopAwaited = true;
          return true;
        },
      },
    });
    assert.equal(stopped.action, 'replay_stopped');
    assert.equal(stopped.stop_poll_attempt, 1);

    await assert.rejects(stop({
      _deps: {
        getReplayApi: async () => 'window.fakeReplay',
        evaluate: async () => true,
        evaluateAsync: async () => false,
        wait: async () => {},
      },
    }), /stop did not complete.*remains active/);
  });

  it('recovers the known private replay-stopping deadlock only after public stop remains active', async () => {
    let statusChecks = 0;
    const asyncExpressions = [];
    const stopped = await stop({
      _deps: {
        getReplayApi: async () => 'window.fakeReplay',
        evaluate: async () => {
          statusChecks += 1;
          // Initial state, then post-public-stop state are active. The manager
          // recovery makes the next verification inactive.
          return statusChecks < 3;
        },
        evaluateAsync: async expression => {
          asyncExpressions.push(expression);
          if (expression.includes('manager._stopReplay()')) {
            assert.match(expression, /replay\.isReplayStarted\(\)/);
            assert.match(expression, /manager\._isReplayStopping !== true/);
            assert.match(expression, /manager\._isReplayStopping = false/);
            return { attempted: true };
          }
          assert.match(expression, /\.stopReplay\(\)/);
          return true;
        },
        wait: async () => {},
      },
    });

    assert.equal(stopped.action, 'replay_stopped');
    assert.equal(stopped.recovery_attempted, true);
    assert.equal(stopped.stop_poll_attempt, 2);
    assert.equal(asyncExpressions.filter(expression => expression.includes('manager._stopReplay()')).length, 1);
    assert.equal(asyncExpressions.filter(expression => expression.includes('.stopReplay()')).length, 1,
      'the public stop is still called exactly once before the guarded fallback');
  });

  it('runs the page-context loop as one manual step and one confirmed record per bar', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
      [[100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12], [110, 4, 5, 3.5, 4.5, 13]],
    ];
    // Model the observed Desktop ordering: OHLCV exposes the next row first,
    // then Replay currentDate advances only after a couple of UI ticks.
    const runtime = makePageRuntime(timeline, { clockDelayWaits: 2 });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 2,
      pollAttempts: 4,
      pollIntervalMs: 25,
      settleMs: 0,
      activeReadyTimeoutMs: 10000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 4,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(runtime.getSteps(), 2, JSON.stringify(response));
    assert.equal(response.complete, true);
    assert.deepEqual(response.records.map(record => record.observed_active_open_time), [100, 105]);
    assert.deepEqual(response.records.map(record => record.confirmed_closed_open_time), [100, 105]);
    assert.ok(response.records.every(record => record.step_count === 1));
    assert.ok(response.records.every(record => {
      const swingLabels = record.raw_pine_labels.studies.find(study => study.name === SWING_0822).labels;
      return swingLabels[0].observed_at_open_time === record.availability_open_time;
    }));
    assert.equal(response.records[1].active_bar_ready_current_date, 404);
    assert.equal(response.records[1].active_bar_ready_timeframe_seconds, 300);
    assert.ok(response.records[1].active_bar_ready_poll_attempt >= 4);
  });

  it('uses the chart resolution instead of a session gap for Replay readiness', async () => {
    const cases = [
      { label: 'continuous BTC 5m', resolution: '5', nominalSeconds: 300, previousGapSeconds: 300 },
      { label: 'XAUUSD 30m weekend gap', resolution: '30', nominalSeconds: 1800, previousGapSeconds: 2 * 86400 + 1800 },
      { label: 'XAUUSD 4h daily maintenance gap', resolution: '240', nominalSeconds: 14400, previousGapSeconds: 8 * 3600 },
      { label: 'XAUUSD 1D weekend gap', resolution: '1D', nominalSeconds: 86400, previousGapSeconds: 3 * 86400 },
    ];

    for (const scenario of cases) {
      const active = 1_800_000_000;
      const previous = active - scenario.previousGapSeconds;
      const next = active + scenario.nominalSeconds;
      const bar = (time, price) => [time, price, price + 1, price - 1, price + 0.5, 10];
      const runtime = makePageRuntime([
        [bar(previous, 1), bar(active, 2)],
        [bar(previous, 1), bar(active, 2), bar(next, 3)],
      ], { resolution: scenario.resolution });
      const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
        replayApiPath: 'window.TradingViewApi.fakeReplay',
        bars: 1,
        pollAttempts: 4,
        pollIntervalMs: 25,
        settleMs: 0,
        activeReadyTimeoutMs: 2000,
        activeReadyPollIntervalMs: 100,
        activeReadyStablePolls: 2,
        postStepClosedBarStablePolls: 2,
      }));

      assert.equal(response.complete, true, `${scenario.label}: ${JSON.stringify(response)}`);
      assert.equal(response.records[0].active_bar_ready_timeframe_seconds, scenario.nominalSeconds, scenario.label);
      assert.equal(
        response.records[0].active_bar_ready_expected_close_seconds,
        active + scenario.nominalSeconds - 1,
        scenario.label,
      );
      assert.equal(runtime.getSteps(), 1, scenario.label);
    }
  });

  it('uses a TradingView-supplied short-bar close instead of inventing a session calendar', async () => {
    const active = 1_800_000_000;
    const explicitTimeClose = active + 3 * 3600;
    const bar = (time, price) => [time, price, price + 1, price - 1, price + 0.5, 10];
    const runtime = makePageRuntime([
      [bar(active - 4 * 3600, 1), bar(active, 2)],
      [bar(active - 4 * 3600, 1), bar(active, 2), bar(active + 4 * 3600, 3)],
    ], {
      resolution: '240',
      barTimeCloseByOpen: { [active]: explicitTimeClose },
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 4,
      pollIntervalMs: 25,
      settleMs: 0,
      activeReadyTimeoutMs: 2000,
      activeReadyPollIntervalMs: 100,
      activeReadyStablePolls: 2,
      postStepClosedBarStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(response.records[0].active_bar_ready_timeframe_seconds, 14400);
    assert.equal(response.records[0].active_bar_ready_expected_close_seconds, explicitTimeClose - 1);
  });

  it('does not issue the next step when OHLCV advances but currentDate never becomes ready', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, { neverAdvanceClock: true });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 2,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 25,
      settleMs: 0,
      activeReadyTimeoutMs: 10000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 4,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(runtime.getSteps(), 1, 'readiness failure must not retry or issue a second doStep');
    assert.equal(response.complete, false);
    assert.equal(response.records.length, 1);
    assert.equal(response.failure.code, 'active_bar_not_settled');
    assert.equal(response.failure.previous_replay_current_date, 399);
  });

  it('waits through delayed active-OHLCV rendering and only steps the final stable snapshot', async () => {
    const preStepFrames = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.0, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3.2, 1.5, 2.2, 12]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3.5, 1.5, 2.5, 13]],
    ];
    const timeline = [
      preStepFrames.at(-1),
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3.5, 1.5, 2.5, 13], [105, 3, 4, 2.5, 3.5, 14]],
    ];
    const runtime = makePageRuntime(timeline, { preStepFrames });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 500,
      settleMs: 500,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 100,
      activeReadyStablePolls: 4,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(runtime.getSteps(), 1);
    assert.equal(response.records[0].active_bar.close, 2.5);
    assert.deepEqual(runtime.getSteppedActiveCloses(), [2.5], 'doStep receives only the post-render stable OHLCV state');
    assert.ok(response.records[0].active_bar_ready_stable_polls >= 4);
  });

  it('records the post-step finalized same-time OHLCV and PlotList target rows when a preview candle completes during doStep', async () => {
    const target = 1724889600;
    const previous = [target - 300, 80180, 80220, 80150, 80209.3, 20];
    const preview = [target, 80209.3, 80209.3, 80209.3, 80209.3, 18.75325];
    const finalized = [target, 80209.3, 80234.4, 80116, 80116, 75.013];
    const next = [target + 300, 80116, 80150, 80080, 80120, 10];
    const frame = closed => [previous, closed, next];
    const runtime = makePageRuntime([[previous, preview]], {
      // The first post-step observation still exposes the partial candle; the
      // next one is the same timestamp with final OHLCV and remains stable.
      postStepFrames: [frame(preview), frame(finalized), frame(finalized), frame(finalized), frame(finalized)],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 6,
      pollIntervalMs: 100,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 100,
      activeReadyStablePolls: 2,
      // Omitted deliberately: v4's conservative default is four final
      // target-row observations, not the two-poll test override.
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(runtime.getSteps(), 1);
    const record = response.records[0];
    assert.equal(record.schema_version, '0822-replay.v4/post_target_final_label_epoch');
    assert.equal(record.pre_step_active_bar.close, 80209.3);
    assert.equal(record.pre_step_active_bar.volume, 18.75325);
    assert.equal(record.target_open_time, target);
    assert.deepEqual(record.target_bar, {
      time: target, open: 80209.3, high: 80234.4, low: 80116, close: 80116, volume: 75.013,
    });
    assert.deepEqual(record.active_bar, record.target_bar);
    assert.equal(record.raw_study_values.observation_phase, 'post_target_final');
    assert.ok(record.raw_study_values.studies.every(study => study.study_value_source === 'plot_list_closed_row'
      && study.target_row_read_ok === true && study.row_time === target));
    assert.equal(record.post_target_stable_polls, 4);
  });

  it('maps Trend0822 EMAs across interleaved colorers and uses the verified plot-id fallback when metadata is missing', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const expected = [
      ['EMA1', 'plot_0', 1, '100'],
      ['EMA2', 'plot_2', 3, '101'],
      ['EMA3', 'plot_4', 5, '102'],
      ['EMA4', 'plot_6', 7, '103'],
    ];
    for (const [trendMetaMode, mappingSource] of [
      // This mirrors the live metadata layout: legacy EMA1–4 titles and
      // colorer plots between each physical EMA row.
      ['legacy_ema_titles_with_colorer', 'meta_title_alias'],
      ['missing_ema_titles_with_colorer', 'trend0822_fixed_plot_id_fallback'],
    ]) {
      const runtime = makePageRuntime(timeline, { trendMetaMode });
      const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
        replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
        pollAttempts: 3, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
        settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
        activeReadyStablePolls: 2,
      }));

      assert.equal(response.complete, true, `${trendMetaMode}: ${JSON.stringify(response)}`);
      const trend = response.records[0].raw_study_values.studies.find(study => study.name === TREND_0822);
      assert.ok(trend);
      for (const [key, plotId, rowIndex, value] of expected) {
        assert.equal(trend.core_fields[key].value_present, true, `${trendMetaMode} ${key}`);
        assert.equal(trend.core_fields[key].value, value, `${trendMetaMode} ${key}`);
        assert.equal(trend.core_fields[key].plot_id, plotId, `${trendMetaMode} ${key}`);
        assert.equal(trend.core_fields[key].row_index, rowIndex, `${trendMetaMode} ${key}`);
        assert.equal(trend.core_fields[key].mapping_source, mappingSource, `${trendMetaMode} ${key}`);
      }
    }
  });

  it('does not record or re-step when the same target timestamp keeps changing after doStep', async () => {
    const target = 1724889600;
    const previous = [target - 300, 1, 2, 0, 1, 10];
    const preview = [target, 2, 2, 2, 2, 18];
    const finalized = [target, 2, 3, 1, 1, 75];
    const next = [target + 300, 1, 2, 0, 1, 10];
    const frame = closed => [previous, closed, next];
    const runtime = makePageRuntime([[previous, preview]], {
      postStepFrames: [frame(preview), frame(finalized)],
      cyclePostStepFrames: true,
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
      pollAttempts: 5, pollIntervalMs: 75, settleMs: 0,
      activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 100,
      activeReadyStablePolls: 2, postStepClosedBarStablePolls: 2,
    }));

    assert.equal(response.complete, false);
    assert.equal(response.records.length, 0);
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(runtime.getSteps(), 1, 'unstable target evidence must never trigger a retry step');
  });

  it('rejects a post-step time mismatch even when another final row is stable', async () => {
    const target = 1724889600;
    const pre = [[target - 300, 1, 2, 0, 1, 10], [target, 2, 2, 2, 2, 18]];
    const wrong = [[target, 2, 3, 1, 1, 75], [target + 300, 1, 2, 0, 1, 10], [target + 600, 1, 2, 0, 1, 10]];
    const runtime = makePageRuntime([pre], { postStepFrames: [wrong] });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
      pollAttempts: 3, pollIntervalMs: 75, settleMs: 0,
      activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 100,
      activeReadyStablePolls: 2, postStepClosedBarStablePolls: 2,
    }));

    assert.equal(response.complete, false);
    assert.equal(response.records.length, 0);
    assert.equal(response.failure.code, 'post_step_alignment_timeout');
    assert.equal(runtime.getSteps(), 1);
  });

  it('checkpoints without a step when active OHLCV never stabilizes before the bounded deadline', async () => {
    const preStepFrames = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.0, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3.1, 1.5, 2.1, 12]],
    ];
    const runtime = makePageRuntime([preStepFrames[0]], {
      preStepFrames,
      cyclePreStepFrames: true,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 4,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.records.length, 0);
    assert.equal(response.failure.code, 'active_bar_not_settled');
    assert.equal(response.failure.readiness_reason, 'timeout');
    assert.equal(runtime.getSteps(), 0, 'a continuously changing active candle must not consume a Replay step');
  });

  it('treats changing active Data Window values as preview-only and records only the stable post-target row', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [
        { trend: { TL: 'stale-a' }, trainer: { EMA1: '100' } },
        { trend: { TL: 'stale-b' }, trainer: { EMA1: '100' } },
      ],
      cycleStudyFrames: true,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(response.records.length, 1);
    assert.equal(runtime.getSteps(), 1);
    assert.equal(response.records[0].raw_study_values.observation_phase, 'post_target_final');
  });

  it('rejects a changing post-target Trend PlotList shape row after exactly one step', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      shapeFrames: [{ TL: 0 }, { TL: 1 }],
      cycleShapeFrames: true,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.records.length, 0);
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(runtime.getSteps(), 1, 'the already-issued manual step is never retried');
  });

  it('rejects a Pine-label flutter in post-target availability confirmation', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [
        [{ id: 'swing', t: 'pivot-a', y: 1, x: 100 }],
        [{ id: 'swing', t: 'pivot-b', y: 1, x: 100 }],
      ],
      cycleLabelFrames: true,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false, JSON.stringify(response));
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(response.failure.stage, 'post_step_confirmation');
    assert.equal(runtime.getSteps(), 1, 'label flutter never causes a second manual step');
  });

  it('does not let a fluttering future logical-index Pine label block the current target capture', async () => {
    const first = 1700000000;
    const timeline = [
      [[first - 60, 1, 2, 0.5, 1.5, 10], [first, 2, 3, 1.5, 2.5, 11]],
      [[first - 60, 1, 2, 0.5, 1.5, 10], [first, 2, 3, 1.5, 2.5, 11], [first + 60, 3, 4, 2.5, 3.5, 12]],
    ];
    const futureIdentity = stableReplayLabelIdentity(SWING_0822, { id: 'future-logical' });
    const runtime = makePageRuntime(timeline, {
      labelFrames: [
        [
          { id: 'current-logical', t: '1', y: 1, x: 2 },
          { id: 'future-logical', t: 'future-a', y: 1, x: 3 },
        ],
        [
          { id: 'current-logical', t: '1', y: 1, x: 2 },
          { id: 'future-logical', t: 'future-b', y: 1, x: 3 },
        ],
      ],
      cycleLabelFrames: true,
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
      pollAttempts: 3, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 1000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(runtime.getSteps(), 1);
    const record = response.records[0];
    assert.equal(record.raw_pine_labels.active_logical_index, 2);
    assert.equal(record.seen_label_keys_after.includes(futureIdentity), false);
    assert.equal(record.newly_visible_labels.some(label => label.label_identity === futureIdentity), false);
  });

  it('keeps numeric zero and an empty Pine-label text distinct in the stable fingerprint', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [
        [{ id: 'swing', t: 0, y: 1, x: 100 }],
        [{ id: 'swing', t: '', y: 1, x: 100 }],
      ],
      cycleLabelFrames: true,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(runtime.getSteps(), 1);
  });

  it('waits through a stale Pine-label snapshot and steps only once labels are stable', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [
        [{ id: 'swing', t: 'stale', y: 1, x: 100 }],
        [{ id: 'swing', t: 'stable', y: 1, x: 100 }],
        [{ id: 'swing', t: 'stable', y: 1, x: 100 }],
      ],
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(runtime.getSteps(), 1);
    assert.equal(response.records[0].raw_pine_labels.studies.find(study => study.name === SWING_0822).labels[0].text, 'stable');
    assert.equal(response.records[0].newly_visible_labels[0].text, 'stable');
  });

  it('does not persist a target row when labels drift during the post-step availability check', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [
        [{ id: 'swing', t: 'stale', y: 1, x: 100 }],
        [{ id: 'swing', t: 'stable', y: 1, x: 100 }],
        [{ id: 'swing', t: 'stable', y: 1, x: 100 }],
        [{ id: 'swing', t: 'late-redraw', y: 1, x: 100 }],
      ],
      advanceLabelFrameOnLabelReadNumber: 4,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(response.failure.stage, 'post_step_confirmation');
    assert.equal(runtime.getSteps(), 1);
  });

  it('does not treat a non-finite finalized target-row EMA as stable evidence', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [{ trend: { EMA4: Number.NaN }, trainer: { EMA1: '100' } }],
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(runtime.getSteps(), 1);
  });

  it('accepts inactive optional ∅ and null plots when all required core fields are valid', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [{
        trend: { P1: '∅', P2: null, Optional: '' },
        swing: { 二级: '∅', Plot: null },
      }],
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(runtime.getSteps(), 1);
  });

  it('does not step when a required core field is empty or missing', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [{ trend: { EMA4: '' } }],
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false, JSON.stringify(response));
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(runtime.getSteps(), 1);
  });

  it('does not step while the Swing0822 dwglabels collection is transiently unavailable', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      swingLabelCollectionFrames: [true, false],
      cycleSwingLabelCollectionFrames: true,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 1000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'post_step_closed_bar_not_settled');
    assert.equal(runtime.getSteps(), 1);
  });

  it('treats the real Trend0822 graphics-without-dwglabels shape as an explicit readable empty label set', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, { trendGraphicsMode: 'missing_dwglabels' });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1, pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2, activeReadyStudyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    const trendLabels = response.records[0].raw_pine_labels.studies.find(study => study.name === TREND_0822);
    assert.deepEqual(trendLabels.labels, []);
    assert.equal(trendLabels.label_read_ok, true);
    assert.equal(trendLabels.selection, 'none');
    assert.equal(trendLabels.label_read_reason, 'trend_labels_optional_unavailable');
  });

  it('allows a visible trainer0906 as optional compatibility data without making it a requirement', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, { trainerVisible: true });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.ok(response.records[0].raw_study_values.studies.some(study => study.name === TRAINER_0906));
  });

  it('does not let an incomplete visible trainer0906 block the required Trend0822 and Swing0822 snapshot', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      trainerVisible: true,
      studyFrames: [{ trainer: { EMA1: '' } }],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1, pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2, activeReadyStudyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(response.records[0].raw_study_values.studies.some(study => study.name === TRAINER_0906), false);
  });

  it('accepts ∅ Trend signal Data Window fields when EMA fields and PlotList remain valid', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [{ trend: {
        TL: '∅', TS: null, PB: '∅', RB: null,
        RL: '∅', RS: null, TZ: '∅', BZ: null,
      } }],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1, pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2, activeReadyStudyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    const fields = response.records[0].raw_study_values.studies.find(study => study.name === TREND_0822).core_fields;
    assert.equal(fields.TL.value_present, true);
    assert.equal(fields.TL.value, 0);
    assert.equal(fields.TS.value_present, true);
  });

  it('does not use a pre-step Data Window redraw as the finalized target feature row', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [
        { trend: { TL: 'incorrect' }, trainer: { EMA1: '999' } },
        { trend: { TL: '1' }, trainer: { EMA1: '100' } },
        { trend: { TL: '1' }, trainer: { EMA1: '100' } },
      ],
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(runtime.getSteps(), 1);
    assert.deepEqual(runtime.getSteppedActiveCloses(), [2.5]);
    assert.equal(response.records[0].raw_study_values.studies.find(study => study.name === TREND_0822).values.TL, 0);
    assert.equal(response.records[0].study_observation_phase, 'post_target_final');
  });

  it('keeps a late pre-step Data Window redraw out of the finalized target row', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [
        { trend: { TL: '1' }, trainer: { EMA1: '100' } },
        { trend: { TL: '1' }, trainer: { EMA1: '100' } },
        { trend: { TL: '1' }, trainer: { EMA1: '100' } },
        { trend: { TL: '1' }, trainer: { EMA1: '100' } },
        { trend: { TL: 'late-redraw' }, trainer: { EMA1: '100' } },
      ],
      advanceStudyFrameOnLabelReadNumber: 4,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 4,
      activeReadyStudyStablePolls: 4,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(response.records.length, 1);
    assert.equal(runtime.getSteps(), 1);
  });

  it('seeds historical plotshape rows quietly, emits active first-seen signals, and returns the full checkpoint', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, { shapeFrames: [{ TL: 1 }] });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    const signals = response.records[0].plotshape_signals;
    assert.deepEqual(signals.map(signal => signal.signal_bar_time), [100]);
    assert.ok(signals.every(signal => signal.first_seen_at === 105 && signal.delayed === false));
    assert.deepEqual(signals.map(signal => signal.plot_id), ['plot_8']);
    assert.equal(response.seen_shape_keys_after.length, 2, 'historical + active semantic identities survive the resume checkpoint');
    assert.deepEqual(response.records[0].seen_shape_keys_after, response.seen_shape_keys_after);
    assert.equal(response.records[0].shape_values.studies[0].history_calculation_may_change, true);
  });

  it('emits a delayed backpaint when a resumed checkpoint has not seen an older shape identity', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, { shapeFrames: [{ TL: 1 }] });
    const knownShapeKeys = [
      `${TREND_0822}::plot_8::100::number:1`,
    ];
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
      knownShapeKeys,
      shapeStateInitialized: true,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    const signals = response.records[0].plotshape_signals;
    assert.deepEqual(signals.map(signal => signal.signal_bar_time), [95]);
    assert.ok(signals.every(signal => signal.delayed === true && signal.first_seen_at === 105));
    assert.equal(response.seen_shape_keys_after.length, 2);
  });

  it('stamps a plotshape first materialized after doStep at the next active availability bar', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      shapeFrames: [{ TL: 0 }, { TL: 1 }],
      advanceShapeFrameOnSleep: false,
      advanceShapeFrameOnStep: true,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(runtime.getSteps(), 1);
    assert.equal(response.records[0].plotshape_signals.length, 1);
    assert.ok(response.records[0].plotshape_signals.every(signal => signal.signal_bar_time === 100
      && signal.first_seen_at === 105 && signal.target_open_time === 100));
    assert.equal(response.seen_shape_keys_after.length, 2);
    assert.equal(response.shape_state_initialized_after, true);
    assert.equal(response.records[0].plotshape_scan_phase, 'post_target_final');
    assert.equal(response.records[0].plotshape_scan_observed_active_open_time, 100);
  });

  it('does not step when the active shape row and the cached full PlotList scan disagree', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      shapeFrames: [{ TL: 1 }],
      shapeScanFrames: [{ TL: 0 }],
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'shape_not_settled');
    assert.equal(response.failure.stage, 'post_step_final_shape_scan_consistency');
    assert.equal(runtime.getSteps(), 1);
  });

  it('does not step when the cached scan has an active shape identity absent from the active row', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      shapeFrames: [{ TL: 0 }],
      shapeScanFrames: [{ TL: 1 }],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1, pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2, activeReadyStudyStablePolls: 2,
    }));

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'shape_not_settled');
    assert.ok(response.failure.unexpected_active_scan_identities.length > 0);
    assert.equal(runtime.getSteps(), 1);
  });

  it('does not consume a future logical-index label until it exactly aligns with target T', async () => {
    const first = 1700000000;
    const timeline = [
      [[first - 60, 1, 2, 0.5, 1.5, 10], [first, 2, 3, 1.5, 2.5, 11]],
      [[first - 60, 1, 2, 0.5, 1.5, 10], [first, 2, 3, 1.5, 2.5, 11], [first + 60, 3, 4, 2.5, 3.5, 12]],
      [[first, 2, 3, 1.5, 2.5, 11], [first + 60, 3, 4, 2.5, 3.5, 12], [first + 120, 4, 5, 3.5, 4.5, 13]],
    ];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [[
        { id: 'current-logical', t: '1', y: 1, x: 1 },
        { id: 'future-logical', t: '2', y: 2, x: 2 },
      ]],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 2, pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2, activeReadyStudyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    const futureSourceIdentity = stableReplayLabelIdentity(SWING_0822, { id: 'future-logical' });
    assert.equal(response.records[0].newly_visible_labels.some(label => label.source_label_identity === futureSourceIdentity), false);
    assert.equal(response.records[0].seen_label_keys_after.some(key => key.includes('future-logical')), false);
    const futureEvent = response.records[1].newly_visible_labels.find(label => label.source_label_identity === futureSourceIdentity);
    assert.ok(futureEvent);
    assert.match(futureEvent.label_identity, /^pl4:/);
    assert.equal(response.records[1].seen_label_keys_after.includes(futureEvent.label_identity), true);
    assert.deepEqual(response.records.at(-1).seen_label_keys_after, response.seen_label_keys_after);
  });

  it('keeps an older logical-index label as delayed non-strategy backpaint evidence', async () => {
    const first = 1700000000;
    const timeline = [
      [[first - 60, 1, 2, 0.5, 1.5, 10], [first, 2, 3, 1.5, 2.5, 11]],
      [[first - 60, 1, 2, 0.5, 1.5, 10], [first, 2, 3, 1.5, 2.5, 11], [first + 60, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [[{ id: 'older-logical', t: '1', y: 1, x: 0 }]],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
      pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    const evidence = response.records[0].newly_visible_labels[0];
    assert.equal(evidence.target_aligned, false);
    assert.equal(evidence.delayed, true);
    assert.equal(evidence.strategy_eligible, false);
    assert.equal(evidence.signal_bar_time, first - 60);
    assert.equal(evidence.label_physical_epoch, first - 60);
    assert.equal(evidence.signal_time_mapping_verified, true);
    assert.equal(evidence.signal_time_mapping_source, 'main_series_value_at_verified');
    assert.equal(evidence.signal_bar_logical_index, 0);
    assert.equal(evidence.first_seen_in_chunk, true);
    assert.equal(evidence.availability_open_time, first + 60);
  });

  it('uses a verified physical epoch so a reused Pine id/logical x in a later Replay run is not suppressed', async () => {
    const logicalIndexOffset = 372;
    const logicalTargetIndex = 373;
    const july3 = Math.floor(Date.UTC(2026, 6, 3, 14, 0, 0) / 1000);
    const july18 = Math.floor(Date.UTC(2026, 6, 18, 14, 0, 0) / 1000);
    const captureAt = async (target, knownLabelKeys = []) => {
      const previous = [target - 300, 1, 2, 0.5, 1.5, 10];
      const closed = [target, 2, 3, 1.5, 2.5, 11];
      const next = [target + 300, 3, 4, 2.5, 3.5, 12];
      const runtime = makePageRuntime([[previous, closed], [previous, closed, next]], {
        logicalIndexOffset,
        labelFrames: [[{ id: '12920', t: '1', y: 1, x: logicalTargetIndex }]],
      });
      return runPageExpression(runtime, buildReplayCaptureChunkExpression({
        replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
        pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
        settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
        activeReadyStablePolls: 2, knownLabelKeys,
      }));
    };

    const first = await captureAt(july3);
    assert.equal(first.complete, true, JSON.stringify(first));
    const firstEvent = first.records[0].newly_visible_labels[0];
    assert.equal(firstEvent.label_physical_epoch, july3);
    assert.equal(firstEvent.signal_time_mapping_logical_index, logicalTargetIndex);
    assert.match(firstEvent.label_identity, /^pl4:/);

    const laterRun = await captureAt(july18, first.seen_label_keys_after);
    assert.equal(laterRun.complete, true, JSON.stringify(laterRun));
    const laterEvent = laterRun.records[0].newly_visible_labels[0];
    assert.equal(laterEvent.source_label_identity, firstEvent.source_label_identity);
    assert.equal(laterEvent.label_physical_epoch, july18);
    assert.notEqual(laterEvent.label_identity, firstEvent.label_identity);
    assert.equal(laterRun.seen_label_keys_after.includes(laterEvent.label_identity), true);

    const samePhysicalRun = await captureAt(july18, laterRun.seen_label_keys_after);
    assert.equal(samePhysicalRun.complete, true, JSON.stringify(samePhysicalRun));
    assert.deepEqual(samePhysicalRun.records[0].newly_visible_labels, []);
  });

  it('emits distinct verified physical-epoch identities for multiple same-bar labels and normalizes second/millisecond time x', async () => {
    const target = 1700000000;
    const previous = [target - 300, 1, 2, 0.5, 1.5, 10];
    const closed = [target, 2, 3, 1.5, 2.5, 11];
    const next = [target + 300, 3, 4, 2.5, 3.5, 12];
    const runtime = makePageRuntime([[previous, closed], [previous, closed, next]], {
      logicalIndexOffset: 500,
      labelFrames: [[
        { id: 'logical-a', t: '1', y: 1, x: 501 },
        { id: 'logical-b', t: '2', y: 2, x: 501 },
        { id: 'time-seconds', t: '3', y: 3, x: target },
        { id: 'time-milliseconds', t: '4', y: 4, x: String(target * 1000) },
      ]],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
      pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    const events = response.records[0].newly_visible_labels;
    assert.equal(events.length, 4);
    assert.equal(new Set(events.map(event => event.label_identity)).size, 4);
    assert.ok(events.every(event => event.label_identity_version === 'pine-label/v4/physical-epoch'));
    assert.ok(events.every(event => event.label_physical_epoch === target));
    assert.ok(events.every(event => event.signal_bar_time === event.label_physical_epoch),
      'v4 persists canonical Unix-second signal times even when Pine x is milliseconds');
    assert.ok(events.every(event => event.signal_time_mapping_verified === true));
    assert.ok(events.every(event => event.source_discriminator.startsWith('id:')));
    const timeEvents = events.filter(event => event.id === 'time-seconds' || event.id === 'time-milliseconds');
    assert.equal(timeEvents.length, 2);
    assert.ok(timeEvents.every(event => event.signal_time_mapping_source === 'main_series_epoch_verified'));
  });

  it('does not invent a persistent historical epoch when a logical label is outside the loaded series/gap', async () => {
    const target = 1700000000;
    const gapPrevious = [target - 3 * 24 * 60 * 60, 1, 2, 0.5, 1.5, 10];
    const closed = [target, 2, 3, 1.5, 2.5, 11];
    const next = [target + 300, 3, 4, 2.5, 3.5, 12];
    const runtime = makePageRuntime([[gapPrevious, closed], [gapPrevious, closed, next]], {
      logicalIndexOffset: 372,
      // x=371 is historical relative to target index 373 but has no loaded
      // main-series row. Formula-only interpolation would fabricate T-600.
      labelFrames: [[{ id: 'unmapped-gap', t: '1', y: 1, x: 371 }]],
    });
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1,
      pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 3000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.deepEqual(response.records[0].newly_visible_labels, []);
    assert.deepEqual(response.seen_label_keys_after, []);
  });

  it('accepts a selected current-x Pine label stored as a logical bar index at the Node boundary', async () => {
    const activeTime = 1700000000;
    const record = makeRecord({ activeTime, nextTime: activeTime + 60, activeLogicalIndex: 660 });
    const swing = record.raw_pine_labels.studies.find(study => study.name === SWING_0822);
    swing.labels[0].x = 660;
    const response = await captureChunk({
      bars: 1,
      _deps: depsReturning({
        success: true,
        records: [record],
        steps_invoked: 1,
        seen_shape_keys_after: [],
        shape_state_initialized_after: true,
        seen_label_keys_after: [],
        failure: null,
      }),
    });

    assert.equal(response.complete, true, JSON.stringify(response));
  });

  it('preserves incoming label and shape checkpoint state when no bar reaches confirmation', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
    ];
    const runtime = makePageRuntime(timeline, { studyFrames: [{ trend: { EMA4: '' } }] });
    const knownLabelKeys = ['pl4:checkpoint-study:100:id%3Apersisted-label'];
    const response = await runPageExpression(runtime, buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay', bars: 1, pollAttempts: 2, postStepClosedBarStablePolls: 2, pollIntervalMs: 75,
      settleMs: 0, activeReadyTimeoutMs: 1000, activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2, activeReadyStudyStablePolls: 2,
      knownLabelKeys, knownShapeKeys: [], shapeStateInitialized: true,
    }));

    assert.equal(response.records.length, 0);
    assert.equal(response.complete, false);
    assert.deepEqual(response.seen_label_keys_after, knownLabelKeys);
    assert.deepEqual(response.seen_shape_keys_after, []);
    assert.equal(response.shape_state_initialized_after, true);
  });

  it('does not silently seed historical shapes when an initialized empty checkpoint resumes', async () => {
    const timeline = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11], [105, 3, 4, 2.5, 3.5, 12]],
    ];
    const runtime = makePageRuntime(timeline, { shapeFrames: [{ TL: 1 }] });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
      knownShapeKeys: [],
      shapeStateInitialized: true,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.deepEqual(
      response.records[0].plotshape_signals
        .filter(signal => signal.delayed)
        .map(signal => signal.signal_bar_time),
      [95]
    );
    assert.equal(response.records[0].shape_state_initialized_after, true);
    assert.equal(response.shape_state_initialized_after, true);
  });

  it('does not step when OHLCV drifts during the final combined-snapshot sandwich', async () => {
    const preStepFrames = [
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]],
      [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.6, 11]],
    ];
    const runtime = makePageRuntime([preStepFrames[0]], {
      preStepFrames,
      advancePreStepFrameOnSleep: false,
      advancePreStepFrameOnStudyReadNumber: 2,
    });
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 250,
      activeReadyStablePolls: 2,
      activeReadyStudyStablePolls: 2,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'active_bar_not_settled');
    assert.equal(response.failure.stage, 'pre_step_final_sandwich');
    assert.equal(runtime.getSteps(), 0);
  });

  it('includes the full pre-step active OHLCV in a post-step alignment failure for audit', async () => {
    const onlyPreStepBars = [[95, 1, 2, 0.5, 1.5, 10], [100, 2, 3, 1.5, 2.5, 11]];
    const runtime = makePageRuntime([onlyPreStepBars]);
    const expression = buildReplayCaptureChunkExpression({
      replayApiPath: 'window.TradingViewApi.fakeReplay',
      bars: 1,
      pollAttempts: 2,
      postStepClosedBarStablePolls: 2,
      pollIntervalMs: 75,
      settleMs: 0,
      activeReadyTimeoutMs: 3000,
      activeReadyPollIntervalMs: 100,
      activeReadyStablePolls: 4,
    });
    const response = await runPageExpression(runtime, expression);

    assert.equal(response.complete, false);
    assert.equal(response.failure.code, 'post_step_alignment_timeout');
    assert.deepEqual(response.failure.pre_step_active_bar, {
      time: 100, open: 2, high: 3, low: 1.5, close: 2.5, volume: 11,
    });
    assert.equal(runtime.getSteps(), 1);
  });

  it('keeps only current-x labels, otherwise the latest x at or before the observation bar', () => {
    const activeTime = 1700000000;
    const current = selectCurrentOrMaxXReplayLabels(TREND_0822, [
      { id: 'old', text: '旧标签', price: 1, x: 1699999995 },
      { id: 'current-a', text: 'TL', price: 2, x: activeTime },
      { id: 'current-b', text: 'PB', price: 3, x: '1700000000000' }, // milliseconds form of the same epoch
    ], activeTime);
    assert.equal(current.selection, 'current_x');
    assert.equal(current.labels.length, 2);
    assert.ok(current.labels.every(label => label.observed_at_open_time === activeTime));
    assert.ok(current.labels.every(label => label.observed_at === activeTime));
    assert.ok(current.labels.every(label => label.label_identity));
    assert.equal(current.labels[0].label_identity, stableReplayLabelIdentity(TREND_0822, { id: 'current-a', text: 'TL', price: 2, x: activeTime }));

    const latest = selectCurrentOrMaxXReplayLabels(SWING_0822, [
      { id: 'older', text: '20', price: 1, x: 1699999980 },
      { id: 'latest-a', text: '30', price: 2, x: 1699999995 },
      { id: 'latest-b', text: '31', price: 3, x: 1699999995 },
      { id: 'future', text: '40', price: 4, x: 1700000005 },
    ], activeTime);
    assert.equal(latest.selection, 'max_x');
    assert.deepEqual(latest.labels.map(label => label.id), ['latest-a', 'latest-b']);
  });

  it('preserves prior confirmed rows when a later post-step confirmation fails', async () => {
    const first = makeRecord({ activeTime: 100, nextTime: 105 });
    const result = await captureChunk({
      bars: 2,
      _deps: depsReturning({
        success: true,
        records: [first],
        steps_invoked: 2,
        failure: {
          code: 'post_step_alignment_timeout',
          stage: 'post_step_confirmation',
          sequence: 2,
          observed_active_open_time: 105,
          message: 'The pre-step active bar did not become postBars[-2] before the polling deadline.',
        },
      }),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.records.length, 1);
    assert.equal(result.completed_steps, 1);
    assert.equal(result.failure.code, 'post_step_alignment_timeout');
    assert.equal(result.steps_invoked, 2, 'the failed candidate step is explicitly accounted for');
  });
});

describe('data_capture_0822_closed', () => {
  it('registers the read-only live capture MCP tool', () => {
    const names = [];
    registerDataTools({ tool: name => names.push(name) });
    assert.ok(names.includes('data_capture_0822_closed'));
  });

  it('validates live count and checkpoint inputs before opening a browser operation', async () => {
    assert.equal(validateLiveCaptureCount(1), 1);
    assert.equal(validateLiveCaptureCount(5), 5);
    assert.throws(() => validateLiveCaptureCount(0), /1 to 5/);
    assert.throws(() => validateLiveCaptureCount(6), /1 to 5/);

    let touched = false;
    await assert.rejects(
      capture0822Closed({ count: 0, _deps: { evaluateAsync: async () => { touched = true; } } }),
      /1 to 5/
    );
    assert.equal(touched, false);

    await assert.rejects(
      capture0822Closed({
        count: 1,
        known_label_keys: ['not-a-pl4-key'],
        label_state_initialized: true,
        _deps: { evaluateAsync: async () => { touched = true; } },
      }),
      /valid checkpoint strings/
    );

    await assert.rejects(
      capture0822Closed({
        count: 1,
        settle_ms: 10001,
        _deps: { evaluateAsync: async () => { touched = true; } },
      }),
      /settle_ms must be an integer from 0 to 10000/
    );

    const legacyOverflow = Array.from(
      { length: 10001 },
      (_, index) => `pl4:trend:${index}:source`
    );
    await assert.rejects(
      capture0822Closed({
        count: 1,
        known_label_keys: legacyOverflow,
        label_state_initialized: true,
        _deps: { evaluateAsync: async () => { throw new Error('browser operation reached'); } },
      }),
      /browser operation reached/
    );

    let liveSchema;
    registerDataTools({
      tool: (name, _description, schema) => {
        if (name === 'data_capture_0822_closed') liveSchema = schema;
      },
    });
    assert.equal(liveSchema.known_label_keys.safeParse(legacyOverflow).success, true);

    const beyondSafetyBound = Array.from(
      { length: 50001 },
      (_, index) => `pl4:trend:${index}:source`
    );
    await assert.rejects(
      capture0822Closed({
        count: 1,
        known_label_keys: beyondSafetyBound,
        label_state_initialized: true,
        _deps: { evaluateAsync: async () => { touched = true; } },
      }),
      /at most 50000/
    );
    assert.equal(liveSchema.known_label_keys.safeParse(beyondSafetyBound).success, false);
  });

  it('captures a stable closed tail without touching Replay and marks only newest T causal', async () => {
    const timeline = [[
      [95, 1, 2, 0.5, 1.5, 10],
      [100, 2, 3, 1.5, 2.5, 11],
      [105, 3, 4, 2.5, 3.5, 12],
    ]];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [[{ id: 'target-label', t: '1', y: 1, x: 100 }]],
      advanceLabelFrameOnSleep: false,
    });
    const expression = buildLiveCapture0822ClosedExpression({
      count: 2,
      pollAttempts: 2,
      pollIntervalMs: 25,
      stablePolls: 2,
      knownLabelKeys: [],
      knownShapeKeys: [],
      shapeStateInitialized: true,
      labelStateInitialized: true,
    });
    assert.doesNotMatch(expression, /\.doStep\(/);
    assert.doesNotMatch(expression, /getReplayApi/);

    const response = await runPageExpression(runtime, expression);
    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(response.replay_advanced, false);
    assert.equal(runtime.getSteps(), 0);
    assert.equal(response.symbol, 'BYBIT:BTCUSDT.P');
    assert.equal(response.timeframe, '5');
    assert.ok(Number.isFinite(response.observed_at_epoch_ms));
    assert.equal(response.records.length, 2);

    const older = response.records[0];
    const latest = response.records[1];
    assert.equal(older.target_open_time, 95);
    assert.equal(older.event_eligible, false);
    assert.equal(older.strategy_event_eligible, false);
    assert.deepEqual(older.new_label_events, []);
    assert.deepEqual(older.new_trend_shape_events, []);
    assert.equal(older.event_causality, 'tail_feature_only_noncausal');
    assert.equal(Object.hasOwn(older, 'seen_label_keys_after'), false);
    assert.equal(Object.hasOwn(older, 'seen_shape_keys_after'), false);
    assert.equal(Object.hasOwn(older, 'label_state_initialized_after'), false);
    assert.equal(Object.hasOwn(older, 'shape_state_initialized_after'), false);

    assert.equal(latest.target_open_time, 100);
    assert.equal(latest.availability_open_time, 105);
    assert.equal(latest.active_bar.time, 105);
    assert.equal(latest.target_is_latest_closed, true);
    assert.equal(latest.event_eligible, true);
    assert.equal(latest.strategy_event_eligible, true);
    assert.equal(latest.capture_contract, '0822-live.v1/closed_tail');
    assert.equal(latest.capture_transport, 'data_capture_0822_closed');
    assert.equal(older.observed_at_epoch_ms, response.observed_at_epoch_ms);
    assert.equal(latest.observed_at_epoch_ms, response.observed_at_epoch_ms);
    assert.deepEqual(latest.bar, { open_time: 100, open: 2, high: 3, low: 1.5, close: 2.5, volume: 11 });
    assert.equal(latest.raw_study_values.source, 'plot_list_closed_row');
    assert.equal(latest.shape_values.source, 'plot_list_closed_row');
    assert.equal(latest.normalized.ema21, '100');
    assert.equal(latest.normalized.swing_value, 1);
    assert.equal(latest.new_label_events.length, 1);
    assert.equal(latest.new_label_events[0].label_physical_epoch, 100);
    assert.equal(latest.new_label_events[0].strategy_eligible, true);
    assert.equal(latest.labels_visible_now_are_first_seen_events, false);
    assert.equal(response.seen_label_keys_after.length, 1);
    assert.match(response.seen_label_keys_after[0], /^pl4:/);

    const coreRuntime = makePageRuntime(timeline, {
      labelFrames: [[{ id: 'target-label', t: '1', y: 1, x: 100 }]],
      advanceLabelFrameOnSleep: false,
    });
    const throughCore = await capture0822Closed({
      count: 2,
      poll_attempts: 2,
      poll_interval_ms: 25,
      stable_polls: 2,
      known_label_keys: [],
      known_shape_keys: [],
      shape_state_initialized: true,
      label_state_initialized: true,
      _deps: { evaluateAsync: expression => runPageExpression(coreRuntime, expression) },
    });
    assert.equal(throughCore.complete, true, JSON.stringify(throughCore));
    assert.equal(throughCore.records[1].target_bar.open_time, 100);
    assert.equal(throughCore.records[1].symbol, 'BYBIT:BTCUSDT.P');
    assert.ok(Number.isFinite(throughCore.observed_at_epoch_ms));
    assert.ok(throughCore.records.every(record => record.observed_at_epoch_ms === throughCore.observed_at_epoch_ms));
  });

  it('keeps the live strategy hot path bounded to tail rows and target-aligned labels', async () => {
    const timeline = [[
      [95, 1, 2, 0.5, 1.5, 10],
      [100, 2, 3, 1.5, 2.5, 11],
      [105, 3, 4, 2.5, 3.5, 12],
    ]];
    const historicalLabels = Array.from({ length: 1_000 }, (_, index) => ({
      id: `historical-${index}`,
      t: '1',
      y: 1,
      x: 95,
    }));
    const runtime = makePageRuntime(timeline, {
      labelFrames: [[...historicalLabels, { id: 'target-label', t: '1', y: 1, x: 100 }]],
      advanceLabelFrameOnSleep: false,
      shapeFrames: [{ TL: 1 }],
      trendEachThrows: true,
    });

    const response = await runPageExpression(runtime, buildLiveCapture0822ClosedExpression({
      count: 2,
      pollAttempts: 2,
      pollIntervalMs: 25,
      stablePolls: 2,
      knownLabelKeys: [],
      knownShapeKeys: [],
      shapeStateInitialized: true,
      labelStateInitialized: true,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(response.checkpoint_scope, 'live_strategy_tail_v1');
    assert.equal(response.records.at(-1).checkpoint_scope, 'live_strategy_tail_v1');
    assert.equal(runtime.getTrendEachCalls(), 0);
    assert.ok(runtime.getMainSeriesSearchCount() < 20, runtime.getMainSeriesSearchCount());
    assert.equal(response.seen_label_keys_after.length, 1);
    const shapeEvents = response.records.at(-1).new_trend_shape_events;
    assert.deepEqual(shapeEvents.map(event => event.signal_bar_time), [95, 100]);
    assert.deepEqual(
      shapeEvents.filter(event => event.strategy_eligible).map(event => event.code),
      ['TL']
    );
  });

  it('seeds already-visible labels without falsely reporting historical first-seen events', async () => {
    const timeline = [[
      [95, 1, 2, 0.5, 1.5, 10],
      [100, 2, 3, 1.5, 2.5, 11],
      [105, 3, 4, 2.5, 3.5, 12],
    ]];
    const runtime = makePageRuntime(timeline, {
      labelFrames: [[{ id: 'old-visible-label', t: '1', y: 1, x: 100 }]],
      advanceLabelFrameOnSleep: false,
    });
    const response = await runPageExpression(runtime, buildLiveCapture0822ClosedExpression({
      count: 1,
      pollAttempts: 2,
      pollIntervalMs: 25,
      stablePolls: 2,
      knownLabelKeys: [],
      knownShapeKeys: [],
      shapeStateInitialized: false,
      labelStateInitialized: false,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    const latest = response.records[0];
    assert.deepEqual(latest.new_label_events, []);
    assert.equal(latest.seeded_label_keys.length, 1);
    assert.equal(latest.label_state_initialized_after, true);
    assert.equal(latest.labels_visible_now_are_first_seen_events, false);
  });

  it('retries a transient PlotList/label switch state and then captures a stable tail', async () => {
    const timeline = [[
      [95, 1, 2, 0.5, 1.5, 10],
      [100, 2, 3, 1.5, 2.5, 11],
      [105, 3, 4, 2.5, 3.5, 12],
    ]];
    const runtime = makePageRuntime(timeline, {
      swingLabelCollectionFrames: [false, true, true],
      labelFrames: [[{ id: 'target-label', t: '1', y: 1, x: 100 }]],
      advanceLabelFrameOnSleep: false,
    });
    const response = await runPageExpression(runtime, buildLiveCapture0822ClosedExpression({
      count: 1,
      pollAttempts: 3,
      pollIntervalMs: 25,
      stablePolls: 2,
      settleMs: 0,
      knownLabelKeys: [],
      knownShapeKeys: [],
      shapeStateInitialized: false,
      labelStateInitialized: false,
    }));

    assert.equal(response.complete, true, JSON.stringify(response));
    assert.equal(response.records.length, 1);
    assert.equal(response.records[0].target_open_time, 100);
    assert.equal(runtime.getSteps(), 0);
  });

  it('keeps a previously seen Pine source relocation as non-strategy backpaint evidence', async () => {
    const firstRuntime = makePageRuntime([[
      [95, 1, 2, 0.5, 1.5, 10],
      [100, 2, 3, 1.5, 2.5, 11],
      [105, 3, 4, 2.5, 3.5, 12],
    ]], {
      labelFrames: [[{ id: 'reused-label', t: '1', y: 1, x: 100 }]],
      advanceLabelFrameOnSleep: false,
    });
    const seeded = await runPageExpression(firstRuntime, buildLiveCapture0822ClosedExpression({
      count: 1,
      pollAttempts: 2,
      pollIntervalMs: 25,
      stablePolls: 2,
      knownLabelKeys: [],
      knownShapeKeys: [],
      shapeStateInitialized: false,
      labelStateInitialized: false,
    }));
    assert.equal(seeded.complete, true, JSON.stringify(seeded));
    assert.equal(seeded.seen_label_keys_after.length, 1);

    const movedRuntime = makePageRuntime([[
      [100, 2, 3, 1.5, 2.5, 11],
      [105, 3, 4, 2.5, 3.5, 12],
      [110, 4, 5, 3.5, 4.5, 13],
    ]], {
      labelFrames: [[{ id: 'reused-label', t: '1', y: 1, x: 105 }]],
      advanceLabelFrameOnSleep: false,
    });
    const moved = await runPageExpression(movedRuntime, buildLiveCapture0822ClosedExpression({
      count: 1,
      pollAttempts: 2,
      pollIntervalMs: 25,
      stablePolls: 2,
      knownLabelKeys: seeded.seen_label_keys_after,
      knownShapeKeys: seeded.seen_shape_keys_after,
      shapeStateInitialized: true,
      labelStateInitialized: true,
    }));

    assert.equal(moved.complete, true, JSON.stringify(moved));
    const event = moved.records[0].new_label_events[0];
    assert.equal(event.target_aligned, true);
    assert.equal(event.source_previously_seen, true);
    assert.equal(event.first_seen_semantics, 'existing_live_label_source_relocated');
    assert.equal(event.delayed, true);
    assert.equal(event.event_eligible, false);
    assert.equal(event.strategy_eligible, false);
  });

  it('returns a structured incomplete result when closed PlotList evidence never stabilizes', async () => {
    const timeline = [[
      [95, 1, 2, 0.5, 1.5, 10],
      [100, 2, 3, 1.5, 2.5, 11],
      [105, 3, 4, 2.5, 3.5, 12],
    ]];
    const runtime = makePageRuntime(timeline, {
      studyFrames: [{ trend: { EMA1: '100' } }, { trend: { EMA1: '101' } }],
      cycleStudyFrames: true,
      labelFrames: [[{ id: 'target-label', t: '1', y: 1, x: 100 }]],
      advanceLabelFrameOnSleep: false,
    });
    const response = await runPageExpression(runtime, buildLiveCapture0822ClosedExpression({
      count: 1,
      pollAttempts: 3,
      pollIntervalMs: 25,
      stablePolls: 2,
      knownLabelKeys: [],
      knownShapeKeys: [],
      shapeStateInitialized: false,
      labelStateInitialized: false,
    }));

    assert.equal(response.complete, false);
    assert.equal(response.partial, false);
    assert.deepEqual(response.records, []);
    assert.equal(response.failure.code, 'live_capture_not_settled');
    assert.equal(runtime.getSteps(), 0);
  });
});
