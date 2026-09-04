import assert from 'node:assert/strict';
import { it } from 'node:test';
import { symbolInfo } from '../src/core/chart.js';

it('gets symbol metadata through the injected evaluator and preserves TradingView session fields', async () => {
  const calls = [];
  const result = await symbolInfo({
    _deps: {
      evaluate: async expression => {
        calls.push(expression);
        return {
          symbol: 'XAUUSD',
          full_name: 'FX:XAUUSD',
          exchange: 'FXCM',
          description: 'Gold Spot / U.S. Dollar',
          type: 'forex',
          pro_name: 'FX:XAUUSD',
          typespecs: ['forex'],
          session: '1700-1700',
          timezone: 'America/New_York',
          session_holidays: '20261225',
          corrections: '1800-1700:1234567',
          resolution: '240',
          chart_type: 1,
        };
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.full_name, 'FX:XAUUSD');
  assert.equal(result.session, '1700-1700');
  assert.equal(result.timezone, 'America/New_York');
  assert.equal(result.session_holidays, '20261225');
  assert.equal(result.corrections, '1800-1700:1234567');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /symbolExt\(\)/);
});
