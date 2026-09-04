/**
 * Tests for all replay functions in src/core/replay.js.
 * Covers: start, step, autoplay, stop, trade, status + DI mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { start, step, autoplay, stop, trade, status, VALID_AUTOPLAY_DELAYS } from '../src/core/replay.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock evaluate function that returns scripted values.
 * Calls are tracked in .calls array.
 * @param {object} responses — map of substring→return value. First matching key wins.
 * @param {Array} [sequence] — if provided, override responses with sequential returns
 */
function mockEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const options = [];
  const fn = async (expr, opts) => {
    calls.push(expr);
    options.push(opts);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  fn.options = options;
  return fn;
}

function mockGetReplayApi() {
  return async () => 'window.__rp';
}

function mockDeps(responses = {}, sequence) {
  const evaluate = mockEvaluate({ 'isReadyToPlay': true, ...responses }, sequence);
  return {
    _deps: {
      evaluate,
      evaluateAsync: evaluate,
      getReplayApi: mockGetReplayApi(),
      wait: async () => {},
      log: () => {},
    },
    evaluate,
  };
}

function virtualClock() {
  let currentMs = 0;
  return {
    now: () => currentMs,
    wait: async ms => { currentMs += ms; },
  };
}

// ── start() ──────────────────────────────────────────────────────────────

describe('start() — date selection and polling', () => {
  it('sends selectDate with timestamp in ms only after readiness', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    });
    const result = await start({ date: '2026-03-15', _deps });
    assert.equal(result.success, true);
    assert.equal(result.replay_started, true);
    assert.equal(result.current_date, 1773532799);
    assert.equal(result.date, '2026-03-15');
    // The selection Promise is not awaited through CDP; start confirmation is
    // instead the bounded isReplayStarted + currentDate handshake.
    const selectCallIndex = evaluate.calls.findIndex(c => c.includes('selectDate'));
    const selectCall = evaluate.calls[selectCallIndex];
    assert.ok(selectCall, 'selectDate was called');
    assert.ok(selectCall.includes('1773532800000') || selectCall.includes('177'), 'passes ms timestamp');
    assert.equal(evaluate.options[selectCallIndex]?.awaitPromise, undefined, 'selectDate does not create an unbounded CDP await');
  });

  it('calls selectFirstAvailableDate when no date given', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectFirstAvailableDate': undefined,
      'isReplayStarted': true,
      'currentDate': 946684800,
    });
    const result = await start({ _deps });
    assert.equal(result.date, '(first available)');
    const firstAvailIndex = evaluate.calls.findIndex(c => c.includes('selectFirstAvailableDate'));
    const firstAvail = evaluate.calls[firstAvailIndex];
    assert.ok(firstAvail, 'selectFirstAvailableDate was called');
    assert.equal(evaluate.options[firstAvailIndex]?.awaitPromise, undefined, 'selectFirstAvailableDate does not create an unbounded CDP await');
  });

  it('waits for ReadyToPlay before sending selectDate and logs each completed stage', async () => {
    let readyChecks = 0;
    const calls = [];
    const stages = [];
    const { now, wait } = virtualClock();
    const evaluate = async expr => {
      calls.push(expr);
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar')) return undefined;
      if (expr.includes('isReadyToPlay')) return ++readyChecks >= 3;
      if (expr.includes('selectDate')) return { promise: true };
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) return 1773532800;
      return undefined;
    };

    const result = await start({
      date: '2026-03-15',
      _deps: { evaluate, getReplayApi: mockGetReplayApi(), now, wait, log: (stage, details) => stages.push({ stage, ...details }) },
    });

    assert.equal(result.success, true);
    assert.equal(readyChecks, 3);
    const selectCallIndex = calls.findIndex(call => call.includes('selectDate'));
    const lastReadyCheckIndex = calls.map((call, index) => ({ call, index }))
      .filter(({ call }) => call.includes('isReadyToPlay'))
      .at(-1).index;
    assert.ok(selectCallIndex > lastReadyCheckIndex, 'selectDate follows the ReadyToPlay check');
    assert.ok(stages.some(entry => entry.stage === 'readiness' && entry.status === 'ready'));
    assert.ok(stages.some(entry => entry.stage === 'selection' && entry.status === 'sent'));
    assert.ok(stages.some(entry => entry.stage === 'started' && entry.status === 'ready'));
  });

  it('times out ReadyToPlay without sending selectDate and cleans up publicly', async () => {
    let stopCalled = false;
    const calls = [];
    const stages = [];
    const { now, wait } = virtualClock();
    const evaluate = async expr => {
      calls.push(expr);
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar')) return undefined;
      if (expr.includes('isReadyToPlay')) return false;
      if (expr.includes('stopReplay')) { stopCalled = true; return undefined; }
      return undefined;
    };

    await assert.rejects(
      () => start({
        date: '2026-03-15',
        _deps: { evaluate, getReplayApi: mockGetReplayApi(), now, wait, log: (stage, details) => stages.push({ stage, ...details }) },
      }),
      /timed out waiting for Replay UI readiness/,
    );
    assert.equal(calls.some(call => call.includes('selectDate')), false, 'no selection is sent before ReadyToPlay');
    assert.equal(stopCalled, true, 'public stopReplay cleans up the unready toolbar mode');
    assert.ok(stages.some(entry => entry.stage === 'failure' && entry.reason === 'ready_to_play_timeout'));
  });

  it('throws on invalid date string', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': true, 'showReplayToolbar': undefined });
    await assert.rejects(
      () => start({ date: 'not-a-date', _deps }),
      (err) => {
        assert.ok(err.message.includes('Invalid date'));
        assert.ok(err.message.includes('not-a-date'));
        return true;
      },
    );
  });

  it('throws when replay not available', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': false });
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps }),
      (err) => err.message.includes('not available'),
    );
  });

  it('polls until isReplayStarted AND currentDate are set', async () => {
    let pollCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReadyToPlay')) return true;
      if (expr.includes('isReplayStarted')) {
        pollCount++;
        return pollCount >= 3; // becomes true on 3rd poll
      }
      if (expr.includes('currentDate')) {
        return pollCount >= 4 ? 1700000000 : null; // non-null on 4th poll
      }
      return undefined;
    };
    evaluate.calls = [];
    const { now, wait } = virtualClock();
    const result = await start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi(), now, wait, log: () => {} } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 1700000000);
    assert.ok(pollCount >= 4, 'polled multiple times');
  });

  it('throws and stops replay when polling times out (never started)', async () => {
    let stopCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReadyToPlay')) return true;
      if (expr.includes('isReplayStarted')) return false; // never starts
      if (expr.includes('currentDate')) return null;
      if (expr.includes('stopReplay')) { stopCalled = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    const { now, wait } = virtualClock();
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi(), now, wait, log: () => {} } }),
      (err) => {
        assert.ok(err.message.includes('Replay failed to start'));
        return true;
      },
    );
    assert.ok(stopCalled, 'stopReplay called for cleanup');
  });

  it('throws and stops replay when currentDate never becomes available', async () => {
    let stopCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReadyToPlay')) return true;
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) return null;
      if (expr.includes('stopReplay')) { stopCalled = true; return undefined; }
      return undefined;
    };
    const { now, wait } = virtualClock();
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi(), now, wait, log: () => {} } }),
      (err) => err.message.includes('Replay start timed out') && err.message.includes('currentDate'),
    );
    assert.ok(stopCalled, 'stopReplay called for cleanup');
  });
});

// ── step() ───────────────────────────────────────────────────────────────

describe('step() — doStep and polling', () => {
  it('calls doStep and polls until currentDate changes', async () => {
    let stepDone = false;
    let dateReadCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) {
        dateReadCount++;
        // First read (before) returns 1000, then after doStep: 1000 twice, then 2000
        if (!stepDone) return 1000;
        return dateReadCount >= 4 ? 2000 : 1000;
      }
      if (expr.includes('doStep')) { stepDone = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 2000);
    assert.equal(result.action, 'step');
  });

  it('returns stale date if poll times out (date never changes)', async () => {
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) return 5000; // never changes
      if (expr.includes('doStep')) return undefined;
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.current_date, 5000);
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => step({ _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── autoplay() ───────────────────────────────────────────────────────────

describe('autoplay() — delay validation', () => {
  for (const delay of VALID_AUTOPLAY_DELAYS) {
    it(`accepts valid delay ${delay}ms`, async () => {
      const { _deps } = mockDeps({
        'isReplayStarted': true,
        'changeAutoplayDelay': undefined,
        'toggleAutoplay': undefined,
        'isAutoplayStarted': true,
        'autoplayDelay': delay,
      });
      const result = await autoplay({ speed: delay, _deps });
      assert.equal(result.success, true);
      assert.equal(result.delay_ms, delay);
    });
  }

  const INVALID_DELAYS = [50, 60000, 99, 101, 500, 750, 1500, 9999, 20000];
  for (const delay of INVALID_DELAYS) {
    it(`rejects invalid delay ${delay}ms before any CDP call`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => autoplay({ speed: delay, _deps }),
        (err) => {
          assert.ok(err.message.includes('Invalid autoplay delay'));
          assert.ok(err.message.includes(String(delay)));
          return true;
        },
      );
      // No CDP calls should have been made
      assert.equal(evaluate.calls.length, 0, 'no CDP calls for invalid speed');
    });
  }

  it('toggles without changing speed when speed is 0', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': true,
      'autoplayDelay': 100,
    });
    const result = await autoplay({ speed: 0, _deps });
    assert.equal(result.success, true);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called for speed=0');
  });

  it('toggles without changing speed when speed omitted', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': false,
      'autoplayDelay': 300,
    });
    const result = await autoplay({ _deps });
    assert.equal(result.autoplay_active, false);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called when speed omitted');
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => autoplay({ speed: 1000, _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── stop() ───────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('calls stopReplay when started', async () => {
    let replayStarted = true;
    const evaluate = mockEvaluate({
      'isReplayStarted': () => replayStarted,
    });
    const asyncCalls = [];
    const evaluateAsync = async expr => {
      asyncCalls.push(expr);
      if (expr.includes('stopReplay')) replayStarted = false;
      return undefined;
    };
    const result = await stop({ _deps: { evaluate, evaluateAsync, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.action, 'replay_stopped');
    const stopCall = asyncCalls.find(c => c.includes('stopReplay'));
    assert.ok(stopCall, 'stopReplay was called');
  });

  it('returns already_stopped when not started', async () => {
    const { _deps, evaluate } = mockDeps({ 'isReplayStarted': false });
    const result = await stop({ _deps });
    assert.equal(result.action, 'already_stopped');
    const stopCall = evaluate.calls.find(c => c.includes('stopReplay'));
    assert.equal(stopCall, undefined, 'stopReplay not called');
  });

  it('does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('hideReplayToolbar'), 'hideReplayToolbar must not appear anywhere');
  });
});

// ── trade() ──────────────────────────────────────────────────────────────

describe('trade()', () => {
  for (const action of ['buy', 'sell', 'close']) {
    it(`executes ${action} action`, async () => {
      const { _deps, evaluate } = mockDeps({
        'isReplayStarted': true,
        [action === 'close' ? 'closePosition' : action]: undefined,
        'position': 1,
        'realizedPL': 50.5,
      });
      const result = await trade({ action, _deps });
      assert.equal(result.success, true);
      assert.equal(result.action, action);
      assert.equal(result.position, 1);
      assert.equal(result.realized_pnl, 50.5);
    });
  }

  it('throws on invalid action', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': true });
    await assert.rejects(
      () => trade({ action: 'hold', _deps }),
      (err) => err.message.includes('Invalid action'),
    );
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => trade({ action: 'buy', _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── status() ─────────────────────────────────────────────────────────────

describe('status()', () => {
  it('returns full status object', async () => {
    let callIdx = 0;
    const evaluate = async (expr) => {
      callIdx++;
      // Call 1: big inline IIFE for status fields
      if (callIdx === 1) {
        return {
          is_replay_available: true,
          is_replay_started: true,
          is_autoplay_started: false,
          replay_mode: 'ActiveChart',
          current_date: 1700000000,
          autoplay_delay: 1000,
        };
      }
      // Call 2: position
      if (callIdx === 2) return 2;
      // Call 3: realizedPL
      if (callIdx === 3) return 123.45;
      return undefined;
    };
    evaluate.calls = [];
    const result = await status({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.is_replay_started, true);
    assert.equal(result.current_date, 1700000000);
    assert.equal(result.position, 2);
    assert.equal(result.realized_pnl, 123.45);
  });
});
