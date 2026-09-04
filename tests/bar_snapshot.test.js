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
                mainSeries: () => ({ bars: () => barsApi(bars) }),
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
    assert.equal(tools.some(tool => tool.name === 'data_scan_panes'), false);
    assert.equal(tools.some(tool => tool.name === 'chart_hover_bar'), false);
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
