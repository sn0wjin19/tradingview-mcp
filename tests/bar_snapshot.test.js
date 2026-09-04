/**
 * data_get_bar_snapshot unit tests. Page expressions run against an in-process
 * fake TradingViewApi; no live CDP connection is required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBarSnapshotExpression,
  getBarSnapshot,
  parseBarSnapshotOptions,
  parsePaneScanOptions,
  scanPanes,
  validatePaneScanResult,
} from '../src/core/bar_snapshot.js';
import { registerDataTools } from '../src/tools/data.js';
import {
  SWING_0822,
  SWING_PALETTE_COLORS,
  TREND_0822,
  TREND_COLORS,
  TREND_PACKED,
  swingPaletteMeta,
  swingPaletteRow,
  trendFillMeta,
  trendFillRow,
} from './fixtures/plot_list_0822.js';

const BARS = [
  [90, 1, 2, 0.5, 1.5, 10],
  [100, 2, 3, 1.5, 2.5, 11],
  [110, 3, 4, 2.5, 3.5, 12],
];

function barsApi(rows) {
  return {
    firstIndex: () => 0,
    lastIndex: () => rows.length - 1,
    valueAt: index => rows[index] || null,
    searchByTime: time => {
      const index = rows.findIndex(row => row[0] === time);
      if (index < 0) return null;
      return { index, value: rows[index] };
    },
  };
}

function studySource({ entityId, name, meta, rowsByTime, visible = true }) {
  return {
    id: () => entityId,
    isVisible: () => visible,
    metaInfo: () => ({ description: name, ...meta }),
    get _data() {
      return {
        searchByTime: time => {
          const row = rowsByTime[time];
          if (!row) return null;
          return { index: 0, value: row };
        },
      };
    },
  };
}

function makeRuntime({
  symbol = 'BYBIT:BTCUSDT.P',
  timeframe = '15',
  bars = BARS,
  studies,
  symbolSequence,
} = {}) {
  let symbolIndex = 0;
  const currentSymbol = () => {
    if (Array.isArray(symbolSequence) && symbolSequence.length > 0) {
      return symbolSequence[Math.min(symbolIndex, symbolSequence.length - 1)];
    }
    return symbol;
  };
  const studySources = studies || [
    studySource({
      entityId: 'trend-1',
      name: TREND_0822,
      meta: trendFillMeta,
      rowsByTime: {
        90: trendFillRow(90),
        100: trendFillRow(100),
        110: trendFillRow(110, { z1: { upper: 111, lower: 91, color: TREND_PACKED.RED } }),
      },
    }),
    studySource({
      entityId: 'swing-1',
      name: SWING_0822,
      meta: swingPaletteMeta,
      rowsByTime: {
        90: swingPaletteRow(90, { paletteValue: 0 }),
        100: swingPaletteRow(100, { paletteValue: 1, empty: '∅' }),
        110: swingPaletteRow(110, { paletteValue: 4 }),
      },
    }),
  ];
  return {
    onSleep() {
      if (Array.isArray(symbolSequence) && symbolIndex < symbolSequence.length - 1) {
        symbolIndex += 1;
      }
    },
    pageWindow: {
      TradingViewApi: {
        _replayApi: { isReplayStarted: () => false },
        _activeChartWidgetWV: {
          value: () => ({
            symbol: () => currentSymbol(),
            resolution: () => timeframe,
            getAllStudies: () => studySources.map(source => ({
              id: source.id(),
              name: source.metaInfo().description,
            })),
            _chartWidget: {
              model: () => ({
                mainSeries: () => ({
                  symbol: () => currentSymbol(),
                  interval: () => timeframe,
                  bars: () => barsApi(bars),
                }),
                model: () => ({ dataSources: () => studySources }),
              }),
            },
          }),
        },
      },
    },
  };
}

async function runPageExpression(runtime, expression) {
  const run = new Function('window', 'setTimeout', `return (${expression.trim()});`);
  return run(runtime.pageWindow, (callback, delay = 0) => {
    runtime.onSleep(delay);
    callback();
    return 0;
  });
}

function depsFor(runtime) {
  return {
    evaluateAsync: expression => runPageExpression(runtime, expression),
  };
}

function makePaneRuntime(paneOptions, { layoutSequence } = {}) {
  const runtimes = paneOptions.map(options => makeRuntime(options));
  const paneCharts = runtimes.map(runtime => (
    runtime.pageWindow.TradingViewApi._activeChartWidgetWV.value()._chartWidget
  ));
  let layoutIndex = 0;
  const defaultLayout = runtimes.map((runtime, index) => index);
  const sequence = layoutSequence || [defaultLayout];
  const runtime = {
    onSleep(delay) {
      for (const paneRuntime of runtimes) paneRuntime.onSleep(delay);
      if (layoutIndex < sequence.length - 1) layoutIndex += 1;
    },
    pageWindow: {
      TradingViewApi: {
        _replayApi: { isReplayStarted: () => false },
        _chartWidgetCollection: {
          getAll: () => sequence[Math.min(layoutIndex, sequence.length - 1)]
            .map(index => paneCharts[index]),
        },
      },
    },
  };
  return runtime;
}

describe('data_get_bar_snapshot options', () => {
  it('rejects time+bars_ago and closed_only bars_ago=0 before any page evaluation', async () => {
    assert.throws(() => parseBarSnapshotOptions({ time: 100, bars_ago: 1 }), /mutually exclusive/);
    assert.throws(() => parseBarSnapshotOptions({ bars_ago: 0, closed_only: true }), /active bar/);
    let touched = false;
    await assert.rejects(
      getBarSnapshot({ time: 100, bars_ago: 1, _deps: { evaluateAsync: async () => { touched = true; } } }),
      /mutually exclusive/,
    );
    assert.equal(touched, false);
  });
});

describe('data_get_bar_snapshot page capture', () => {
  it('fails closed while Replay is active', async () => {
    const runtime = makeRuntime();
    runtime.pageWindow.TradingViewApi._replayApi.isReplayStarted = () => true;
    const result = await getBarSnapshot({
      poll_interval_ms: 25,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'replay_active');
    assert.deepEqual(result.records, []);
  });

  it('defaults to the latest closed bar and excludes the active bar', async () => {
    const result = await getBarSnapshot({
      study_filters: ['趋势过滤器', '波段过滤器'],
      stable_polls: 2,
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.capture_mode, 'plot_list');
    assert.equal(result.identity_verified, true);
    assert.equal(result.symbol, 'BYBIT:BTCUSDT.P');
    assert.equal(result.timeframe, '15');
    assert.equal(result.active_bar_time, 110);
    assert.equal(result.stable_polls, 2);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].bar_time, 100);
    assert.equal(result.records[0].closed, true);
    assert.deepEqual(result.records[0].ohlcv, { open: 2, high: 3, low: 1.5, close: 2.5, volume: 11 });
    const names = result.records[0].studies.map(study => study.name);
    assert.deepEqual(names, [TREND_0822, SWING_0822]);
  });

  it('locates a closed bar by unix time', async () => {
    const result = await getBarSnapshot({
      time: 90,
      count: 1,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.records[0].bar_time, 90);
    assert.equal(result.records[0].studies[0].plots[0].value, 100);
  });

  it('locates bars_ago from the last loaded bar', async () => {
    const result = await getBarSnapshot({
      bars_ago: 2,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.records[0].bar_time, 90);
  });

  it('returns the requested closed bars newest last and never the active bar', async () => {
    const result = await getBarSnapshot({
      count: 2,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.records.map(record => record.bar_time), [90, 100]);
    assert.ok(result.records.every(record => record.closed === true));
    assert.ok(result.records.every(record => record.bar_time !== result.active_bar_time));
  });

  it('fails closed instead of silently returning fewer bars than count', async () => {
    const result = await getBarSnapshot({
      count: 3,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'insufficient_bars');
    assert.equal(result.failure.requested, 3);
    assert.equal(result.failure.available, 2);
    assert.deepEqual(result.records, []);
  });

  it('decodes Trend ABGR fills and Swing palette colors on the hydrated records', async () => {
    const result = await getBarSnapshot({
      time: 100,
      study_filters: ['趋势过滤器', '波段过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    const trend = result.records[0].studies.find(study => study.name === TREND_0822);
    const swing = result.records[0].studies.find(study => study.name === SWING_0822);
    assert.equal(trend.fills[0].title, 'Z1');
    assert.equal(trend.fills[0].upper, 110);
    assert.equal(trend.fills[0].lower, 90);
    assert.equal(trend.fills[0].color.hex, TREND_COLORS.GREEN.hex);
    assert.equal(trend.history_calculation_may_change, true);
    assert.equal(swing.plots[2].color.hex, SWING_PALETTE_COLORS[1]);
    assert.equal(swing.plots[3].value, null);
  });

  it('fails closed when the requested time is the active bar', async () => {
    const result = await getBarSnapshot({
      time: 110,
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, false);
    assert.equal(result.identity_verified, false);
    assert.equal(result.failure.code, 'active_bar_excluded');
    assert.deepEqual(result.records, []);
  });

  it('fails closed when a filtered study is missing', async () => {
    const result = await getBarSnapshot({
      study_filters: ['不存在的指标'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime()),
    });
    assert.equal(result.success, false);
    assert.equal(result.failure.code, 'no_matching_study');
  });

  it('fails closed when a matched study is missing entity_id', async () => {
    const result = await getBarSnapshot({
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime({
        studies: [studySource({
          entityId: null,
          name: TREND_0822,
          meta: trendFillMeta,
          rowsByTime: { 90: trendFillRow(90), 100: trendFillRow(100), 110: trendFillRow(110) },
        })],
      })),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'study_identity_unavailable');
    assert.equal(result.identity_verified, false);
    assert.deepEqual(result.records, []);
  });

  it('fails closed when matched studies share entity_id', async () => {
    const result = await getBarSnapshot({
      study_filters: ['趋势过滤器', '波段过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime({
        studies: [
          studySource({
            entityId: 'shared-study',
            name: TREND_0822,
            meta: trendFillMeta,
            rowsByTime: { 90: trendFillRow(90), 100: trendFillRow(100), 110: trendFillRow(110) },
          }),
          studySource({
            entityId: 'shared-study',
            name: SWING_0822,
            meta: swingPaletteMeta,
            rowsByTime: {
              90: swingPaletteRow(90),
              100: swingPaletteRow(100),
              110: swingPaletteRow(110),
            },
          }),
        ],
      })),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'study_identity_duplicate');
    assert.equal(result.failure.entity_id, 'shared-study');
    assert.deepEqual(result.records, []);
  });

  it('treats study metadata/manifest changes as an unstable snapshot even when row values stay put', async () => {
    const meta = structuredClone(trendFillMeta);
    const runtime = makeRuntime({
      studies: [studySource({
        entityId: 'trend-1',
        name: TREND_0822,
        meta,
        rowsByTime: { 90: trendFillRow(90), 100: trendFillRow(100), 110: trendFillRow(110) },
      })],
    });
    const originalSleep = runtime.onSleep;
    let flips = 0;
    runtime.onSleep = (delay) => {
      flips += 1;
      meta.filledAreas[0].title = `Z1-${flips}`;
      originalSleep(delay);
    };
    const result = await getBarSnapshot({
      time: 100,
      study_filters: ['趋势过滤器'],
      stable_polls: 2,
      poll_interval_ms: 25,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'snapshot_unstable');
  });

  it('fails closed on identity mismatch before the snapshot is stable', async () => {
    const result = await getBarSnapshot({
      study_filters: ['趋势过滤器'],
      stable_polls: 2,
      poll_interval_ms: 25,
      _deps: depsFor(makeRuntime({ symbolSequence: ['BYBIT:BTCUSDT.P', 'BYBIT:ETHUSDT.P'] })),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'identity_mismatch');
    assert.equal(result.identity_verified, false);
  });

  it('fails closed when PlotList values keep changing', async () => {
    let flips = 0;
    const rowsByTime = {
      90: trendFillRow(90),
      100: trendFillRow(100),
      110: trendFillRow(110),
    };
    const runtime = makeRuntime({
      studies: [studySource({
        entityId: 'trend-1',
        name: TREND_0822,
        meta: trendFillMeta,
        rowsByTime,
      })],
    });
    const originalSleep = runtime.onSleep;
    runtime.onSleep = (delay) => {
      flips += 1;
      rowsByTime[100] = trendFillRow(100, {
        ema21: flips,
        z1: { upper: 110, lower: 90, color: TREND_PACKED.GREEN },
      });
      originalSleep(delay);
    };
    const result = await getBarSnapshot({
      time: 100,
      study_filters: ['趋势过滤器'],
      stable_polls: 2,
      poll_interval_ms: 25,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'snapshot_unstable');
  });

  it('fails closed when a filtered study has no PlotList row at the bar', async () => {
    const runtime = makeRuntime({
      studies: [
        studySource({
          entityId: 'trend-1',
          name: TREND_0822,
          meta: trendFillMeta,
          rowsByTime: { 90: trendFillRow(90), 110: trendFillRow(110) },
        }),
      ],
    });
    const result = await getBarSnapshot({
      time: 100,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false);
    assert.equal(result.failure.code, 'study_row_unavailable');
  });
});

describe('data_get_bar_snapshot tool registration', () => {
  it('registers data_get_bar_snapshot without changing the 0822 live capture contract', () => {
    const tools = [];
    registerDataTools({
      tool(name, description, schema) {
        tools.push({ name, description, schema });
      },
    });
    const snapshot = tools.find(tool => tool.name === 'data_get_bar_snapshot');
    const live = tools.find(tool => tool.name === 'data_capture_0822_closed');
    assert.ok(snapshot);
    assert.ok(live);
    assert.deepEqual(Object.keys(live.schema).sort(), [
      'count', 'known_label_keys', 'known_shape_keys', 'label_state_initialized',
      'poll_attempts', 'poll_interval_ms', 'settle_ms', 'shape_state_initialized', 'stable_polls',
    ].sort());
    assert.ok(snapshot.schema.time);
    assert.ok(snapshot.schema.bars_ago);
    assert.ok(snapshot.schema.study_filters);
    assert.equal(tools.some(tool => tool.name === 'data_scan_panes'), true);
    assert.equal(tools.some(tool => tool.name === 'chart_hover_bar'), false);
  });
});

describe('data_scan_panes', () => {
  it('captures three panes in one page evaluation after whole-layout stability', async () => {
    const runtime = makePaneRuntime([
      { symbol: 'BYBIT:BTCUSDT.P', timeframe: '15' },
      { symbol: 'BYBIT:BTCUSDT.P', timeframe: '60' },
      { symbol: 'BYBIT:BTCUSDT.P', timeframe: '240' },
    ]);
    let evaluations = 0;
    const result = await scanPanes({
      count: 2,
      study_filters: ['趋势过滤器', '波段过滤器'],
      stable_polls: 2,
      poll_interval_ms: 25,
      _deps: {
        evaluateAsync: expression => {
          evaluations += 1;
          assert.match(expression, /_chartWidgetCollection/);
          assert.match(expression, /\.getAll\(\)/);
          return runPageExpression(runtime, expression);
        },
      },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(evaluations, 1);
    assert.equal(result.pane_count, 3);
    assert.equal(result.stable_polls, 2);
    assert.deepEqual(result.panes.map(pane => [pane.pane_index, pane.symbol, pane.timeframe]), [
      [0, 'BYBIT:BTCUSDT.P', '15'],
      [1, 'BYBIT:BTCUSDT.P', '60'],
      [2, 'BYBIT:BTCUSDT.P', '240'],
    ]);
    assert.ok(result.panes.every(pane => pane.identity_verified === true));
    assert.ok(result.panes.every(pane => pane.active_bar_time === 110));
    assert.ok(result.panes.every(pane => pane.records.length === 2));
    assert.ok(result.panes.every(pane => pane.records[0].studies[0].manifest));
  });

  it('returns each exact cursor proof and the following closed prefix atomically', async () => {
    const result = await scanPanes({
      after_time_by_pane: [90, 90, 90],
      count: 20,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([{}, {}, {}])),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.panes.map(pane => pane.records.map(record => record.bar_time)), [
      [90, 100], [90, 100], [90, 100],
    ]);
    assert.ok(result.panes.every(pane => pane.cursor_time === 90));
    assert.ok(result.panes.every(pane => pane.has_more === false));
  });

  it('marks a bounded forward prefix when newer closed bars remain', async () => {
    const bars = [...BARS, [120, 4, 5, 3.5, 4.5, 13]];
    const result = await scanPanes({
      after_time_by_pane: [90, 90, 90],
      count: 1,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([{ bars }, { bars }, { bars }])),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(result.panes.every(pane => pane.has_more === true));
    assert.deepEqual(result.panes[0].records.map(record => record.bar_time), [90, 100]);

    const malformed = structuredClone(result);
    malformed.panes[0].records.pop();
    const validated = validatePaneScanResult(malformed, parsePaneScanOptions({
      after_time_by_pane: [90, 90, 90],
      count: 1,
      study_filters: ['趋势过滤器'],
    }));
    assert.equal(validated.success, false);
    assert.equal(validated.failure.code, 'invalid_response');
  });

  it('returns only the proof when a pane cursor is already caught up', async () => {
    const result = await scanPanes({
      after_time_by_pane: [100, 100, 100],
      count: 20,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([{}, {}, {}])),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(result.panes.every(pane => pane.has_more === false));
    assert.deepEqual(result.panes[0].records.map(record => record.bar_time), [100]);
  });

  it('bootstraps only panes whose forward cursor is null', async () => {
    const result = await scanPanes({
      after_time_by_pane: [90, null, 100],
      count: 1,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([{}, {}, {}])),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.panes.map(pane => pane.records.map(item => item.bar_time)), [
      [90, 100], [100], [100],
    ]);
    assert.equal(result.panes[0].cursor_time, 90);
    assert.equal('cursor_time' in result.panes[1], false);
    assert.equal(result.panes[2].cursor_time, 100);
  });

  it('fails the whole scan when any pane cursor is not exactly loaded', async () => {
    const result = await scanPanes({
      after_time_by_pane: [90, 95, 90],
      count: 1,
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([{}, {}, {}])),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'cursor_not_loaded');
    assert.equal(result.failure.pane_index, 1);
  });

  it('fails the whole scan when cursor count differs from pane count', async () => {
    const result = await scanPanes({
      after_time_by_pane: [90],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([{}, {}, {}])),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'invalid_cursor_count');
  });

  it('normalizes millisecond pane cursors and requires closed-only mode', async () => {
    const parsed = parsePaneScanOptions({
      after_time_by_pane: [1_788_480_000_000],
    });
    assert.deepEqual(parsed.after_time_by_pane, [1_788_480_000]);
    assert.deepEqual(
      parsePaneScanOptions({ after_time_by_pane: [null, 1_788_480_000_000] }).after_time_by_pane,
      [null, 1_788_480_000],
    );
    assert.throws(() => parsePaneScanOptions({ after_time_by_pane: [true] }), /finite unix timestamp/);
    assert.throws(
      () => parsePaneScanOptions({ after_time_by_pane: [1_788_480_000_001] }),
      /whole-second/,
    );
    await assert.rejects(
      scanPanes({ after_time_by_pane: [90], closed_only: false }),
      /closed_only=true/,
    );
  });

  it('fails the whole scan with pane_index when a pane is missing a requested study', async () => {
    const result = await scanPanes({
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([
        {},
        { studies: [] },
        {},
      ])),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'no_matching_study');
    assert.equal(result.failure.pane_index, 1);
    assert.deepEqual(result.panes, []);
  });

  it('fails closed with pane_index when one pane identity flutters', async () => {
    const result = await scanPanes({
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([
        {},
        { symbolSequence: ['BYBIT:BTCUSDT.P', 'BYBIT:ETHUSDT.P'] },
        {},
      ])),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'identity_mismatch');
    assert.equal(result.failure.pane_index, 1);
    assert.deepEqual(result.panes, []);
  });

  it('retries a transient unavailable pane identity before requiring stability', async () => {
    const result = await scanPanes({
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([
        {},
        { symbolSequence: ['', 'BYBIT:BTCUSDT.P', 'BYBIT:BTCUSDT.P'] },
        {},
      ])),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.panes[1].symbol, 'BYBIT:BTCUSDT.P');
    assert.equal(result.stable_polls, 2);
  });

  it('fails closed when pane count or order changes during stability polling', async () => {
    const changedCount = await scanPanes({
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([{}, {}, {}], {
        layoutSequence: [[0, 1, 2], [0, 1]],
      })),
    });
    assert.equal(changedCount.success, false, JSON.stringify(changedCount));
    assert.equal(changedCount.failure.code, 'layout_changed');

    const changedOrder = await scanPanes({
      poll_interval_ms: 25,
      _deps: depsFor(makePaneRuntime([
        { symbol: 'BYBIT:BTCUSDT.P' },
        { symbol: 'BYBIT:ETHUSDT.P' },
      ], { layoutSequence: [[0, 1], [1, 0]] })),
    });
    assert.equal(changedOrder.success, false, JSON.stringify(changedOrder));
    assert.equal(changedOrder.failure.code, 'layout_changed');
    assert.equal(changedOrder.failure.pane_index, 0);
  });

  it('registers the bounded pane scan schema', () => {
    const tools = [];
    registerDataTools({ tool(name, description, schema) { tools.push({ name, description, schema }); } });
    const scan = tools.find(tool => tool.name === 'data_scan_panes');
    assert.ok(scan);
    assert.deepEqual(Object.keys(scan.schema).sort(), [
      'after_time_by_pane', 'closed_only', 'count', 'poll_interval_ms', 'stable_polls', 'study_filters',
    ]);
    assert.equal(scan.schema.after_time_by_pane.safeParse([90]).success, true);
    assert.equal(scan.schema.after_time_by_pane.safeParse([]).success, false);
    assert.equal(scan.schema.count.safeParse(1).success, true);
    assert.equal(scan.schema.count.safeParse(20).success, true);
    assert.equal(scan.schema.count.safeParse(21).success, false);
    assert.equal(scan.schema.stable_polls.safeParse(1).success, false);
  });
});

describe('buildBarSnapshotExpression', () => {
  it('embeds the requested locator in the page payload', () => {
    const expression = buildBarSnapshotExpression(parseBarSnapshotOptions({
      time: 100,
      count: 3,
      study_filters: ['趋势过滤器'],
      stable_polls: 2,
      poll_interval_ms: 100,
    }));
    assert.match(expression, /"time":100/);
    assert.match(expression, /"count":3/);
    assert.match(expression, /searchByTime/);
    assert.match(expression, /closedOnly/);
  });
});
