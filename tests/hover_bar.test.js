/**
 * chart_hover_bar unit tests. The page expressions execute against a small
 * in-process TradingView model and CDP fake; no Desktop process is contacted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHoverBarPositionExpression,
  buildHoverBarReadExpression,
  hoverBar,
  parseHoverBarOptions,
} from '../src/core/hover_bar.js';
import { registerChartTools } from '../src/tools/chart.js';

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
      return index < 0 ? null : { index, value: rows[index] };
    },
  };
}

function studySource({ entityId, name, items }) {
  return {
    id: () => (typeof entityId === 'function' ? entityId() : entityId),
    isVisible: () => true,
    metaInfo: () => ({ description: name }),
    dataWindowView: () => {
      const result = typeof items === 'function' ? items() : items;
      return result === undefined ? null : { items: () => result };
    },
  };
}

function defaultStudies(state) {
  return [
    studySource({
      entityId: () => state.trendId,
      name: '趋势过滤器0822',
      items: () => [
        { _title: 'EMA21', _value: 101 },
        { _title: 'TL', _value: state.trendValue },
      ],
    }),
    studySource({
      entityId: 'swing-1',
      name: '波段过滤器0822',
      items: () => [
        { _title: 'Divergence', _value: 55 },
        { _title: 'Zone', _value: '∅' },
      ],
    }),
  ];
}

function makeRuntime({
  bars = BARS,
  symbol = 'BYBIT:BTCUSDT.P',
  timeframe = '15',
  studies,
  replay = 'stopped',
  visibleIndices = [0, 1, 2],
  canZoom = true,
  crosshairAvailable = true,
  hoverIndex,
  onMouseMove,
  onSleep,
} = {}) {
  const state = {
    symbol,
    timeframe,
    trendId: 'trend-1',
    trendValue: 1,
    hoveredIndex: null,
    tick: 0,
    replay,
  };
  const visible = new Set(visibleIndices);
  const events = [];
  const rect = { left: 100, top: 50, width: 360, height: 240 };
  const coordinate = index => 30 + index * 80;
  const sourceList = studies || defaultStudies(state);
  let zoomCalls = 0;

  const scale = {
    indexToCoordinate(index) {
      return visible.has(index) ? coordinate(index) : -100;
    },
    ...(canZoom ? {
      zoomToBarsRange() {
        zoomCalls += 1;
        for (let index = 0; index < bars.length; index += 1) visible.add(index);
      },
    } : {}),
  };
  const model = {
    mainSeries: () => ({
      symbol: () => state.symbol,
      interval: () => state.timeframe,
      bars: () => barsApi(bars),
    }),
    model: () => ({ dataSources: () => sourceList }),
    timeScale: () => scale,
    ...(crosshairAvailable ? {
      crossHairSource: () => ({ appliedIndex: () => state.hoveredIndex }),
    } : {}),
  };
  const widget = {
    model: () => model,
    _mainDiv: { getBoundingClientRect: () => rect },
  };
  const chart = {
    symbol: () => state.symbol,
    resolution: () => state.timeframe,
    getAllStudies: () => sourceList.map(source => ({
      id: source.id(),
      name: source.metaInfo().description,
    })),
    _chartWidget: widget,
  };
  const pageWindow = {
    TradingViewApi: {
      _replayApi: {
        isReplayStarted: () => {
          if (state.replay === 'unavailable') throw new Error('Replay state unavailable');
          return state.replay === 'active';
        },
      },
      _activeChartWidgetWV: { value: () => chart },
    },
  };
  const runtime = {
    pageWindow,
    state,
    events,
    get zoomCalls() { return zoomCalls; },
    onSleep(delay) {
      state.tick += 1;
      onSleep?.({ state, delay });
    },
    async dispatchMouseEvent(event) {
      events.push(event);
      if (event.type !== 'mouseMoved') throw new Error(`unexpected mouse event: ${event.type}`);
      const selectedIndex = hoverIndex === undefined
        ? bars.findIndex((_, index) => Math.abs((event.x - rect.left) - coordinate(index)) < 0.001)
        : (typeof hoverIndex === 'function' ? hoverIndex() : hoverIndex);
      state.hoveredIndex = selectedIndex < 0 ? null : selectedIndex;
      onMouseMove?.({ state, event });
    },
  };
  return runtime;
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
    getClient: async () => ({
      Input: { dispatchMouseEvent: event => runtime.dispatchMouseEvent(event) },
    }),
  };
}

describe('chart_hover_bar options', () => {
  it('requires one exact locator before opening CDP', async () => {
    assert.throws(() => parseHoverBarOptions({}), /exactly one/);
    assert.throws(() => parseHoverBarOptions({ time: 100, bars_ago: 1 }), /exactly one/);
    assert.throws(() => parseHoverBarOptions({ bars_ago: -1 }), /bars_ago/);
    assert.throws(() => parseHoverBarOptions({ timeout_ms: 50, time: 100 }), /timeout_ms/);

    let touched = false;
    await assert.rejects(
      hoverBar({ _deps: { evaluateAsync: async () => { touched = true; } } }),
      /exactly one/,
    );
    assert.equal(touched, false);
  });
});

describe('chart_hover_bar exact Data Window fallback', () => {
  it('uses timeScale coordinates, one mouseMoved event, and proves the exact requested time twice', async () => {
    const runtime = makeRuntime();
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器', '波段过滤器'],
      stable_polls: 2,
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(runtime),
    });

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.capture_mode, 'data_window_hover');
    assert.equal(result.identity_verified, true);
    assert.equal(result.symbol, 'BYBIT:BTCUSDT.P');
    assert.equal(result.timeframe, '15');
    assert.equal(result.target_bar_time, 100);
    assert.equal(result.hover_bar_time, 100);
    assert.equal(result.target_logical_index, 1);
    assert.equal(result.hover_logical_index, 1);
    assert.equal(result.bar.close, 2.5);
    assert.equal(result.stable_polls, 2);
    assert.deepEqual(result.studies.map(study => study.entity_id), ['trend-1', 'swing-1']);
    assert.equal(result.studies[1].values[1].value, null, 'inactive Data Window item is explicit null');
    assert.deepEqual(runtime.events.map(event => event.type), ['mouseMoved']);
    assert.equal(runtime.zoomCalls, 0);
  });

  it('locates bars_ago from the last loaded bar', async () => {
    const runtime = makeRuntime();
    const result = await hoverBar({
      bars_ago: 2,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.target_bar_time, 90);
    assert.equal(result.hover_bar_time, 90);
    assert.equal(result.target_logical_index, 0);
    assert.deepEqual(runtime.events.map(event => event.type), ['mouseMoved']);
  });

  it('normalizes millisecond timestamps and rejects a time that is not an exact loaded bar', async () => {
    const epochBars = BARS.map(([time, ...values]) => [1788456500 + time, ...values]);
    const millisecondRuntime = makeRuntime({ bars: epochBars });
    const millisecondResult = await hoverBar({
      time: 1788456600000,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(millisecondRuntime),
    });
    assert.equal(millisecondResult.success, true, JSON.stringify(millisecondResult));
    assert.equal(millisecondResult.target_bar_time, 1788456600);

    const missingRuntime = makeRuntime();
    const missingResult = await hoverBar({
      time: 95,
      study_filters: ['趋势过滤器'],
      _deps: depsFor(missingRuntime),
    });
    assert.equal(missingResult.success, false, JSON.stringify(missingResult));
    assert.equal(missingResult.failure.code, 'bar_not_found');
    assert.deepEqual(missingRuntime.events, []);
  });

  it('reveals an initially invisible loaded bar through timeScale before moving the crosshair', async () => {
    const runtime = makeRuntime({ visibleIndices: [1, 2] });
    const result = await hoverBar({
      time: 90,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.hover.viewport_adjusted, true);
    assert.equal(runtime.zoomCalls, 1);
    assert.equal(result.hover_bar_time, 90);
  });

  it('fails closed when a loaded bar cannot be made visible', async () => {
    const runtime = makeRuntime({ visibleIndices: [1, 2], canZoom: false });
    const result = await hoverBar({
      time: 90,
      study_filters: ['趋势过滤器'],
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'bar_not_visible');
    assert.deepEqual(runtime.events, []);
  });

  it('fails closed while Replay is active or its state cannot be read, before any mouse event', async () => {
    for (const replay of ['active', 'unavailable']) {
      const runtime = makeRuntime({ replay });
      const result = await hoverBar({
        time: 100,
        study_filters: ['趋势过滤器'],
        _deps: depsFor(runtime),
      });
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.failure.code, replay === 'active' ? 'replay_active' : 'replay_state_unavailable');
      assert.deepEqual(runtime.events, []);
    }
  });

  it('treats a non-boolean Replay state as unavailable rather than assuming it is stopped', async () => {
    const runtime = makeRuntime();
    runtime.pageWindow.TradingViewApi._replayApi.isReplayStarted = () => 'false';
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'replay_state_unavailable');
    assert.deepEqual(runtime.events, []);
  });

  it('rechecks the Replay gate after mouseMoved before reading Data Window values', async () => {
    const runtime = makeRuntime({
      onMouseMove: ({ state }) => { state.replay = 'active'; },
    });
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'replay_active');
    assert.deepEqual(runtime.events.map(event => event.type), ['mouseMoved']);
  });

  it('fails closed when the applied crosshair bar is not the requested bar', async () => {
    const runtime = makeRuntime({ hoverIndex: 2 });
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'hover_time_mismatch');
    assert.equal(result.failure.actual_bar_time, 110);
    assert.deepEqual(runtime.events.map(event => event.type), ['mouseMoved']);
  });

  it('fails closed when chart identity changes after mouseMoved', async () => {
    const runtime = makeRuntime({
      onMouseMove: ({ state }) => { state.symbol = 'BYBIT:ETHUSDT.P'; },
    });
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'identity_mismatch');
    assert.deepEqual(runtime.events.map(event => event.type), ['mouseMoved']);
  });

  it('fails closed when selected study identity changes after mouseMoved', async () => {
    const runtime = makeRuntime({
      onMouseMove: ({ state }) => { state.trendId = 'trend-replaced'; },
    });
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'study_identity_mismatch');
  });

  it('fails closed when crosshair state is not exposed', async () => {
    const runtime = makeRuntime({ crosshairAvailable: false });
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'crosshair_unavailable');
  });

  it('fails closed when Data Window values never stabilize', async () => {
    const runtime = makeRuntime({
      onSleep: ({ state }) => { state.trendValue = state.tick + 10; },
    });
    const result = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      stable_polls: 2,
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(runtime),
    });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.failure.code, 'data_window_unstable');
    assert.deepEqual(runtime.events.map(event => event.type), ['mouseMoved']);
  });

  it('fails closed when a target Data Window cannot be read or filter is absent', async () => {
    const unreadable = studySource({
      entityId: 'trend-1',
      name: '趋势过滤器0822',
      items: () => undefined,
    });
    const unreadableRuntime = makeRuntime({ studies: [unreadable] });
    const unreadableResult = await hoverBar({
      time: 100,
      study_filters: ['趋势过滤器'],
      poll_interval_ms: 25,
      timeout_ms: 100,
      _deps: depsFor(unreadableRuntime),
    });
    assert.equal(unreadableResult.success, false, JSON.stringify(unreadableResult));
    assert.equal(unreadableResult.failure.code, 'data_window_unavailable');

    const absentRuntime = makeRuntime();
    const absentResult = await hoverBar({
      time: 100,
      study_filters: ['不存在的指标'],
      _deps: depsFor(absentRuntime),
    });
    assert.equal(absentResult.success, false, JSON.stringify(absentResult));
    assert.equal(absentResult.failure.code, 'no_matching_study');
    assert.deepEqual(absentRuntime.events, []);
  });
});

describe('chart_hover_bar expression and registration', () => {
  it('uses the time scale and Crosshair source in separately testable page expressions', () => {
    const options = parseHoverBarOptions({ time: 100, study_filters: ['趋势过滤器'] });
    const position = buildHoverBarPositionExpression(options);
    const read = buildHoverBarReadExpression(options, {
      symbol: 'BYBIT:BTCUSDT.P',
      timeframe: '15',
      target_bar_time: 100,
      study_identity: [{ entity_id: 'trend-1', name: '趋势过滤器0822' }],
    });
    assert.match(position, /searchByTime/);
    assert.match(position, /indexToCoordinate/);
    assert.match(position, /zoomToBarsRange/);
    assert.match(read, /crossHairSource/);
    assert.match(read, /dataWindowView/);
    assert.match(read, /hover_time_mismatch/);
  });

  it('registers a bounded chart_hover_bar schema', () => {
    const tools = [];
    registerChartTools({ tool(name, description, schema) { tools.push({ name, description, schema }); } });
    const hover = tools.find(tool => tool.name === 'chart_hover_bar');
    assert.ok(hover);
    assert.deepEqual(Object.keys(hover.schema).sort(), [
      'bars_ago', 'poll_interval_ms', 'stable_polls', 'study_filters', 'time', 'timeout_ms',
    ]);
    assert.equal(hover.schema.bars_ago.safeParse(0).success, true);
    assert.equal(hover.schema.bars_ago.safeParse(5001).success, false);
    assert.equal(hover.schema.stable_polls.safeParse(1).success, false);
    assert.equal(hover.schema.timeout_ms.safeParse(99).success, false);
  });
});
