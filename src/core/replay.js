/**
 * Core replay mode logic.
 */
import {
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  getReplayApi as _getReplayApi,
} from '../connection.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];
export const MAX_CAPTURE_CHUNK_BARS = 25;

const DEFAULT_CAPTURE_POLL_ATTEMPTS = 24;
const DEFAULT_CAPTURE_POLL_INTERVAL_MS = 125;
// Replay can publish the next OHLCV row before its currentDate watched value
// has settled.  The clock handshake below is the safety gate; this delay gives
// it a reasonable first chance to render under normal Desktop conditions.
const DEFAULT_CAPTURE_SETTLE_MS = 1500;
export const MAX_ACTIVE_READY_TIMEOUT_MS = 120000;
const DEFAULT_ACTIVE_READY_TIMEOUT_MS = MAX_ACTIVE_READY_TIMEOUT_MS;
const DEFAULT_ACTIVE_READY_POLL_INTERVAL_MS = 250;
const DEFAULT_ACTIVE_READY_STABLE_POLLS = 4;
// Kept for request compatibility with v2 callers. In v4 the active Data
// Window is preview-only; finalized features come from timestamped PlotList
// rows after doStep().
const DEFAULT_ACTIVE_READY_STUDY_STABLE_POLLS = 4;
// A Replay doStep can turn the same timestamped preview row into its final
// OHLCV row. Confirm the closed row twice before recording it.
// A target row can be published before its final OHLCV is complete. Keep the
// post-step confirmation deliberately stricter than the preview gate: four
// identical target-row observations plus the quiet window are required by
// default before a historical feature row is persisted.
const DEFAULT_POST_STEP_CLOSED_BAR_STABLE_POLLS = 4;
export const REPLAY_CAPTURE_SCHEMA_VERSION = '0822-replay.v4/post_target_final_label_epoch';
export const REPLAY_LABEL_IDENTITY_VERSION = 'pine-label/v4/physical-epoch';
export const REPLAY_PERSISTENT_LABEL_KEY_PREFIX = 'pl4:';
export const MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS = 50000;
const REPLAY_STOP_POLL_ATTEMPTS = 12;
const REPLAY_STOP_POLL_INTERVAL_MS = 250;
const REPLAY_START_READY_TIMEOUT_MS = 30000;
const REPLAY_START_CONFIRM_TIMEOUT_MS = 7500;
const REPLAY_START_POLL_INTERVAL_MS = 250;

function logReplayStart(stage, details = {}) {
  process.stderr.write(`${JSON.stringify({ event: 'replay_start', stage, ...details })}\n`);
}

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
  };
}

/**
 * Validate the intentionally small replay-capture batch size before touching
 * TradingView.  A chunk is a checkpoint unit, not an autoplay substitute.
 */
export function validateCaptureChunkBars(bars) {
  const value = Number(bars);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CAPTURE_CHUNK_BARS) {
    throw new Error(`bars must be an integer from 1 to ${MAX_CAPTURE_CHUNK_BARS}`);
  }
  return value;
}

function validateCapturePollAttempts(value) {
  if (value === undefined || value === null) return DEFAULT_CAPTURE_POLL_ATTEMPTS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 80) {
    throw new Error('poll_attempts must be an integer from 1 to 80');
  }
  return parsed;
}

function validateCapturePollInterval(value) {
  if (value === undefined || value === null) return DEFAULT_CAPTURE_POLL_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 25 || parsed > 2000) {
    throw new Error('poll_interval_ms must be an integer from 25 to 2000');
  }
  return parsed;
}

function validateCaptureSettleMs(value) {
  if (value === undefined || value === null) return DEFAULT_CAPTURE_SETTLE_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000) {
    throw new Error('settle_ms must be an integer from 0 to 10000');
  }
  return parsed;
}

function validateActiveReadyTimeoutMs(value) {
  if (value === undefined || value === null) return DEFAULT_ACTIVE_READY_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > MAX_ACTIVE_READY_TIMEOUT_MS) {
    throw new Error(`active_ready_timeout_ms must be an integer from 1000 to ${MAX_ACTIVE_READY_TIMEOUT_MS}`);
  }
  return parsed;
}

function validateActiveReadyPollIntervalMs(value) {
  if (value === undefined || value === null) return DEFAULT_ACTIVE_READY_POLL_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 50 || parsed > 1000) {
    throw new Error('active_ready_poll_interval_ms must be an integer from 50 to 1000');
  }
  return parsed;
}

function validateActiveReadyStablePolls(value) {
  if (value === undefined || value === null) return DEFAULT_ACTIVE_READY_STABLE_POLLS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 12) {
    throw new Error('active_ready_stable_polls must be an integer from 2 to 12');
  }
  return parsed;
}

function validateActiveReadyStudyStablePolls(value) {
  if (value === undefined || value === null) return DEFAULT_ACTIVE_READY_STUDY_STABLE_POLLS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 12) {
    throw new Error('active_ready_study_stable_polls must be an integer from 2 to 12');
  }
  return parsed;
}

function validatePostStepClosedBarStablePolls(value) {
  if (value === undefined || value === null) return DEFAULT_POST_STEP_CLOSED_BAR_STABLE_POLLS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 12) {
    throw new Error('post_step_closed_bar_stable_polls must be an integer from 2 to 12');
  }
  return parsed;
}

function validateShapeStateInitialized(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error('shape_state_initialized must be a boolean');
  }
  return value;
}

/**
 * TradingView resolution strings for fixed-duration bars. Calendar-relative
 * weekly/monthly resolutions intentionally return null: their close cannot be
 * reconstructed from arithmetic without a market calendar.
 */
export function replayResolutionToSeconds(resolution) {
  if (typeof resolution !== 'string' && typeof resolution !== 'number') return null;
  const raw = String(resolution).trim();
  if (!raw) return null;
  const duration = (count, unitSeconds) => {
    const seconds = Number(count) * unitSeconds;
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  };
  if (/^\d+$/.test(raw)) return duration(raw, 60);
  const minutes = /^(\d+)m$/.exec(raw);
  if (minutes) return duration(minutes[1], 60);
  const hours = /^(\d+)h$/i.exec(raw);
  if (hours) return duration(hours[1], 3600);
  const days = /^(\d*)d$/i.exec(raw);
  if (days) return duration(days[1] || 1, 86400);
  return null;
}

/**
 * Checkpoint keys are causal state, not a best-effort hint.  Do not truncate
 * them: silently dropping a key can re-emit a historical signal on resume.
 */
function validateReplayCaptureCheckpointKeys(value, fieldName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  if (value.length > MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS) {
    throw new Error(`${fieldName} must contain at most ${MAX_REPLAY_CAPTURE_CHECKPOINT_KEYS} entries`);
  }
  if (value.some(item => typeof item !== 'string')) {
    throw new Error(`${fieldName} must contain only strings`);
  }
  return [...value];
}

export function isPersistentReplayLabelKey(value) {
  if (typeof value !== 'string' || !value.startsWith(REPLAY_PERSISTENT_LABEL_KEY_PREFIX)) {
    return false;
  }
  // v4 writes `pl4:<encoded-study>:<unix-seconds>:<encoded-source>`.
  // Validate the durable shape at the Node boundary as well as the prefix so a
  // caller cannot smuggle a replay-local id back in as a purported checkpoint.
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'pl4' || parts[1] === '' || parts[3] === '') {
    return false;
  }
  return /^-?\d+$/.test(parts[2]) && Number.isSafeInteger(Number(parts[2]));
}

function validateReplayLabelCheckpointKeys(value, fieldName) {
  const keys = validateReplayCaptureCheckpointKeys(value, fieldName);
  if (keys.some(key => !isPersistentReplayLabelKey(key))) {
    throw new Error(`${fieldName} must contain only ${REPLAY_PERSISTENT_LABEL_KEY_PREFIX} v4 physical-epoch identities`);
  }
  return keys;
}

/**
 * The research collector must never silently mix the hidden 0112 indicators
 * into the visible 0822 observations.
 */
export function is0822ResearchStudyName(name) {
  const text = String(name || '');
  return text.indexOf('0112') === -1
    && text.indexOf('0822') !== -1
    && (text.indexOf('趋势过滤器') !== -1 || text.indexOf('波段过滤器') !== -1);
}

/** The current EMA source is deliberately separate from the 0822 studies. */
export function isTrainer0906StudyName(name) {
  const text = String(name || '');
  return text.indexOf('0112') === -1
    && text.indexOf('一百单实盘训练器') !== -1
    && text.indexOf('0906') !== -1;
}

/**
 * A stable replay-local Pine primitive identity for diagnostics and source
 * provenance. It is deliberately not a durable replay-capture checkpoint:
 * Replay can reuse both primitive IDs and logical x values after restart.
 * v4 checkpoints are built page-side from this source identity plus a verified
 * physical signal epoch.
 */
export function stableReplayLabelIdentity(studyName, label) {
  const source = label || {};
  const id = source.id === undefined || source.id === null ? '' : String(source.id);
  const text = source.text === undefined || source.text === null ? '' : String(source.text);
  const price = source.price === undefined || source.price === null ? '' : String(source.price);
  const x = source.x === undefined || source.x === null ? '' : String(source.x);
  const prefix = String(studyName || '');
  return id
    ? `${prefix}::id:${id}`
    : `${prefix}::x:${x}::text:${text}::price:${price}`;
}

/**
 * Keep Pine label evidence small: prefer labels printed on the active replay
 * bar, otherwise preserve only the latest label position available at that
 * observation.  This does not claim a label's x-coordinate is its signal
 * time; callers receive observed_at_open_time separately.
 */
export function selectCurrentOrMaxXReplayLabels(
  studyName,
  rawLabels,
  activeOpenTime,
  activeLogicalIndex = null,
) {
  const labels = Array.isArray(rawLabels) ? rawLabels.filter(Boolean) : [];

  function asNumeric(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function asComparableTime(value) {
    const numeric = asNumeric(value);
    return numeric === null ? null : (Math.abs(numeric) > 100000000000 ? numeric / 1000 : numeric);
  }

  const activeTime = asComparableTime(activeOpenTime);
  const activeIsEpoch = activeTime !== null && Math.abs(activeTime) >= 100000000;
  const activeIndex = typeof activeLogicalIndex === 'number' && Number.isFinite(activeLogicalIndex)
    ? activeLogicalIndex
    : null;
  function positionFor(label) {
    const raw = asNumeric(label && label.x);
    if (raw === null || activeTime === null) return null;
    const normalizedTime = Math.abs(raw) > 100000000000 ? raw / 1000 : raw;
    if (activeIsEpoch && Math.abs(normalizedTime) < 100000000) {
      // Real Pine labels often store a logical bar index (for example 660),
      // not an epoch. Without the matching active logical index this relation
      // is unknowable, so skip it rather than backdating/seeing it early.
      if (activeIndex === null || !Number.isInteger(raw)) return null;
      return { kind: 'logical', value: raw, active: activeIndex };
    }
    return { kind: 'time', value: normalizedTime, active: activeTime };
  }

  const positioned = labels.map(label => ({ label, position: positionFor(label) }))
    .filter(entry => entry.position !== null);
  const current = positioned.filter(entry => entry.position.value === entry.position.active);
  const eligible = positioned.filter(entry => entry.position.value <= entry.position.active);

  let selected = current;
  let selection = current.length > 0 ? 'current_x' : 'none';
  if (selected.length === 0 && eligible.length > 0) {
    let max = null;
    for (const entry of eligible) {
      const x = entry.position.value;
      if (max === null || x > max) max = x;
    }
    if (max !== null) {
      selected = eligible.filter(entry => entry.position.value === max);
      selection = 'max_x';
    }
  }

  return {
    selection,
    labels: selected.map(entry => {
      const label = entry.label;
      return {
        id: label.id === undefined || label.id === null ? null : String(label.id),
        label_identity: stableReplayLabelIdentity(studyName, label),
        text: label.text === undefined || label.text === null ? '' : String(label.text),
        price: label.price === undefined || label.price === null ? null : label.price,
        x: label.x === undefined || label.x === null ? null : label.x,
        observed_at: activeOpenTime,
        observed_at_open_time: activeOpenTime,
        selection,
      };
    }),
  };
}

function sameReplayTime(left, right) {
  if (left === right) return true;
  function asComparableTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.abs(value) > 100000000000 ? value / 1000 : value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.abs(parsed) > 100000000000 ? parsed / 1000 : parsed;
    }
    return null;
  }
  const a = asComparableTime(left);
  const b = asComparableTime(right);
  return a !== null && b !== null && a === b;
}

function replayTimeGreaterThan(left, right) {
  function asComparableTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.abs(value) > 100000000000 ? value / 1000 : value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.abs(parsed) > 100000000000 ? parsed / 1000 : parsed;
    }
    return null;
  }
  const a = asComparableTime(left);
  const b = asComparableTime(right);
  return a !== null && b !== null && a > b;
}

function replayNumericLabelX(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function replayLabelXMatchesActive(labelX, activeOpenTime, activeLogicalIndex) {
  const rawX = replayNumericLabelX(labelX);
  const activeTime = replayNumericLabelX(activeOpenTime);
  if (rawX === null || activeTime === null) return false;
  const normalizedActiveTime = Math.abs(activeTime) > 100000000000 ? activeTime / 1000 : activeTime;
  const normalizedLabelTime = Math.abs(rawX) > 100000000000 ? rawX / 1000 : rawX;
  if (Math.abs(normalizedActiveTime) >= 100000000 && Math.abs(normalizedLabelTime) < 100000000) {
    return typeof activeLogicalIndex === 'number'
      && Number.isFinite(activeLogicalIndex)
      && Number.isInteger(rawX)
      && rawX === activeLogicalIndex;
  }
  return normalizedLabelTime === normalizedActiveTime;
}

function sameReplayBar(left, right) {
  if (!left || !right || !sameReplayTime(left.time, right.time)) return false;
  for (const field of ['open', 'high', 'low', 'close', 'volume']) {
    const a = Number(left[field]);
    const b = Number(right[field]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const tolerance = Math.max(1, Math.abs(a), Math.abs(b)) * 1e-10;
    if (Math.abs(a - b) > tolerance) return false;
  }
  return true;
}

function isUsableReplayDataWindowValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' || typeof value === 'boolean';
}

function isUsableReplayCoreValue(value) {
  return isUsableReplayDataWindowValue(value)
    && (typeof value !== 'string' || value.trim() !== '');
}

const TREND_REQUIRED_EMA_FIELDS = ['EMA1', 'EMA2', 'EMA3', 'EMA4'];
const TREND_REQUIRED_SIGNAL_FIELDS = ['TL', 'TS', 'PB', 'RB', 'RL', 'RS', 'TZ', 'BZ'];
const SWING_REQUIRED_FIELDS = ['DIVERGENCE_LINE', 'OVERBOUGHT_ZONE', 'OVERSOLD_ZONE'];

function normalizeReplayDataWindowTitle(title) {
  return String(title ?? '').replace(/[\s_－-]/g, '').toUpperCase();
}

function replayTrendCoreField(title) {
  const normalized = normalizeReplayDataWindowTitle(title);
  // The current 0822 PlotList exposes the moving averages by their periods
  // (EMA21/55/100/200), while the Data Window historically used EMA1–4. Keep
  // the public feature names stable without relying on a raw plot index.
  const emaPeriodAliases = {
    EMA21: 'EMA1',
    EMA55: 'EMA2',
    EMA100: 'EMA3',
    EMA200: 'EMA4',
  };
  if (emaPeriodAliases[normalized]) return emaPeriodAliases[normalized];
  if (TREND_REQUIRED_EMA_FIELDS.includes(normalized)) return normalized;
  const aliases = {
    TL: 'TL', 顺势多: 'TL',
    TS: 'TS', 顺势空: 'TS',
    PB: 'PB', 回调: 'PB',
    RB: 'RB', 反弹: 'RB',
    RL: 'RL', 区间反弹: 'RL',
    RS: 'RS', 区间回落: 'RS',
    TZ: 'TZ', 潜在顶部: 'TZ',
    BZ: 'BZ', 潜在底部: 'BZ',
  };
  return aliases[normalized] || null;
}

function replaySwingCoreField(title) {
  const normalized = normalizeReplayDataWindowTitle(title);
  if (normalized === '背离线') return 'DIVERGENCE_LINE';
  if (normalized === '超买区域') return 'OVERBOUGHT_ZONE';
  if (normalized === '超卖区域') return 'OVERSOLD_ZONE';
  return null;
}

function replayCoreFieldValidationError(study) {
  const name = String(study?.name || '');
  const fields = study?.core_fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return 'raw_study_values is missing core_fields';
  }
  const needsUsableValue = key => {
    const field = fields[key];
    return field && field.value_present === true && isUsableReplayCoreValue(field.value);
  };
  const hasSignalManifest = key => {
    const field = fields[key];
    if (!field || typeof field.value_present !== 'boolean' || field.value_invalid === true) return false;
    return field.value_present !== true || isUsableReplayDataWindowValue(field.value);
  };
  if (name.includes('趋势过滤器')) {
    for (const key of TREND_REQUIRED_EMA_FIELDS) {
      if (!needsUsableValue(key)) return `Trend0822 core ${key} is missing or invalid`;
    }
    for (const key of TREND_REQUIRED_SIGNAL_FIELDS) {
      // PlotList is authoritative for these shape signals. Their Data Window
      // rows can correctly be ∅/null while an inactive signal is rendered.
      if (!hasSignalManifest(key)) return `Trend0822 signal ${key} is missing or invalid`;
    }
    return null;
  }
  if (name.includes('波段过滤器')) {
    for (const key of SWING_REQUIRED_FIELDS) {
      if (!needsUsableValue(key)) return `Swing0822 core ${key} is missing or invalid`;
    }
    return null;
  }
  if (isTrainer0906StudyName(name)) {
    for (const key of TREND_REQUIRED_EMA_FIELDS) {
      if (!needsUsableValue(key)) return `Trainer0906 core ${key} is missing or invalid`;
    }
    return null;
  }
  return 'raw_study_values includes an unknown study core schema';
}

function replayShapeCheckpointMatches(record, seenShapeKeys, shapeStateInitialized) {
  if (!record || typeof record.shape_state_initialized_after !== 'boolean') return false;
  const recordSeenShapeKeys = Array.isArray(record.seen_shape_keys_after)
    ? new Set(record.seen_shape_keys_after)
    : new Set();
  const topSeenShapeKeys = new Set(seenShapeKeys);
  return record.shape_state_initialized_after === shapeStateInitialized
    && recordSeenShapeKeys.size === topSeenShapeKeys.size
    && [...recordSeenShapeKeys].every(key => topSeenShapeKeys.has(key));
}

function replayShapeCheckpointFromRecord(record) {
  return {
    seen_shape_keys_after: Array.isArray(record?.seen_shape_keys_after)
      ? [...new Set(record.seen_shape_keys_after.filter(value => typeof value === 'string'))]
      : [],
    shape_state_initialized_after: record?.shape_state_initialized_after === true,
  };
}

function replayLabelCheckpointMatches(record, seenLabelKeys) {
  if (!record || record.label_identity_version !== REPLAY_LABEL_IDENTITY_VERSION
      || !Array.isArray(record.seen_label_keys_after)) return false;
  const recordSeenLabelKeys = new Set(record.seen_label_keys_after);
  const topSeenLabelKeys = new Set(seenLabelKeys);
  return recordSeenLabelKeys.size === topSeenLabelKeys.size
    && [...recordSeenLabelKeys].every(key => topSeenLabelKeys.has(key));
}

function replayLabelCheckpointFromRecord(record) {
  return Array.isArray(record?.seen_label_keys_after)
    ? [...new Set(record.seen_label_keys_after.filter(isPersistentReplayLabelKey))]
    : [];
}

function recordValidationError(record) {
  if (!record || typeof record !== 'object') return 'record is not an object';
  if (record.schema_version !== REPLAY_CAPTURE_SCHEMA_VERSION
      || record.label_identity_version !== REPLAY_LABEL_IDENTITY_VERSION
      || record.feature_phase !== 'post_target_final'
      || record.ohlcv_phase !== 'post_target_final') {
    return 'record does not declare the strict post-target-final v4 label-epoch schema';
  }
  if (!record.active_bar || !record.confirmed_bar) return 'record is missing active_bar or confirmed_bar';
  if (!record.pre_step_active_bar
      || !sameReplayTime(record.pre_step_active_bar.time, record.observed_active_open_time)) {
    return 'record is missing a same-time pre_step_active_bar preview';
  }
  if (!sameReplayTime(record.observed_active_open_time, record.active_bar.time)) {
    return 'observed_active_open_time does not match active_bar.time';
  }
  if (!sameReplayTime(record.observed_active_open_time, record.confirmed_closed_open_time)
      || !sameReplayTime(record.confirmed_closed_open_time, record.confirmed_bar.time)) {
    return 'pre-step active bar was not confirmed as the post-step closed bar';
  }
  if (!sameReplayBar(record.active_bar, record.confirmed_bar)) {
    return 'post-step closed OHLCV target aliases differ';
  }
  if (!sameReplayTime(record.target_open_time, record.observed_active_open_time)
      || !sameReplayBar(record.target_bar, record.confirmed_bar)) {
    return 'record canonical target bar does not match the finalized closed bar';
  }
  if (!sameReplayTime(record.availability_open_time, record.next_active_open_time)) {
    return 'record availability time does not match the post-step next active bar';
  }
  if (!replayTimeGreaterThan(record.next_active_open_time, record.observed_active_open_time)) {
    return 'post-step next active bar time is not numerically later than the observed bar';
  }
  if (record.step_count !== 1) return 'record must contain exactly one replay step';
  if (!Number.isInteger(record.post_target_stable_polls)
      || record.post_target_stable_polls < 2
      || record.post_step_closed_bar_stable_polls !== record.post_target_stable_polls
      || typeof record.post_target_quiet_ms !== 'number'
      || !Number.isFinite(record.post_target_quiet_ms)
      || record.post_target_quiet_ms < 0) {
    return 'record is missing stable finalized target-row evidence';
  }
  if (record.capture_phase !== 'pre_step_preview_confirmed_post_step_final'
      || record.study_observation_phase !== 'post_target_final') {
    return 'record does not declare a post-step finalized study observation phase';
  }
  if (record.raw_study_values?.observation_phase !== 'post_target_final'
      || !sameReplayTime(record.raw_study_values?.observation_open_time, record.observed_active_open_time)
      || !sameReplayTime(record.raw_study_values?.target_open_time, record.target_open_time)
      || record.raw_study_values?.source !== 'plot_list_closed_row'
      || record.shape_values?.observation_phase !== 'post_target_final'
      || !sameReplayTime(record.shape_values?.observation_open_time, record.observed_active_open_time)) {
    return 'record study values are not stamped as the finalized closed-row observation';
  }
  if (!sameReplayTime(record.shape_values?.target_open_time, record.target_open_time)
      || record.shape_values?.source !== 'plot_list_closed_row') {
    return 'record shape values are not stamped as target PlotList row evidence';
  }

  const valueStudies = record.raw_study_values?.studies;
  if (!Array.isArray(valueStudies)) return 'record is missing raw_study_values.studies';
  let hasTrend0822 = false;
  let hasSwing0822 = false;
  for (const study of valueStudies) {
    if (!study || (!is0822ResearchStudyName(study.name) && !isTrainer0906StudyName(study.name))) {
      return 'raw_study_values includes a study outside visible 0822 targets or trainer0906';
    }
    const studyName = String(study.name);
    if (studyName.indexOf('趋势过滤器') !== -1) hasTrend0822 = true;
    if (studyName.indexOf('波段过滤器') !== -1) hasSwing0822 = true;
    if (study.study_value_source !== 'plot_list_closed_row'
        || study.target_row_read_ok !== true
        || !sameReplayTime(study.observed_open_time, record.target_open_time)
        || !sameReplayTime(study.row_time, record.target_open_time)
        || study.data_window_read_ok !== true || study.data_window_core_ok !== true
        || !study.values || typeof study.values !== 'object'
        || Array.isArray(study.values) || Object.keys(study.values).length === 0) {
      return 'raw_study_values contains an unavailable or empty Data Window study';
    }
    for (const value of Object.values(study.values)) {
      if (!isUsableReplayDataWindowValue(value)) {
        return 'raw_study_values contains an invalid Data Window value';
      }
    }
    const coreError = replayCoreFieldValidationError(study);
    if (coreError) return coreError;
  }
  if (!hasTrend0822 || !hasSwing0822) {
    return 'raw_study_values must include non-empty visible Trend0822 and Swing0822 Data Window studies';
  }

  const shapeValues = record.shape_values;
  if (!shapeValues || shapeValues.success !== true || !Array.isArray(shapeValues.studies)
      || shapeValues.studies.length === 0) {
    return 'record is missing shape_values.studies';
  }
  for (const study of shapeValues.studies) {
    const name = String(study?.study_name || study?.source || '');
    if (!study || !is0822ResearchStudyName(name) || name.indexOf('趋势过滤器') === -1
        || study.available !== true || !sameReplayTime(study.active_open_time, record.observed_active_open_time)
        || !sameReplayTime(study.row_time, record.observed_active_open_time)
        || study.study_value_source !== 'plot_list_closed_row' || study.target_row_read_ok !== true
        || !Array.isArray(study.shape_fields) || study.shape_fields.length === 0) {
      return 'shape_values contains an invalid active Trend PlotList row';
    }
    for (const field of study.shape_fields) {
      if (!field || !field.plot_id || field.value_present !== true || field.value_invalid === true
          || (field.value !== null && !isUsableReplayDataWindowValue(field.value))) {
        return 'shape_values contains a malformed PlotList shape field';
      }
    }
  }
  const plotshapeSignals = record.plotshape_signals;
  if (!Array.isArray(plotshapeSignals)) return 'record is missing plotshape_signals';
  const seenShapeKeys = record.seen_shape_keys_after;
  if (!Array.isArray(seenShapeKeys)) return 'record is missing seen_shape_keys_after';
  if (typeof record.shape_state_initialized_after !== 'boolean') {
    return 'record is missing shape_state_initialized_after';
  }
  if (record.plotshape_scan_phase !== 'post_target_final') {
    return 'record plotshape scan was not captured after finalization';
  }
  if (!sameReplayTime(
    record.plotshape_scan_observed_active_open_time,
    record.observed_active_open_time
  )) {
    return 'record plotshape scan finalized time differs from the closed replay bar';
  }
  if (!sameReplayTime(
    record.plotshape_scan_first_visible_open_time,
    record.next_active_open_time
  )) return 'record plotshape scan visibility time differs from the next active bar';
  const seenShapeSet = new Set(seenShapeKeys);
  for (const signal of plotshapeSignals) {
    if (!signal || !signal.identity || !signal.plot_id || !signal.code || signal.text === undefined
        || !sameReplayTime(signal.first_seen_at, record.next_active_open_time)
        || !sameReplayTime(signal.first_seen_at_open_time, record.next_active_open_time)
        || !sameReplayTime(signal.target_open_time, record.target_open_time)
        || !sameReplayTime(signal.availability_open_time, record.availability_open_time)
        || !sameReplayTime(signal.finalized_open_time, record.observed_active_open_time)
        || replayTimeGreaterThan(signal.signal_bar_time, record.observed_active_open_time)
        || !seenShapeSet.has(signal.identity)) {
      return 'plotshape_signals contains invalid first-seen evidence';
    }
  }

  const seenLabelKeys = record.seen_label_keys_after;
  if (!Array.isArray(seenLabelKeys) || seenLabelKeys.some(key => !isPersistentReplayLabelKey(key))) {
    return 'record is missing v4 physical-epoch seen_label_keys_after';
  }
  const seenLabelSet = new Set(seenLabelKeys);

  const studies = record.raw_pine_labels?.studies;
  if (!Array.isArray(studies)) return 'record is missing raw_pine_labels.studies';
  const activeLabelLogicalIndex = record.raw_pine_labels?.active_logical_index;
  const labelObservationOpenTime = record.label_observation_open_time;
  if (!sameReplayTime(labelObservationOpenTime, record.next_active_open_time)) {
    return 'record label observation is not stamped with the next active bar';
  }
  if (record.raw_pine_labels?.label_identity_version !== REPLAY_LABEL_IDENTITY_VERSION
      || record.raw_pine_labels?.observation_phase !== 'post_availability_next_active'
      || !sameReplayTime(record.raw_pine_labels?.observation_open_time, labelObservationOpenTime)
      || !sameReplayTime(record.raw_pine_labels?.target_open_time, record.target_open_time)) {
    return 'record Pine labels are not stamped as next-active availability evidence';
  }
  const labelStudyNames = {};
  for (const study of studies) {
    if (!study || !Array.isArray(study.labels)) return 'raw_pine_labels study is malformed';
    if (!is0822ResearchStudyName(study.name)) return 'raw_pine_labels includes a non-0822 study';
    if (study.label_read_ok !== true) return 'raw_pine_labels contains an unavailable label collection';
    const labelStudyName = String(study.name);
    const isTrendStudy = labelStudyName.includes('趋势过滤器');
    const isSwingStudy = labelStudyName.includes('波段过滤器');
    labelStudyNames[labelStudyName] = (labelStudyNames[labelStudyName] || 0) + 1;
    if (study.labels.length === 0 && isTrendStudy
        && (study.selection !== 'none' || study.label_read_reason !== 'trend_labels_optional_unavailable')) {
      return 'Trend0822 empty Pine labels must declare the optional-unavailable reason';
    }
    if (study.labels.length > 0 && study.selection !== 'current_x' && study.selection !== 'max_x') {
      return 'non-empty label study selection must be current_x or max_x';
    }
    let swingHasNumericLabel = false;
    for (const label of study.labels) {
      if (!label || !label.source_label_identity) return 'raw Pine label is missing audit source_label_identity';
      if (!sameReplayTime(label.observed_at_open_time, labelObservationOpenTime)) {
        return 'label observation time differs from its first-visible replay bar';
      }
      if (label.observed_at !== undefined
          && !sameReplayTime(label.observed_at, labelObservationOpenTime)) {
        return 'label observed_at differs from its first-visible replay bar';
      }
      if (label.selection === 'current_x'
          && !replayLabelXMatchesActive(
            label.x,
            labelObservationOpenTime,
            activeLabelLogicalIndex
          )) {
        return 'current_x label does not belong to the active replay bar';
      }
      if (label.label_coordinate_comparable !== true
          || (label.label_coordinate_kind !== 'time' && label.label_coordinate_kind !== 'logical')
          || !Number.isFinite(label.label_coordinate_value)
          || !Number.isFinite(label.label_coordinate_active)
          || label.label_coordinate_value > label.label_coordinate_active) {
        return 'selected label lacks a comparable non-future coordinate relation';
      }
      if (label.selection !== 'current_x' && label.selection !== 'max_x') {
        return 'label selection must be current_x or max_x';
      }
      if (label.selection !== study.selection) return 'label selection differs from its study selection';
      const numericText = Number(label.text);
      if ((typeof label.price === 'number' && Number.isFinite(label.price))
          || (label.text !== '' && Number.isFinite(numericText))) {
        swingHasNumericLabel = true;
      }
    }
    if (isSwingStudy
        && (study.label_collection_available !== true || !swingHasNumericLabel)) {
      return 'Swing0822 requires a readable label collection with a selected numeric label';
    }
  }
  const targetStudyNames = {};
  for (const study of valueStudies) {
    if (!is0822ResearchStudyName(study.name)) continue;
    const targetStudyName = String(study.name);
    targetStudyNames[targetStudyName] = (targetStudyNames[targetStudyName] || 0) + 1;
  }
  const targetNames = Object.keys(targetStudyNames);
  if (targetNames.length !== Object.keys(labelStudyNames).length
      || targetNames.some(name => labelStudyNames[name] !== targetStudyNames[name])) {
    return 'raw_pine_labels study manifest does not match visible 0822 Data Window studies';
  }
  const newlyVisible = record.newly_visible_labels;
  if (!Array.isArray(newlyVisible)) return 'record is missing newly_visible_labels';
  for (const label of newlyVisible) {
    if (!label || label.label_identity_version !== REPLAY_LABEL_IDENTITY_VERSION
        || !isPersistentReplayLabelKey(label.label_identity)
        || !label.source_label_identity || typeof label.source_discriminator !== 'string'
        || label.source_discriminator.length === 0) {
      return 'newly visible label is missing v4 physical-epoch identity provenance';
    }
    if (!is0822ResearchStudyName(label.study_name)) return 'newly visible label belongs to a non-0822 study';
    if (!sameReplayTime(label.observed_at_open_time, labelObservationOpenTime)) {
      return 'newly visible label is not stamped with its first-visible bar';
    }
    if (label.observed_at !== undefined
        && !sameReplayTime(label.observed_at, labelObservationOpenTime)) {
      return 'newly visible label observed_at is not its first-visible bar';
    }
    if (!seenLabelSet.has(label.label_identity)) {
      return 'newly visible label is absent from the label checkpoint';
    }
    if (!sameReplayTime(label.target_open_time, record.target_open_time)
        || !sameReplayTime(label.availability_open_time, record.availability_open_time)
        || label.label_coordinate_comparable !== true
        || (label.label_coordinate_kind !== 'time' && label.label_coordinate_kind !== 'logical')
        || !Number.isFinite(label.label_coordinate_value)
        || !Number.isFinite(label.label_coordinate_active)
        || label.label_coordinate_value > label.label_coordinate_active
        || !Number.isInteger(label.label_physical_epoch)
        || !sameReplayTime(label.signal_bar_time, label.label_physical_epoch)
        || label.signal_time_mapping_verified !== true
        || typeof label.signal_time_mapping_source !== 'string'
        || label.signal_time_mapping_source.length === 0
        || !Number.isInteger(label.signal_time_mapping_logical_index)
        || !Number.isInteger(label.target_logical_index)
        || !Number.isInteger(label.availability_logical_index)
        || (!Number.isFinite(label.timeframe_seconds) && label.timeframe_seconds !== null)
        || typeof label.target_aligned !== 'boolean'
        || typeof label.delayed !== 'boolean'
        || typeof label.strategy_eligible !== 'boolean') {
      return 'newly visible label lacks valid Node coordinate-alignment evidence';
    }
    if (label.target_aligned === true
        && (label.label_coordinate_value !== label.label_coordinate_active
          || label.delayed !== false || label.strategy_eligible !== true
          || !sameReplayTime(label.signal_bar_time, record.target_open_time)
          || !sameReplayTime(label.label_physical_epoch, record.target_open_time))) {
      return 'target-aligned label does not prove exact target-bar availability';
    }
    if (label.target_aligned === false
        && (label.label_coordinate_value >= label.label_coordinate_active
          || label.delayed !== true || label.strategy_eligible !== false
          || !replayTimeGreaterThan(record.target_open_time, label.label_physical_epoch))) {
      return 'historical label was not marked delayed non-strategy evidence';
    }
  }
  return null;
}

/**
 * Defensive validation at the Node boundary.  The page-side loop is the
 * source of truth, but an unexpected TradingView object shape must not make
 * it into a historical dataset as an apparently confirmed observation.
 */
export function validateReplayCaptureChunkResult(raw, requestedSteps) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('replay_capture_chunk returned no structured result');
  }
  const requested = validateCaptureChunkBars(requestedSteps);
  if (raw.schema_version !== REPLAY_CAPTURE_SCHEMA_VERSION
      || raw.label_identity_version !== REPLAY_LABEL_IDENTITY_VERSION
      || raw.feature_phase !== 'post_target_final'
      || raw.ohlcv_phase !== 'post_target_final') {
    return {
      success: true,
      schema_version: REPLAY_CAPTURE_SCHEMA_VERSION,
      label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
      feature_phase: 'post_target_final',
      ohlcv_phase: 'post_target_final',
      complete: false,
      partial: false,
      records: [],
      requested_steps: requested,
      completed_steps: 0,
      steps_invoked: Number(raw.steps_invoked) || 0,
      seen_shape_keys_after: [],
      shape_state_initialized_after: false,
      seen_label_keys_after: [],
      failure: {
        code: 'invalid_chunk_response',
        stage: 'node_validation',
        sequence: 1,
        message: 'page response does not declare the strict post-target-final v4 label-epoch schema',
      },
    };
  }
  const rawRecords = Array.isArray(raw.records) ? raw.records : [];
  const seenShapeKeysAfter = Array.isArray(raw.seen_shape_keys_after)
    && raw.seen_shape_keys_after.every(value => typeof value === 'string')
    ? [...new Set(raw.seen_shape_keys_after)]
    : null;
  const seenLabelKeysAfter = Array.isArray(raw.seen_label_keys_after)
    && raw.seen_label_keys_after.every(isPersistentReplayLabelKey)
    ? [...new Set(raw.seen_label_keys_after)]
    : null;
  const shapeStateInitializedAfter = raw.shape_state_initialized_after;
  if (typeof shapeStateInitializedAfter !== 'boolean'
      || seenShapeKeysAfter === null || seenLabelKeysAfter === null) {
    return {
      success: true,
      schema_version: REPLAY_CAPTURE_SCHEMA_VERSION,
      label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
      feature_phase: 'post_target_final',
      ohlcv_phase: 'post_target_final',
      complete: false,
      partial: false,
      records: [],
      requested_steps: requested,
      completed_steps: 0,
      steps_invoked: Number(raw.steps_invoked) || 0,
      seen_shape_keys_after: seenShapeKeysAfter || [],
      shape_state_initialized_after: false,
      seen_label_keys_after: seenLabelKeysAfter || [],
      failure: {
        code: 'invalid_chunk_response',
        stage: 'node_validation',
        sequence: 1,
        message: typeof shapeStateInitializedAfter !== 'boolean'
          ? 'page response is missing boolean shape_state_initialized_after'
          : 'page response is missing a string-only replay checkpoint array',
      },
    };
  }
  const records = [];
  for (let index = 0; index < rawRecords.length; index += 1) {
    const error = recordValidationError(rawRecords[index]);
    if (error) {
      const lastConfirmed = records.length > 0 ? records[records.length - 1] : null;
      const shapeCheckpointMatches = !lastConfirmed || replayShapeCheckpointMatches(
        lastConfirmed, seenShapeKeysAfter, shapeStateInitializedAfter
      );
      const labelCheckpointMatches = !lastConfirmed || replayLabelCheckpointMatches(
        lastConfirmed, seenLabelKeysAfter
      );
      const checkpointMatches = shapeCheckpointMatches && labelCheckpointMatches;
      const confirmedCheckpoint = lastConfirmed
        ? {
          ...replayShapeCheckpointFromRecord(lastConfirmed),
          seen_label_keys_after: replayLabelCheckpointFromRecord(lastConfirmed),
        }
        : {
          seen_shape_keys_after: seenShapeKeysAfter,
          shape_state_initialized_after: shapeStateInitializedAfter,
          seen_label_keys_after: seenLabelKeysAfter,
        };
      return {
        success: true,
        schema_version: REPLAY_CAPTURE_SCHEMA_VERSION,
      label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
        feature_phase: 'post_target_final',
        ohlcv_phase: 'post_target_final',
        complete: false,
        partial: records.length > 0,
        records,
        requested_steps: requested,
        completed_steps: records.length,
        steps_invoked: Number(raw.steps_invoked) || records.length,
        seen_shape_keys_after: checkpointMatches ? seenShapeKeysAfter : confirmedCheckpoint.seen_shape_keys_after,
        shape_state_initialized_after: checkpointMatches
          ? shapeStateInitializedAfter
          : confirmedCheckpoint.shape_state_initialized_after,
        seen_label_keys_after: checkpointMatches
          ? seenLabelKeysAfter
          : confirmedCheckpoint.seen_label_keys_after,
        failure: {
          code: 'invalid_chunk_response',
          stage: 'node_validation',
          sequence: index + 1,
          message: checkpointMatches
            ? error
            : 'top-level replay checkpoint does not match the last confirmed record',
        },
      };
    }
    records.push(rawRecords[index]);
  }

  const completed = records.length;
  if (completed > 0) {
    const lastRecord = records[completed - 1];
    const shapeCheckpointMatches = replayShapeCheckpointMatches(
      lastRecord, seenShapeKeysAfter, shapeStateInitializedAfter
    );
    const labelCheckpointMatches = replayLabelCheckpointMatches(lastRecord, seenLabelKeysAfter);
    if (!shapeCheckpointMatches || !labelCheckpointMatches) {
      const recordCheckpoint = {
        ...replayShapeCheckpointFromRecord(lastRecord),
        seen_label_keys_after: replayLabelCheckpointFromRecord(lastRecord),
      };
      return {
        success: true,
        schema_version: REPLAY_CAPTURE_SCHEMA_VERSION,
      label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
        feature_phase: 'post_target_final',
        ohlcv_phase: 'post_target_final',
        complete: false,
        partial: completed > 0,
        records,
        requested_steps: requested,
        completed_steps: completed,
        steps_invoked: Number(raw.steps_invoked) || completed,
        seen_shape_keys_after: recordCheckpoint.seen_shape_keys_after,
        shape_state_initialized_after: recordCheckpoint.shape_state_initialized_after,
        seen_label_keys_after: recordCheckpoint.seen_label_keys_after,
        failure: {
          code: 'invalid_chunk_response',
          stage: 'node_validation',
          sequence: completed,
          message: 'top-level replay checkpoint does not match the last confirmed record',
        },
      };
    }
  }
  const sourceFailure = raw.failure && typeof raw.failure === 'object' ? raw.failure : null;
  if (completed > requested) {
    const returnedRecords = records.slice(0, requested);
    const returnedCheckpoint = {
      ...replayShapeCheckpointFromRecord(returnedRecords[returnedRecords.length - 1]),
      seen_label_keys_after: replayLabelCheckpointFromRecord(returnedRecords[returnedRecords.length - 1]),
    };
    return {
      success: true,
      schema_version: REPLAY_CAPTURE_SCHEMA_VERSION,
      label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
      feature_phase: 'post_target_final',
      ohlcv_phase: 'post_target_final',
      complete: false,
      partial: true,
      records: returnedRecords,
      requested_steps: requested,
      completed_steps: requested,
      steps_invoked: Number(raw.steps_invoked) || completed,
      seen_shape_keys_after: returnedCheckpoint.seen_shape_keys_after,
      shape_state_initialized_after: returnedCheckpoint.shape_state_initialized_after,
      seen_label_keys_after: returnedCheckpoint.seen_label_keys_after,
      failure: {
        code: 'invalid_chunk_response',
        stage: 'node_validation',
        sequence: requested + 1,
        message: 'page returned more confirmed records than requested',
      },
    };
  }

  if (sourceFailure || completed !== requested) {
    return {
      success: true,
      schema_version: REPLAY_CAPTURE_SCHEMA_VERSION,
      label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
      feature_phase: 'post_target_final',
      ohlcv_phase: 'post_target_final',
      complete: false,
      partial: completed > 0,
      records,
      requested_steps: requested,
      completed_steps: completed,
      steps_invoked: Number(raw.steps_invoked) || completed,
      seen_shape_keys_after: seenShapeKeysAfter,
      shape_state_initialized_after: shapeStateInitializedAfter,
      seen_label_keys_after: seenLabelKeysAfter,
      failure: sourceFailure || {
        code: 'incomplete_chunk_response',
        stage: 'page_capture',
        sequence: completed + 1,
        message: 'page returned fewer records than requested without failure metadata',
      },
    };
  }

  return {
    success: true,
    schema_version: REPLAY_CAPTURE_SCHEMA_VERSION,
      label_identity_version: REPLAY_LABEL_IDENTITY_VERSION,
    feature_phase: 'post_target_final',
    ohlcv_phase: 'post_target_final',
    complete: true,
    partial: false,
    records,
    requested_steps: requested,
    completed_steps: completed,
    steps_invoked: Number(raw.steps_invoked) || completed,
    seen_shape_keys_after: seenShapeKeysAfter,
    shape_state_initialized_after: shapeStateInitializedAfter,
    seen_label_keys_after: seenLabelKeysAfter,
    failure: null,
  };
}

/**
 * Build one Runtime.evaluate(..., awaitPromise=true) operation.  Keeping the
 * pre-observation, manual doStep(), and post-confirmation inside one page
 * evaluation removes MCP/HTTP round trips without using Replay autoplay.
 */
export function buildReplayCaptureChunkExpression({
  replayApiPath,
  bars,
  pollAttempts,
  pollIntervalMs,
  settleMs = DEFAULT_CAPTURE_SETTLE_MS,
  activeReadyTimeoutMs = DEFAULT_ACTIVE_READY_TIMEOUT_MS,
  activeReadyPollIntervalMs = DEFAULT_ACTIVE_READY_POLL_INTERVAL_MS,
  activeReadyStablePolls = DEFAULT_ACTIVE_READY_STABLE_POLLS,
  activeReadyStudyStablePolls = DEFAULT_ACTIVE_READY_STUDY_STABLE_POLLS,
  postStepClosedBarStablePolls = DEFAULT_POST_STEP_CLOSED_BAR_STABLE_POLLS,
  knownLabelKeys = [],
  knownShapeKeys = [],
  shapeStateInitialized = false,
}) {
  const known = validateReplayLabelCheckpointKeys(knownLabelKeys, 'known_label_keys');
  const knownShapes = validateReplayCaptureCheckpointKeys(knownShapeKeys, 'known_shape_keys');
  const initialShapeState = validateShapeStateInitialized(shapeStateInitialized);
  if (!initialShapeState && knownShapes.length > 0) {
    throw new Error('known_shape_keys must be empty when shape_state_initialized is false');
  }
  const selector = selectCurrentOrMaxXReplayLabels.toString();
  const identity = stableReplayLabelIdentity.toString();
  const is0822 = is0822ResearchStudyName.toString();
  const isTrainer = isTrainer0906StudyName.toString();
  const resolutionToSeconds = replayResolutionToSeconds.toString();

  return `
    (async function() {
      var r = ${replayApiPath};
      var requestedSteps = ${bars};
      var maxPollAttempts = ${pollAttempts};
      var pollIntervalMs = ${pollIntervalMs};
      var settleMs = ${settleMs};
      var activeReadyTimeoutMs = ${activeReadyTimeoutMs};
      var activeReadyPollIntervalMs = ${activeReadyPollIntervalMs};
      var activeReadyStablePolls = ${activeReadyStablePolls};
      var activeReadyStudyStablePolls = ${activeReadyStudyStablePolls};
      var postStepClosedBarStablePolls = ${postStepClosedBarStablePolls};
      var replayCaptureSchemaVersion = ${JSON.stringify(REPLAY_CAPTURE_SCHEMA_VERSION)};
      var replayLabelIdentityVersion = ${JSON.stringify(REPLAY_LABEL_IDENTITY_VERSION)};
      var knownLabelKeys = ${JSON.stringify(known)};
      var knownShapeKeys = ${JSON.stringify(knownShapes)};
      var shapeStateInitialized = ${JSON.stringify(initialShapeState)};

      ${identity}
      ${selector}
      ${is0822}
      ${isTrainer}
      ${resolutionToSeconds}

      function unwrap(value) {
        return (value && typeof value === 'object' && typeof value.value === 'function') ? value.value() : value;
      }
      function sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      }
      function safeStudyName(source) {
        try {
          var meta = source.metaInfo();
          return meta.description || meta.shortDescription || '';
        } catch (e) {
          return '';
        }
      }
      function sourceIsVisible(source) {
        try { return typeof source.isVisible !== 'function' || source.isVisible(); }
        catch (e) { return true; }
      }
      function readRecentBars() {
        try {
          var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
          if (!bars || typeof bars.lastIndex !== 'function') return [];
          var end = bars.lastIndex();
          var start = Math.max(bars.firstIndex(), end - 2);
          var result = [];
          for (var index = start; index <= end; index += 1) {
            var value = bars.valueAt(index);
            if (value) result.push({ time: value[0], open: value[1], high: value[2], low: value[3], close: value[4], volume: value[5] || 0 });
          }
          return result;
        } catch (e) {
          return [];
        }
      }
      function activeLogicalIndexForTime(activeOpenTime) {
        try {
          var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
          if (!bars) return null;
          if (typeof bars.searchByTime === 'function') {
            var found = bars.searchByTime(activeOpenTime);
            if (found && typeof found.index === 'number' && Number.isFinite(found.index)) return found.index;
          }
          // The active row is normally the last row. This fallback avoids a
          // speculative numeric index loop against PlotList's huge firstIndex.
          if (typeof bars.lastIndex === 'function' && typeof bars.valueAt === 'function') {
            var lastIndex = bars.lastIndex();
            var lastValue = bars.valueAt(lastIndex);
            if (lastValue && sameTime(lastValue[0], activeOpenTime) && Number.isFinite(lastIndex)) return lastIndex;
          }
        } catch (e) {}
        return null;
      }
      function isTrend0822StudyName(name) {
        return is0822ResearchStudyName(name) && String(name || '').indexOf('趋势过滤器') !== -1;
      }
      function shapeSignalCode(style) {
        var candidate = String((style && (style.title || style.text)) || '').trim();
        var codes = {
          '顺势多': 'TL', TL: 'TL',
          '顺势空': 'TS', TS: 'TS',
          '回调': 'PB', PB: 'PB',
          '反弹': 'RB', RB: 'RB',
          '区间反弹': 'RL', RL: 'RL',
          '区间回落': 'RS', RS: 'RS',
          '潜在顶部': 'TZ', TZ: 'TZ',
          '潜在底部': 'BZ', BZ: 'BZ',
        };
        return codes[candidate] || null;
      }
      function trendShapeDefinitions(meta) {
          var plots = meta && Array.isArray(meta.plots) ? meta.plots : [];
          var styles = meta && meta.styles && typeof meta.styles === 'object' ? meta.styles : {};
          var definitions = [];
          for (var plotIndex = 0; plotIndex < plots.length; plotIndex += 1) {
            var plot = plots[plotIndex];
            if (!plot) continue;
            var style = styles[plot.id] || {};
            var code = shapeSignalCode(style);
          // Trend0822 may contain unrelated shape plots. Only the mapped
          // strategy signals below are part of the replay evidence contract.
          if (!code) continue;
          definitions.push({
            plot_id: String(plot.id || ''),
            row_index: plotIndex + 1,
            code: code,
            title: style.title === undefined || style.title === null ? '' : String(style.title),
            text: style.text === undefined || style.text === null ? '' : String(style.text),
          });
        }
        return definitions;
      }
      function nonzeroShapeValue(value) {
        return (typeof value === 'number' ? Number.isFinite(value)
          : (typeof value === 'string' || typeof value === 'boolean'))
          && value !== null && value !== false && value !== ''
          && !(typeof value === 'number' && value === 0)
          && !(typeof value === 'string' && (value === '0' || value === '0.0'));
      }
      function plotshapeSignalIdentity(studyName, plotId, signalBarTime, value) {
        return String(studyName || '') + '::' + String(plotId || '') + '::'
          + String(signalBarTime === undefined || signalBarTime === null ? '' : signalBarTime)
          + '::' + canonicalStudyValue(value);
      }
      function plotshapeSemanticGroup(studyName, code, signalBarTime) {
        return String(studyName || '') + '::' + String(code || '') + '::'
          + String(signalBarTime === undefined || signalBarTime === null ? '' : signalBarTime);
      }
      // Read a trend plotshape row by the real active bar timestamp.  Plot
      // columns are derived from meta.plots, never from a hard-coded index.
      function readTrendShapeValue(source, name, activeOpenTime) {
        var base = {
          source: name,
          study_name: name,
          active_open_time: activeOpenTime,
          history_calculation_may_change: false,
          available: false,
          reason: null,
          row_index: null,
          row_time: null,
          shape_fields: [],
        };
        try {
          var meta = source.metaInfo();
          var definitions = trendShapeDefinitions(meta);
          base.history_calculation_may_change = !!(meta && meta.historyCalculationMayChange);
          if (definitions.length === 0) {
            base.reason = 'shape_plots_unavailable';
            return base;
          }
          var data = source._data;
          if (!data || typeof data.searchByTime !== 'function') {
            base.reason = 'plot_list_unavailable';
            return base;
          }
          var found = data.searchByTime(activeOpenTime);
          var row = found && found.value;
          if (!found || !Array.isArray(row) || !sameTime(row[0], activeOpenTime)) {
            base.reason = 'active_shape_row_unavailable';
            return base;
          }
          var fields = [];
          for (var definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
            var definition = definitions[definitionIndex];
            var hasValue = definition.row_index < row.length;
            fields.push({
              plot_id: definition.plot_id,
              row_index: definition.row_index,
              code: definition.code,
              title: definition.title,
              text: definition.text,
              value_present: hasValue,
              value: hasValue ? row[definition.row_index] : null,
              value_invalid: hasValue && !isSafeShapeRowValue(row[definition.row_index]),
            });
            if (!hasValue || !isSafeShapeRowValue(row[definition.row_index])) {
              base.reason = !hasValue ? 'active_shape_row_truncated' : 'active_shape_row_value_invalid';
              return base;
            }
          }
          base.available = true;
          base.row_index = found.index === undefined || found.index === null ? null : found.index;
          base.row_time = row[0];
          base.shape_fields = fields;
          return base;
        } catch (e) {
          base.reason = 'shape_row_read_error';
          return base;
        }
      }
      // Pine can revise historical shapes (historyCalculationMayChange=true).
      // This scan is pure and is invoked only after the target timestamp has
      // passed post-step finalization; seen state changes happen afterwards.
      function scanTrendPlotshapeSignals(source, name) {
        var result = { success: false, reason: null, history_calculation_may_change: false, signals: [] };
        try {
          var meta = source.metaInfo();
          var definitions = trendShapeDefinitions(meta);
          result.history_calculation_may_change = !!(meta && meta.historyCalculationMayChange);
          var data = source._data;
          if (definitions.length === 0 || !data || typeof data.each !== 'function') {
            result.reason = definitions.length === 0 ? 'shape_plots_unavailable' : 'plot_list_iteration_unavailable';
            return result;
          }
          var identities = new Set();
          data.each(function(index, row) {
            if (!Array.isArray(row) || row.length === 0 || row[0] === undefined || row[0] === null) return;
            var signalBarTime = row[0];
            var semanticGroups = new Set();
            for (var definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
              var definition = definitions[definitionIndex];
              var value = row[definition.row_index];
              if (!nonzeroShapeValue(value)) continue;
              // 0822 publishes a Chinese display plot and a short-code plot
              // for each semantic signal. They normally carry 1/0 respectively;
              // if both briefly carry a value, preserve the first meta-ordered
              // physical plot as provenance but emit a single semantic signal.
              var semanticGroup = plotshapeSemanticGroup(name, definition.code, signalBarTime);
              if (semanticGroups.has(semanticGroup)) continue;
              semanticGroups.add(semanticGroup);
              var identity = plotshapeSignalIdentity(name, definition.plot_id, signalBarTime, value);
              if (identities.has(identity)) continue;
              identities.add(identity);
              result.signals.push({
                identity: identity,
                study_name: name,
                source: name,
                plot_id: definition.plot_id,
                code: definition.code,
                text: definition.text || definition.title,
                title: definition.title,
                value: value,
                signal_bar_time: signalBarTime,
                history_calculation_may_change: result.history_calculation_may_change,
              });
            }
          });
          result.success = true;
          return result;
        } catch (e) {
          result.reason = 'shape_signal_scan_error';
          return result;
        }
      }
      function scanAvailablePlotshapeSignals() {
        var signals = [];
        var scanFailures = [];
        var trendStudyCount = 0;
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
            var source = sources[sourceIndex];
            if (!source || !source.metaInfo || !sourceIsVisible(source)) continue;
            var name = safeStudyName(source);
            if (!isTrend0822StudyName(name)) continue;
            trendStudyCount += 1;
            var scan = scanTrendPlotshapeSignals(source, name);
            if (scan.success) {
              signals = signals.concat(scan.signals);
            } else {
              scanFailures.push({ study_name: name, reason: scan.reason });
            }
          }
        } catch (e) {
          scanFailures.push({ study_name: null, reason: 'shape_signal_scan_error' });
        }
        if (trendStudyCount === 0) {
          scanFailures.push({ study_name: null, reason: 'trend_shape_source_unavailable' });
        }
        return {
          success: scanFailures.length === 0,
          study_count: trendStudyCount,
          scan_failures: scanFailures,
          signals: signals,
        };
      }
      function activeShapeValuesMatchScan(shapeValues, activeOpenTime, signals) {
        var activeScanned = new Set();
        var availableSignals = Array.isArray(signals) ? signals : [];
        for (var signalIndex = 0; signalIndex < availableSignals.length; signalIndex += 1) {
          var signal = availableSignals[signalIndex];
          // The full scan is intentionally allowed to contain older backpaint
          // rows and future rows. Only identities on this exact active row must
          // agree with the separately-read active PlotList values.
          if (signal && signal.identity && sameTime(signal.signal_bar_time, activeOpenTime)) {
            activeScanned.add(signal.identity);
          }
        }
        var missing = [];
        var activeValues = new Set();
        var studies = shapeValues && Array.isArray(shapeValues.studies) ? shapeValues.studies : [];
        for (var studyIndex = 0; studyIndex < studies.length; studyIndex += 1) {
          var study = studies[studyIndex];
          var studyName = study && (study.study_name || study.source);
          var fields = study && Array.isArray(study.shape_fields) ? study.shape_fields : [];
          var semanticGroups = new Set();
          for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
            var field = fields[fieldIndex];
            if (!field || !field.plot_id || !nonzeroShapeValue(field.value)) continue;
            var semanticGroup = plotshapeSemanticGroup(studyName, field.code, activeOpenTime);
            if (semanticGroups.has(semanticGroup)) continue;
            semanticGroups.add(semanticGroup);
            var identity = plotshapeSignalIdentity(studyName, field.plot_id, activeOpenTime, field.value);
            activeValues.add(identity);
            if (!activeScanned.has(identity)) {
              missing.push({
                study_name: studyName,
                plot_id: field.plot_id,
                value: field.value,
                identity: identity,
              });
            }
          }
        }
        var unexpected = [];
        activeScanned.forEach(function(identity) {
          if (!activeValues.has(identity)) unexpected.push(identity);
        });
        return {
          consistent: missing.length === 0 && unexpected.length === 0,
          missing_active_shape_identities: missing,
          unexpected_active_scan_identities: unexpected,
        };
      }
      function usableDataWindowValue(value) {
        if (typeof value === 'number') return Number.isFinite(value);
        return typeof value === 'string' || typeof value === 'boolean';
      }
      // PlotList rows are untyped private values. Permit a deliberate null
      // placeholder for an inactive plot, but never turn NaN, Infinity,
      // undefined, functions, symbols, or arbitrary objects into a stable
      // historical feature fingerprint.
      function isSafeShapeRowValue(value) {
        return value === null || usableDataWindowValue(value);
      }
      function usableCoreDataWindowValue(value) {
        return usableDataWindowValue(value)
          && (typeof value !== 'string' || value.trim() !== '');
      }
      var trendEmaFields = ['EMA1', 'EMA2', 'EMA3', 'EMA4'];
      var trendSignalFields = ['TL', 'TS', 'PB', 'RB', 'RL', 'RS', 'TZ', 'BZ'];
      var swingFields = ['DIVERGENCE_LINE', 'OVERBOUGHT_ZONE', 'OVERSOLD_ZONE'];
      function compactDataWindowTitle(title) {
        return String(title === undefined || title === null ? '' : title).replace(/[\s_－-]/g, '').toUpperCase();
      }
      function trendCoreField(title) {
        var normalized = compactDataWindowTitle(title);
        // PlotList titles in the live 0822 Trend study name the actual periods
        // rather than the legacy Data Window aliases. Derive by title, never
        // by a hard-coded row index. Check exact period aliases before the
        // legacy EMA2 prefix rule (EMA21 must not become EMA2).
        var emaPeriodAliases = {
          EMA21: 'EMA1',
          EMA55: 'EMA2',
          EMA100: 'EMA3',
          EMA200: 'EMA4',
        };
        if (emaPeriodAliases[normalized]) return emaPeriodAliases[normalized];
        for (var emaIndex = 0; emaIndex < trendEmaFields.length; emaIndex += 1) {
          var emaField = trendEmaFields[emaIndex];
          if (normalized === emaField || normalized.indexOf(emaField) === 0) return emaField;
        }
        var aliases = {
          TL: 'TL', 顺势多: 'TL',
          TS: 'TS', 顺势空: 'TS',
          PB: 'PB', 回调: 'PB',
          RB: 'RB', 反弹: 'RB',
          RL: 'RL', 区间反弹: 'RL',
          RS: 'RS', 区间回落: 'RS',
          TZ: 'TZ', 潜在顶部: 'TZ',
          BZ: 'BZ', 潜在底部: 'BZ',
        };
        if (aliases[normalized]) return aliases[normalized];
        var aliasNames = Object.keys(aliases);
        for (var aliasIndex = 0; aliasIndex < aliasNames.length; aliasIndex += 1) {
          var aliasName = aliasNames[aliasIndex];
          if (/^[A-Z]+$/.test(aliasName)) continue;
          if (normalized.indexOf(aliasName) !== -1) return aliases[aliasName];
        }
        return null;
      }
      function swingCoreField(title) {
        var normalized = compactDataWindowTitle(title);
        if (normalized.indexOf('背离线') !== -1) return 'DIVERGENCE_LINE';
        if (normalized.indexOf('超买区域') !== -1) return 'OVERBOUGHT_ZONE';
        if (normalized.indexOf('超卖区域') !== -1) return 'OVERSOLD_ZONE';
        return null;
      }
      function coreFieldForStudy(name, title) {
        if (isTrend0822StudyName(name) || isTrainer0906StudyName(name)) return trendCoreField(title);
        if (is0822ResearchStudyName(name) && String(name).indexOf('波段过滤器') !== -1) {
          return swingCoreField(title);
        }
        return null;
      }
      function coreFieldSnapshot(title, value, provenance) {
        var absent = value === undefined || value === null || value === '∅';
        var base = {
          title: String(title),
          value_present: !absent,
          value: absent ? null : value,
        };
        if (provenance && typeof provenance === 'object') {
          base.plot_id = provenance.plot_id === undefined || provenance.plot_id === null
            ? null : String(provenance.plot_id);
          base.row_index = Number.isInteger(provenance.row_index) ? provenance.row_index : null;
          base.mapping_source = provenance.mapping_source === undefined || provenance.mapping_source === null
            ? null : String(provenance.mapping_source);
        }
        if (absent) return base;
        if (!usableDataWindowValue(value)) {
          base.value_present = false;
          base.value = null;
          base.value_invalid = true;
          return base;
        }
        return base;
      }
      function setCoreField(fields, key, title, value, provenance) {
        if (!key) return;
        var next = coreFieldSnapshot(title, value, provenance);
        var current = fields[key];
        // A Chinese/code alias pair can both appear. Preserve the usable value
        // rather than allowing a later optional empty alias to erase it.
        if (!current || (!current.value_present && next.value_present)) fields[key] = next;
      }
      function dataWindowCoreFieldsOk(name, fields) {
        function hasUsableValue(key) {
          var field = fields[key];
          return !!(field && field.value_present === true && usableCoreDataWindowValue(field.value));
        }
        function hasSignalManifest(key) {
          var field = fields[key];
          if (!field || typeof field.value_present !== 'boolean' || field.value_invalid === true) return false;
          return field.value_present !== true || usableDataWindowValue(field.value);
        }
        if (isTrend0822StudyName(name)) {
          for (var emaIndex = 0; emaIndex < trendEmaFields.length; emaIndex += 1) {
            if (!hasUsableValue(trendEmaFields[emaIndex])) return false;
          }
          for (var signalIndex = 0; signalIndex < trendSignalFields.length; signalIndex += 1) {
            // Signal plots can be ∅ while inactive; their PlotList rows are
            // the authoritative value. Require the field manifest and reject
            // malformed values, but do not require every signal to be nonempty.
            if (!hasSignalManifest(trendSignalFields[signalIndex])) return false;
          }
          return true;
        }
        if (is0822ResearchStudyName(name) && String(name).indexOf('波段过滤器') !== -1) {
          for (var swingIndex = 0; swingIndex < swingFields.length; swingIndex += 1) {
            if (!hasUsableValue(swingFields[swingIndex])) return false;
          }
          return true;
        }
        if (isTrainer0906StudyName(name)) {
          for (var trainerEmaIndex = 0; trainerEmaIndex < trendEmaFields.length; trainerEmaIndex += 1) {
            if (!hasUsableValue(trendEmaFields[trainerEmaIndex])) return false;
          }
          return true;
        }
        return false;
      }
      function readStudySnapshot(activeOpenTime) {
        var valueStudies = [];
        var shapeStudies = [];
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
            var source = sources[sourceIndex];
            if (!source || !source.metaInfo || !sourceIsVisible(source)) continue;
            var name = safeStudyName(source);
            // Visibility is checked first. Trend0822 and Swing0822 are always
            // required; a visible 0906 trainer is optional compatibility data.
            if (!is0822ResearchStudyName(name) && !isTrainer0906StudyName(name)) continue;
            var values = {};
            var coreFields = {};
            var dataWindowReadOk = true;
            try {
              var dataWindow = source.dataWindowView();
              var items = dataWindow && dataWindow.items ? dataWindow.items() : null;
              if (items && typeof items.length === 'number') {
                for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
                  var item = items[itemIndex];
                  if (!item || item._title === undefined || item._title === null || item._title === '') {
                    dataWindowReadOk = false;
                    continue;
                  }
                  var coreKey = coreFieldForStudy(name, item._title);
                  setCoreField(coreFields, coreKey, item._title, item._value);
                  // Optional plots commonly report ∅/null while inactive. They
                  // are absent values, not a failed Data Window read.
                  if (item._value === undefined || item._value === null || item._value === '∅') continue;
                  if (!usableDataWindowValue(item._value)) {
                    dataWindowReadOk = false;
                    continue;
                  }
                  values[item._title] = item._value;
                }
              } else {
                dataWindowReadOk = false;
              }
            } catch (e) {
              dataWindowReadOk = false;
            }
            var dataWindowCoreOk = dataWindowReadOk && dataWindowCoreFieldsOk(name, coreFields);
            var studySnapshot = {
              name: name,
              data_window_read_ok: dataWindowReadOk,
              data_window_core_ok: dataWindowCoreOk,
              core_fields: coreFields,
              values: values,
            };
            // Trainer0906 is compatibility evidence only. An empty or delayed
            // visible trainer must not stop the required Trend0822 + Swing0822
            // causal gate; include it only when it is fully readable.
            if (!isTrainer0906StudyName(name)
                || (dataWindowReadOk && dataWindowCoreOk && Object.keys(values).length > 0)) {
              valueStudies.push(studySnapshot);
            }
            if (isTrend0822StudyName(name)) {
              var shapeValue = readTrendShapeValue(source, name, activeOpenTime);
              shapeStudies.push(shapeValue);
            }
          }
        } catch (e) {}
        return {
          raw_study_values: { success: true, study_count: valueStudies.length, studies: valueStudies },
          shape_values: {
            success: true,
            study_count: shapeStudies.length,
            studies: shapeStudies,
          },
        };
      }
      // Data Window is tied to the currently active preview bar. Once doStep()
      // advances, reading it would describe the next bar, not the bar that just
      // closed. For a causally valid close snapshot, read the target study's
      // historical PlotList row at the confirmed timestamp instead.
      function studyCorePlotDefinitions(meta, name) {
        var plots = meta && Array.isArray(meta.plots) ? meta.plots : [];
        var styles = meta && meta.styles && typeof meta.styles === 'object' ? meta.styles : {};
        var definitions = [];
        for (var plotIndex = 0; plotIndex < plots.length; plotIndex += 1) {
          var plot = plots[plotIndex];
          if (!plot) continue;
          // Colorers occupy a PlotList column, so retain their place in the
          // array when calculating a neighbouring line's row index. They are
          // not, however, an EMA value source themselves.
          if (isTrend0822StudyName(name)
              && String(plot.type === undefined || plot.type === null ? '' : plot.type).toLowerCase() === 'colorer') {
            continue;
          }
          var style = styles[plot.id] || {};
          var candidates = [style.title, style.text, plot.title, plot.id];
          var coreKey = null;
          var title = '';
          for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
            var candidate = candidates[candidateIndex];
            if (candidate === undefined || candidate === null || candidate === '') continue;
            var candidateCoreKey = coreFieldForStudy(name, candidate);
            if (candidateCoreKey) {
              coreKey = candidateCoreKey;
              title = String(candidate);
              break;
            }
          }
          if (!coreKey) continue;
          definitions.push({
            core_key: coreKey,
            title: title || coreKey,
            plot_id: String(plot.id || ''),
            row_index: plotIndex + 1,
            mapping_source: 'meta_title_alias',
          });
        }
        // Live Trend0822 has a stable physical EMA layout even when a browser
        // build omits or relabels style metadata. Keep title/alias discovery as
        // the preferred path, but fill any missing EMA key from this verified
        // PlotList layout. Fixed row indices deliberately include intervening
        // colorer columns: plot_0/r1, plot_2/r3, plot_4/r5, plot_6/r7.
        if (isTrend0822StudyName(name)) {
          var fixedTrendEmaDefinitions = [
            { core_key: 'EMA1', title: 'EMA21', plot_id: 'plot_0', row_index: 1 },
            { core_key: 'EMA2', title: 'EMA55', plot_id: 'plot_2', row_index: 3 },
            { core_key: 'EMA3', title: 'EMA100', plot_id: 'plot_4', row_index: 5 },
            { core_key: 'EMA4', title: 'EMA200', plot_id: 'plot_6', row_index: 7 },
          ];
          var plotIds = {};
          for (var knownPlotIndex = 0; knownPlotIndex < plots.length; knownPlotIndex += 1) {
            var knownPlot = plots[knownPlotIndex];
            if (knownPlot && knownPlot.id !== undefined && knownPlot.id !== null) {
              plotIds[String(knownPlot.id)] = true;
            }
          }
          for (var fixedIndex = 0; fixedIndex < fixedTrendEmaDefinitions.length; fixedIndex += 1) {
            var fixedDefinition = fixedTrendEmaDefinitions[fixedIndex];
            if (!plotIds[fixedDefinition.plot_id]) continue;
            var existingIndex = -1;
            var expectedDynamicIndex = -1;
            for (var existingDefinitionIndex = 0; existingDefinitionIndex < definitions.length; existingDefinitionIndex += 1) {
              var existingDefinition = definitions[existingDefinitionIndex];
              if (existingDefinition.core_key !== fixedDefinition.core_key) continue;
              if (existingIndex === -1) existingIndex = existingDefinitionIndex;
              if (existingDefinition.plot_id === fixedDefinition.plot_id) {
                expectedDynamicIndex = existingDefinitionIndex;
                break;
              }
            }
            // A dynamic mapping on the verified physical plot is already the
            // preferred evidence. If an intervening colorer was mislabeled as
            // an EMA, replace that bad mapping with the known Trend0822 plot.
            if (expectedDynamicIndex !== -1) continue;
            if (existingIndex !== -1) definitions.splice(existingIndex, 1);
            definitions.push({
              core_key: fixedDefinition.core_key,
              title: fixedDefinition.title,
              plot_id: fixedDefinition.plot_id,
              row_index: fixedDefinition.row_index,
              mapping_source: 'trend0822_fixed_plot_id_fallback',
            });
          }
        }
        return definitions;
      }
      function readClosedStudyRow(source, name, closeOpenTime) {
        var result = {
          name: name,
          study_value_source: 'plot_list_closed_row',
          observed_open_time: closeOpenTime,
          row_time: null,
          target_row_read_ok: false,
          data_window_read_ok: false,
          data_window_core_ok: false,
          core_fields: {},
          values: {},
          reason: null,
        };
        try {
          var meta = source.metaInfo();
          var definitions = studyCorePlotDefinitions(meta, name);
          if (definitions.length === 0) {
            result.reason = 'core_plot_definitions_unavailable';
            return result;
          }
          var data = source._data;
          if (!data || typeof data.searchByTime !== 'function') {
            result.reason = 'study_plot_list_unavailable';
            return result;
          }
          var found = data.searchByTime(closeOpenTime);
          var row = found && found.value;
          if (!found || !Array.isArray(row) || !sameTime(row[0], closeOpenTime)) {
            result.reason = 'closed_study_row_unavailable';
            return result;
          }
          result.row_time = row[0];
          result.target_row_read_ok = true;
          result.data_window_read_ok = true;
          for (var definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
            var definition = definitions[definitionIndex];
            var value = definition.row_index < row.length ? row[definition.row_index] : undefined;
            setCoreField(result.core_fields, definition.core_key, definition.title, value, definition);
            if (value === undefined || value === null || value === '∅') continue;
            if (!usableDataWindowValue(value)) {
              result.data_window_read_ok = false;
              result.reason = 'closed_study_row_value_invalid';
              continue;
            }
            result.values[definition.core_key] = value;
          }
          result.data_window_core_ok = result.data_window_read_ok
            && dataWindowCoreFieldsOk(name, result.core_fields);
          if (!result.data_window_core_ok && result.reason === null) {
            result.reason = 'closed_study_row_core_unavailable';
          }
          return result;
        } catch (e) {
          result.reason = 'closed_study_row_read_error';
          return result;
        }
      }
      function readClosedStudySnapshot(closeOpenTime) {
        var valueStudies = [];
        var shapeStudies = [];
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
            var source = sources[sourceIndex];
            if (!source || !source.metaInfo || !sourceIsVisible(source)) continue;
            var name = safeStudyName(source);
            if (!is0822ResearchStudyName(name) && !isTrainer0906StudyName(name)) continue;
            var studyRow = readClosedStudyRow(source, name, closeOpenTime);
            // Trainer0906 remains optional compatibility evidence. A missing
            // historical row cannot make the required 0822 pair look invalid.
            if (!isTrainer0906StudyName(name)
                || (studyRow.data_window_read_ok && studyRow.data_window_core_ok
                  && Object.keys(studyRow.values).length > 0)) {
              valueStudies.push(studyRow);
            }
            if (isTrend0822StudyName(name)) {
              var closedShapeRow = readTrendShapeValue(source, name, closeOpenTime);
              closedShapeRow.study_value_source = 'plot_list_closed_row';
              closedShapeRow.target_row_read_ok = closedShapeRow.available === true;
              shapeStudies.push(closedShapeRow);
            }
          }
        } catch (e) {}
        return {
          raw_study_values: {
            success: true,
            observation_phase: 'post_target_final',
            observation_open_time: closeOpenTime,
            target_open_time: closeOpenTime,
            source: 'plot_list_closed_row',
            study_count: valueStudies.length,
            studies: valueStudies,
          },
          shape_values: {
            success: true,
            observation_phase: 'post_target_final',
            observation_open_time: closeOpenTime,
            target_open_time: closeOpenTime,
            source: 'plot_list_closed_row',
            study_count: shapeStudies.length,
            studies: shapeStudies,
          },
        };
      }
      function canonicalStudyValue(value) {
        if (value === null) return 'null';
        var type = typeof value;
        if (type === 'undefined') return 'undefined';
        if (type === 'number') {
          return Number.isFinite(value) ? type + ':' + String(value) : null;
        }
        if (type === 'string' || type === 'boolean') {
          return type + ':' + String(value);
        }
        return null;
      }
      // The timestamped target PlotList rows, target Trend shape row, and
      // next-active Pine labels can each update after doStep. Compare one
      // canonical, strictly tagged view so no asynchronous source can be
      // mixed into a purportedly finalized historical observation.
      function combinedSnapshotFingerprint(snapshot) {
        var rawStudyValues = snapshot && snapshot.raw_study_values;
        var shapeValues = snapshot && snapshot.shape_values;
        var rawPineLabels = snapshot && snapshot.raw_pine_labels;
        if (!rawStudyValues || rawStudyValues.success !== true || !Array.isArray(rawStudyValues.studies)
            || rawStudyValues.studies.length === 0 || !shapeValues || shapeValues.success !== true
            || !Array.isArray(shapeValues.studies) || shapeValues.studies.length === 0
            || !rawPineLabels || rawPineLabels.success !== true || !Array.isArray(rawPineLabels.studies)) return null;
        var normalizedStudies = [];
        var trendStudyNames = {};
        var swingStudyNames = {};
        var target0822StudyNames = {};
        for (var studyIndex = 0; studyIndex < rawStudyValues.studies.length; studyIndex += 1) {
          var study = rawStudyValues.studies[studyIndex];
          if (!study || !study.name
              || (!is0822ResearchStudyName(study.name) && !isTrainer0906StudyName(study.name))
              || study.data_window_read_ok !== true || study.data_window_core_ok !== true || !study.values
              || typeof study.values !== 'object' || Array.isArray(study.values)) {
            return null;
          }
          if (rawStudyValues.observation_phase === 'post_target_final'
              && (study.target_row_read_ok !== true
                || !sameTime(study.observed_open_time, rawStudyValues.observation_open_time)
                || !sameTime(study.row_time, rawStudyValues.observation_open_time))) return null;
          if (!dataWindowCoreFieldsOk(study.name, study.core_fields || {})) return null;
          var keys = Object.keys(study.values).sort();
          if (keys.length === 0) return null;
          var values = [];
          for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
            var key = keys[keyIndex];
            if (!usableDataWindowValue(study.values[key])) return null;
            values.push([key, canonicalStudyValue(study.values[key])]);
          }
          var coreKeys = Object.keys(study.core_fields || {}).sort();
          var normalizedCoreFields = [];
          for (var coreIndex = 0; coreIndex < coreKeys.length; coreIndex += 1) {
            var coreKey = coreKeys[coreIndex];
            var coreField = study.core_fields[coreKey];
            if (!coreField || typeof coreField.value_present !== 'boolean') return null;
            if (coreField.value_present && !usableDataWindowValue(coreField.value)) return null;
            var titleFingerprint = canonicalStudyValue(coreField.title);
            var presentFingerprint = canonicalStudyValue(coreField.value_present);
            var valueFingerprint = canonicalStudyValue(coreField.value);
            var invalidFingerprint = canonicalStudyValue(coreField.value_invalid);
            var plotIdFingerprint = canonicalStudyValue(coreField.plot_id);
            var rowIndexFingerprint = canonicalStudyValue(coreField.row_index);
            var mappingSourceFingerprint = canonicalStudyValue(coreField.mapping_source);
            if (titleFingerprint === null || presentFingerprint === null
                || valueFingerprint === null || invalidFingerprint === null
                || plotIdFingerprint === null || rowIndexFingerprint === null
                || mappingSourceFingerprint === null) return null;
            normalizedCoreFields.push([
              coreKey,
              titleFingerprint,
              presentFingerprint,
              valueFingerprint,
              invalidFingerprint,
              plotIdFingerprint,
              rowIndexFingerprint,
              mappingSourceFingerprint,
            ]);
          }
          normalizedStudies.push([String(study.name), values, normalizedCoreFields]);
          if (isTrend0822StudyName(study.name)) {
            var trendName = String(study.name);
            trendStudyNames[trendName] = (trendStudyNames[trendName] || 0) + 1;
          }
          if (is0822ResearchStudyName(study.name)) {
            var targetName = String(study.name);
            target0822StudyNames[targetName] = (target0822StudyNames[targetName] || 0) + 1;
            if (targetName.indexOf('波段过滤器') !== -1) {
              swingStudyNames[targetName] = (swingStudyNames[targetName] || 0) + 1;
            }
          }
        }
        if (Object.keys(trendStudyNames).length === 0 || Object.keys(swingStudyNames).length === 0) return null;
        var normalizedShapes = [];
        var shapeStudyNames = {};
        for (var shapeStudyIndex = 0; shapeStudyIndex < shapeValues.studies.length; shapeStudyIndex += 1) {
          var shapeStudy = shapeValues.studies[shapeStudyIndex];
          if (!shapeStudy || !isTrend0822StudyName(shapeStudy.study_name || shapeStudy.source)
              || shapeStudy.available !== true
              || !sameTime(shapeStudy.active_open_time, shapeStudy.row_time)
              || !Array.isArray(shapeStudy.shape_fields) || shapeStudy.shape_fields.length === 0) {
            return null;
          }
          if (shapeValues.observation_phase === 'post_target_final'
              && (shapeStudy.target_row_read_ok !== true
                || shapeStudy.study_value_source !== 'plot_list_closed_row'
                || !sameTime(shapeStudy.row_time, shapeValues.observation_open_time))) return null;
          var normalizedFields = [];
          for (var fieldIndex = 0; fieldIndex < shapeStudy.shape_fields.length; fieldIndex += 1) {
            var field = shapeStudy.shape_fields[fieldIndex];
            if (!field || !field.plot_id || field.value_present !== true
                || field.value_invalid === true || !isSafeShapeRowValue(field.value)) return null;
            var shapeValueFingerprint = canonicalStudyValue(field.value);
            if (shapeValueFingerprint === null) return null;
            normalizedFields.push([
              String(field.plot_id),
              Number(field.row_index),
              field.code === undefined || field.code === null ? '' : String(field.code),
              field.title === undefined || field.title === null ? '' : String(field.title),
              field.text === undefined || field.text === null ? '' : String(field.text),
              shapeValueFingerprint,
            ]);
          }
          normalizedFields.sort(function(left, right) {
            return left[0] < right[0] ? -1 : (left[0] > right[0] ? 1 : 0);
          });
          var shapeName = String(shapeStudy.study_name || shapeStudy.source);
          shapeStudyNames[shapeName] = (shapeStudyNames[shapeName] || 0) + 1;
          normalizedShapes.push([
            shapeName,
            canonicalStudyValue(shapeStudy.active_open_time),
            Number(shapeStudy.row_index),
            !!shapeStudy.history_calculation_may_change,
            normalizedFields,
          ]);
        }
        var trendNames = Object.keys(trendStudyNames);
        for (var trendIndex = 0; trendIndex < trendNames.length; trendIndex += 1) {
          var requiredTrendName = trendNames[trendIndex];
          if (shapeStudyNames[requiredTrendName] !== trendStudyNames[requiredTrendName]) return null;
        }
        normalizedStudies.sort(function(left, right) {
          var leftKey = JSON.stringify(left);
          var rightKey = JSON.stringify(right);
          return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
        });
        normalizedShapes.sort(function(left, right) {
          var leftKey = JSON.stringify(left);
          var rightKey = JSON.stringify(right);
          return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
        });
        var allLabelsByStudy = snapshot && snapshot.label_snapshot
          && Array.isArray(snapshot.label_snapshot.all_labels_by_study)
          ? snapshot.label_snapshot.all_labels_by_study
          : null;
        if (!allLabelsByStudy || allLabelsByStudy.length !== rawPineLabels.studies.length) return null;
        var normalizedLabels = [];
        var labelStudyNames = {};
        for (var labelStudyIndex = 0; labelStudyIndex < rawPineLabels.studies.length; labelStudyIndex += 1) {
          var labelStudy = rawPineLabels.studies[labelStudyIndex];
          var allLabelStudy = allLabelsByStudy[labelStudyIndex];
          if (!labelStudy || !is0822ResearchStudyName(labelStudy.name)
              || labelStudy.label_read_ok !== true || !Array.isArray(labelStudy.labels) || !allLabelStudy
              || String(allLabelStudy.name) !== String(labelStudy.name)
              || allLabelStudy.label_read_ok !== true || !Array.isArray(allLabelStudy.labels)) return null;
          var labelStudyName = String(labelStudy.name);
          labelStudyNames[labelStudyName] = (labelStudyNames[labelStudyName] || 0) + 1;
          var normalizedStudyLabels = [];
          for (var labelIndex = 0; labelIndex < allLabelStudy.labels.length; labelIndex += 1) {
            var label = allLabelStudy.labels[labelIndex];
            if (!label) return null;
            // Pine retains labels for bars that have not occurred yet in the
            // replay viewport. Those future (or coordinate-ambiguous) labels
            // cannot affect the finalized target/availability evidence, so
            // leave them out of the stability fingerprint entirely. They also
            // remain outside materializeLabels' seen checkpoint until their
            // coordinate is actually reachable.
            var relation = labelXRelation(
              label.x,
              rawPineLabels.observation_open_time,
              rawPineLabels.active_logical_index
            );
            if (!relation.comparable || relation.value > relation.active) continue;
            var labelIdentity = stableReplayLabelIdentity(labelStudy.name, label);
            // Do not coerce falsy primitives: 0, empty string, null, and a
            // missing property deliberately produce distinct tagged values.
            var labelIdFingerprint = canonicalStudyValue(label.id);
            var labelXFingerprint = canonicalStudyValue(label.x);
            var labelTextFingerprint = canonicalStudyValue(label.text);
            var labelPriceFingerprint = canonicalStudyValue(label.price);
            var selectionFingerprint = canonicalStudyValue(labelStudy.selection);
            var identityFingerprint = canonicalStudyValue(labelIdentity);
            if (labelIdFingerprint === null || labelXFingerprint === null
                || labelTextFingerprint === null || labelPriceFingerprint === null
                || selectionFingerprint === null || identityFingerprint === null) return null;
            normalizedStudyLabels.push([
              labelIdFingerprint,
              labelXFingerprint,
              labelTextFingerprint,
              labelPriceFingerprint,
              selectionFingerprint,
              identityFingerprint,
            ]);
          }
          normalizedStudyLabels.sort(function(left, right) {
            var leftKey = JSON.stringify(left);
            var rightKey = JSON.stringify(right);
            return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
          });
          normalizedLabels.push([
            String(labelStudy.name),
            canonicalStudyValue(labelStudy.selection),
            normalizedStudyLabels,
          ]);
        }
        normalizedLabels.sort(function(left, right) {
          var leftKey = JSON.stringify(left);
          var rightKey = JSON.stringify(right);
          return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
        });
        var targetLabelNames = Object.keys(target0822StudyNames);
        if (targetLabelNames.length !== Object.keys(labelStudyNames).length) return null;
        for (var targetLabelIndex = 0; targetLabelIndex < targetLabelNames.length; targetLabelIndex += 1) {
          var targetLabelName = targetLabelNames[targetLabelIndex];
          if (labelStudyNames[targetLabelName] !== target0822StudyNames[targetLabelName]) return null;
        }
        return JSON.stringify([
          normalizedStudies,
          normalizedShapes,
          canonicalStudyValue(rawPineLabels.active_logical_index),
          normalizedLabels,
        ]);
      }
      function closedEvidenceFingerprint(closedStudySnapshot, labelSnapshot) {
        if (!closedStudySnapshot || !labelSnapshot) return null;
        return combinedSnapshotFingerprint({
          raw_study_values: closedStudySnapshot.raw_study_values,
          shape_values: closedStudySnapshot.shape_values,
          raw_pine_labels: labelSnapshot.raw_pine_labels,
          label_snapshot: labelSnapshot,
        });
      }
      function labelClass(text) {
        var value = String(text || '').trim();
        if (/背离|pivot|divergence|bull|bear|顶|底|买|卖|多|空/i.test(value)) return 'event_candidate';
        if (/^[+−\\-]?\\d+(?:[.,]\\d+)?(?:%|[kmb])?$/i.test(value)) return 'display_state';
        return 'annotation';
      }
      function readLabelPrimitives(source, name) {
        var result = {
          label_read_ok: false,
          label_collection_available: false,
          reason: null,
          labels: [],
        };
        // Trend0822's actionable signals are PlotList plotshapes, not Pine
        // labels. Some current builds expose _graphics but no dwglabels map;
        // treating every such layout variation as a read failure deadlocks the
        // replay gate. Deliberately publish an explicit readable empty set.
        if (isTrend0822StudyName(name)) {
          return {
            label_read_ok: true,
            label_collection_available: false,
            reason: 'trend_labels_optional_unavailable',
            labels: [],
          };
        }
        try {
          // _graphics is a live getter in TradingView. Read it once per
          // snapshot so the fingerprint cannot accidentally combine two UI
          // generations during a single primitive traversal.
          var graphics = source._graphics;
          if (!graphics) {
            result.reason = 'graphics_unavailable';
            return result;
          }
          var primitives = graphics && graphics._primitivesCollection;
          var outer = primitives && primitives.dwglabels;
          var inner = outer && outer.get('labels');
          var collection = inner && inner.get(false);
          var map = collection && collection._primitivesDataById;
          if (!map || !map.forEach) {
            result.reason = 'dwglabels_collection_unavailable';
            return result;
          }
          result.label_collection_available = true;
          map.forEach(function(value, id) {
            if (!value) return;
            var hasOwn = Object.prototype.hasOwnProperty;
            var rawTextPresent = hasOwn.call(value, 't');
            var rawPricePresent = hasOwn.call(value, 'y');
            var rawXPresent = hasOwn.call(value, 'x');
            var rawText = rawTextPresent ? value.t : undefined;
            var rawPrice = rawPricePresent ? value.y : undefined;
            var rawX = rawXPresent ? value.x : undefined;
            var hasDisplayText = rawTextPresent && rawText !== undefined && rawText !== null && rawText !== '';
            var hasDisplayPrice = rawPricePresent && rawPrice !== undefined && rawPrice !== null;
            if (!hasDisplayText && !hasDisplayPrice) return;
            var normalizedPrice = null;
            if (hasDisplayPrice) {
              var numericPrice = Number(rawPrice);
              if (!Number.isFinite(numericPrice)) {
                result.label_read_ok = false;
                result.reason = 'label_price_invalid';
                return;
              }
              normalizedPrice = Math.round(numericPrice * 100) / 100;
            }
            result.labels.push({
              id: id === undefined || id === null ? null : String(id),
              text: rawText === undefined || rawText === null ? '' : String(rawText),
              price: normalizedPrice,
              x: rawX === undefined || rawX === null ? null : rawX,
              yloc: value.yl,
              study_name: name,
              _raw_id_present: id !== undefined,
              _raw_id: id,
              _raw_text_present: rawTextPresent,
              _raw_text: rawText,
              _raw_price_present: rawPricePresent,
              _raw_price: rawPrice,
              _raw_x_present: rawXPresent,
              _raw_x: rawX,
            });
          });
          if (result.reason === null) result.label_read_ok = true;
        } catch (e) {
          result.reason = 'label_read_error';
        }
        return result;
      }
      // Label reads are intentionally pure. Pine primitives are finalized at
      // the following active bar and participate in the post-target repeated
      // fingerprint before any seen-state is changed.
      function readLabelSnapshot(activeOpenTime) {
        var studies = [];
        var allLabelsByStudy = [];
        var activeLogicalIndex = activeLogicalIndexForTime(activeOpenTime);
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
            var source = sources[sourceIndex];
            if (!source || !source.metaInfo || !sourceIsVisible(source)) continue;
            var name = safeStudyName(source);
            if (!is0822ResearchStudyName(name)) continue;
            var labelRead = readLabelPrimitives(source, name);
            var allLabels = labelRead.labels;
            var selected = selectCurrentOrMaxXReplayLabels(
              name, allLabels, activeOpenTime, activeLogicalIndex
            );
            for (var selectedRelationIndex = 0; selectedRelationIndex < selected.labels.length; selectedRelationIndex += 1) {
              var selectedRelationLabel = selected.labels[selectedRelationIndex];
              // selectCurrentOrMaxXReplayLabels carries the Pine UI object's
              // temporary id for selection. It is audit-only: persistent v4
              // identities are built later from a verified physical bar time.
              selectedRelationLabel.source_label_identity = selectedRelationLabel.label_identity;
              delete selectedRelationLabel.label_identity;
              var selectedRelation = labelXRelation(
                selectedRelationLabel.x, activeOpenTime, activeLogicalIndex
              );
              selectedRelationLabel.label_coordinate_kind = selectedRelation.kind || null;
              selectedRelationLabel.label_coordinate_value = selectedRelation.comparable
                ? selectedRelation.value
                : null;
              selectedRelationLabel.label_coordinate_active = selectedRelation.comparable
                ? selectedRelation.active
                : null;
              selectedRelationLabel.label_coordinate_comparable = selectedRelation.comparable === true;
            }
            var swingHasSelectedNumericLabel = false;
            for (var selectedIndex = 0; selectedIndex < selected.labels.length; selectedIndex += 1) {
              var selectedLabel = selected.labels[selectedIndex];
              var numericText = Number(selectedLabel.text);
              if ((typeof selectedLabel.price === 'number' && Number.isFinite(selectedLabel.price))
                  || (selectedLabel.text !== '' && Number.isFinite(numericText))) {
                swingHasSelectedNumericLabel = true;
                break;
              }
            }
            var isSwing = String(name).indexOf('波段过滤器') !== -1;
            var labelReadOk = labelRead.label_read_ok && (!isSwing || swingHasSelectedNumericLabel);
            studies.push({
              name: name,
              label_read_ok: labelReadOk,
              label_collection_available: labelRead.label_collection_available,
              label_read_reason: labelRead.reason,
              total_labels: allLabels.length,
              selection: selected.selection,
              labels: selected.labels,
            });
            allLabelsByStudy.push({
              name: name,
              label_read_ok: labelReadOk,
              label_collection_available: labelRead.label_collection_available,
              label_read_reason: labelRead.reason,
              labels: allLabels,
            });
          }
        } catch (e) {}
        return {
          raw_pine_labels: {
            success: true,
            label_identity_version: replayLabelIdentityVersion,
            observation_phase: 'post_availability_next_active',
            observation_open_time: activeOpenTime,
            study_count: studies.length,
            active_logical_index: activeLogicalIndex,
            studies: studies,
          },
          // Internal snapshot used for preview diagnostics or post-target
          // fingerprinting; it is never itself a final feature row.
          all_labels_by_study: allLabelsByStudy,
          active_logical_index: activeLogicalIndex,
        };
      }
      function mainSeriesBars() {
        try {
          return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget
            .model().mainSeries().bars();
        } catch (e) {
          return null;
        }
      }
      // A Pine logical x is only durable after resolving it back through the
      // main series in both directions. Replay resets can reuse both x and
      // primitive IDs, whereas the verified physical bar time cannot collide.
      function verifiedMainSeriesLogicalBar(logicalIndex) {
        if (!Number.isInteger(logicalIndex)) return null;
        try {
          var bars = mainSeriesBars();
          if (!bars || typeof bars.valueAt !== 'function' || typeof bars.searchByTime !== 'function') return null;
          if (typeof bars.firstIndex === 'function' && typeof bars.lastIndex === 'function') {
            var firstIndex = bars.firstIndex();
            var lastIndex = bars.lastIndex();
            if (Number.isFinite(firstIndex) && logicalIndex < firstIndex) return null;
            if (Number.isFinite(lastIndex) && logicalIndex > lastIndex) return null;
          }
          var row = bars.valueAt(logicalIndex);
          var seconds = row && comparableTime(row[0]);
          if (!row || seconds === null || !Number.isInteger(seconds)) return null;
          var found = bars.searchByTime(row[0]);
          if (!found || found.index !== logicalIndex || !found.value || !sameTime(found.value[0], row[0])) return null;
          return {
            // Persist the canonical Unix-second epoch, rather than the
            // implementation-specific bar timestamp representation. This
            // keeps signal_bar_time exactly equal to label_physical_epoch
            // when a chart exposes milliseconds.
            signal_bar_time: seconds,
            physical_epoch: seconds,
            logical_index: logicalIndex,
            source: 'main_series_value_at_verified',
          };
        } catch (e) {
          return null;
        }
      }
      function verifiedMainSeriesEpochBar(epochSeconds) {
        if (!Number.isFinite(epochSeconds) || !Number.isInteger(epochSeconds)) return null;
        try {
          var bars = mainSeriesBars();
          if (!bars || typeof bars.searchByTime !== 'function' || typeof bars.valueAt !== 'function') return null;
          var found = bars.searchByTime(epochSeconds);
          if (!found || !Number.isInteger(found.index) || !found.value
              || !sameTime(found.value[0], epochSeconds)) return null;
          var reverse = bars.valueAt(found.index);
          if (!reverse || !sameTime(reverse[0], found.value[0])) return null;
          var seconds = comparableTime(found.value[0]);
          if (seconds === null || !Number.isInteger(seconds)) return null;
          return {
            // See verifiedMainSeriesLogicalBar: durable v4 label fields use
            // canonical Unix seconds even when the underlying series row is
            // millisecond-encoded.
            signal_bar_time: seconds,
            physical_epoch: seconds,
            logical_index: found.index,
            source: 'main_series_epoch_verified',
          };
        } catch (e) {
          return null;
        }
      }
      function sourceDiscriminatorForLabel(label) {
        var raw = label || {};
        if (raw.id !== undefined && raw.id !== null && String(raw.id) !== '') return 'id:' + String(raw.id);
        function token(value) {
          if (value === null) return 'null';
          if (value === undefined) return 'undefined';
          if (typeof value === 'number') return Number.isFinite(value) ? 'number:' + String(value) : null;
          if (typeof value === 'string') return 'string:' + value;
          if (typeof value === 'boolean') return 'boolean:' + String(value);
          return null;
        }
        var fields = [raw.x, raw.text, raw.price, raw.yloc];
        var parts = [];
        for (var index = 0; index < fields.length; index += 1) {
          var valueToken = token(fields[index]);
          if (valueToken === null) return null;
          parts.push(valueToken);
        }
        return 'fallback:' + parts.join('|');
      }
      function persistentLabelIdentity(studyName, physicalEpoch, sourceDiscriminator) {
        if (!studyName || !Number.isInteger(physicalEpoch) || !sourceDiscriminator) return null;
        return 'pl4:' + encodeURIComponent(String(studyName)) + ':'
          + String(physicalEpoch) + ':' + encodeURIComponent(String(sourceDiscriminator));
      }
      function resolveLabelPhysicalEpoch(rawLabel, targetOpenTime, availabilityOpenTime,
          targetLogicalIndex, availabilityLogicalIndex, timeframeSeconds) {
        var relation = labelXRelation(
          rawLabel && rawLabel.x,
          availabilityOpenTime,
          availabilityLogicalIndex
        );
        if (!relation.comparable || relation.value > relation.active) {
          return { verified: false, relation: relation, reason: relation.comparable ? 'label_future_at_availability' : relation.reason };
        }
        var availabilitySeconds = comparableTime(availabilityOpenTime);
        var targetSeconds = comparableTime(targetOpenTime);
        var resolved = null;
        if (relation.kind === 'logical') {
          // The direct PlotList/main-series lookup is authoritative. It also
          // prevents an old session's logical index from being assigned to a
          // new session's different physical date.
          resolved = verifiedMainSeriesLogicalBar(relation.value);
          if (!resolved && Number.isFinite(timeframeSeconds) && timeframeSeconds > 0
              && availabilitySeconds !== null && Number.isInteger(relation.value)) {
            // A timeframe calculation is only a candidate. Weekend/session
            // gaps make arithmetic alone unsafe, so it must round-trip through
            // searchByTime and recover the exact original logical index.
            var candidate = availabilitySeconds + (relation.value - availabilityLogicalIndex) * timeframeSeconds;
            var candidateResolved = verifiedMainSeriesEpochBar(candidate);
            if (candidateResolved && candidateResolved.logical_index === relation.value) {
              candidateResolved.source = 'availability_timeframe_candidate_verified';
              resolved = candidateResolved;
            }
          }
        } else if (relation.kind === 'time') {
          resolved = verifiedMainSeriesEpochBar(relation.value);
        }
        if (!resolved || !Number.isInteger(resolved.physical_epoch)
            || (availabilitySeconds !== null && resolved.physical_epoch > availabilitySeconds)) {
          return { verified: false, relation: relation, reason: 'physical_signal_epoch_unavailable' };
        }
        return {
          verified: true,
          relation: relation,
          signal_bar_time: resolved.signal_bar_time,
          physical_epoch: resolved.physical_epoch,
          logical_index: resolved.logical_index,
          source: resolved.source,
          target_logical_index: targetLogicalIndex,
          availability_logical_index: availabilityLogicalIndex,
          timeframe_seconds: timeframeSeconds,
          target_seconds: targetSeconds,
        };
      }
      function materializeLabels(labelSnapshot, seen, chunkIteration, activeOpenTime, targetOpenTime) {
        var snapshot = labelSnapshot || { raw_pine_labels: { success: true, study_count: 0, studies: [] } };
        var newlyVisibleLabels = [];
        var labelStudies = Array.isArray(snapshot.all_labels_by_study) ? snapshot.all_labels_by_study : [];
        var targetLogicalIndex = activeLogicalIndexForTime(targetOpenTime);
        var availabilityLogicalIndex = snapshot.raw_pine_labels
          && Number.isInteger(snapshot.raw_pine_labels.active_logical_index)
          ? snapshot.raw_pine_labels.active_logical_index
          : activeLogicalIndexForTime(activeOpenTime);
        var targetSeconds = comparableTime(targetOpenTime);
        var availabilitySeconds = comparableTime(activeOpenTime);
        var timeframeSeconds = targetSeconds !== null && availabilitySeconds !== null
          ? availabilitySeconds - targetSeconds
          : null;
        if (!Number.isFinite(timeframeSeconds) || timeframeSeconds <= 0) timeframeSeconds = null;
        var candidates = [];
        for (var studyIndex = 0; studyIndex < labelStudies.length; studyIndex += 1) {
          var labelStudy = labelStudies[studyIndex];
          var studyName = labelStudy && labelStudy.name;
          var labels = labelStudy && Array.isArray(labelStudy.labels) ? labelStudy.labels : [];
          for (var labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
            var rawLabel = labels[labelIndex];
            var targetRelation = labelXRelation(
              rawLabel && rawLabel.x,
              targetOpenTime,
              targetLogicalIndex
            );
            // Future or coordinate-ambiguous labels never enter the durable
            // event/checkpoint state. A label shown on availability A is still
            // future relative to just-closed target T and must wait one bar.
            if (!targetRelation.comparable || targetRelation.value > targetRelation.active) continue;
            var physical = resolveLabelPhysicalEpoch(
              rawLabel,
              targetOpenTime,
              activeOpenTime,
              targetLogicalIndex,
              availabilityLogicalIndex,
              timeframeSeconds
            );
            if (!physical.verified) continue;
            if (targetSeconds !== null && physical.physical_epoch > targetSeconds) continue;
            var targetAligned = targetRelation.value === targetRelation.active;
            if (targetAligned && !sameTime(physical.signal_bar_time, targetOpenTime)) continue;
            if (!targetAligned && (targetSeconds === null || physical.physical_epoch >= targetSeconds)) continue;
            var sourceDiscriminator = sourceDiscriminatorForLabel(rawLabel);
            var key = persistentLabelIdentity(studyName, physical.physical_epoch, sourceDiscriminator);
            if (!key) continue;
            candidates.push({
              key: key,
              raw_label: rawLabel,
              study_name: studyName,
              target_relation: targetRelation,
              physical: physical,
              target_aligned: targetAligned,
              source_discriminator: sourceDiscriminator,
            });
          }
        }
        candidates.sort(function(left, right) {
          return left.key < right.key ? -1 : (left.key > right.key ? 1 : 0);
        });
        for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
          var candidate = candidates[candidateIndex];
          if (seen.has(candidate.key)) continue;
          seen.add(candidate.key);
          var rawLabel = candidate.raw_label;
          var relation = candidate.target_relation;
          var physical = candidate.physical;
          var kind = labelClass(rawLabel.text);
          newlyVisibleLabels.push({
            id: rawLabel.id,
            label_identity_version: replayLabelIdentityVersion,
            label_identity: candidate.key,
            source_label_identity: stableReplayLabelIdentity(candidate.study_name, rawLabel),
            source_discriminator: candidate.source_discriminator,
            study_name: candidate.study_name,
            text: rawLabel.text,
            price: rawLabel.price,
            label_x: rawLabel.x,
            label_coordinate_kind: relation.kind,
            label_coordinate_value: relation.value,
            label_coordinate_active: relation.active,
            label_coordinate_comparable: true,
            target_open_time: targetOpenTime,
            availability_open_time: activeOpenTime,
            label_physical_epoch: physical.physical_epoch,
            signal_bar_time: physical.signal_bar_time,
            signal_bar_logical_index: physical.logical_index,
            signal_time_mapping_source: physical.source,
            signal_time_mapping_verified: true,
            signal_time_mapping_logical_index: physical.logical_index,
            target_logical_index: physical.target_logical_index,
            availability_logical_index: physical.availability_logical_index,
            timeframe_seconds: physical.timeframe_seconds,
            target_aligned: candidate.target_aligned,
            delayed: !candidate.target_aligned,
            strategy_eligible: candidate.target_aligned,
            observed_at: activeOpenTime,
            observed_at_open_time: activeOpenTime,
            first_seen_in_chunk: chunkIteration === 0,
            classification: kind,
            is_event_candidate: kind === 'event_candidate',
          });
        }
        return {
          raw_pine_labels: snapshot.raw_pine_labels,
          newly_visible_labels: newlyVisibleLabels,
        };
      }
      function readCombinedSnapshot(activeOpenTime) {
        var studySnapshot = readStudySnapshot(activeOpenTime);
        var labelSnapshot = readLabelSnapshot(activeOpenTime);
        return {
          raw_study_values: studySnapshot.raw_study_values,
          shape_values: studySnapshot.shape_values,
          raw_pine_labels: labelSnapshot.raw_pine_labels,
          label_snapshot: labelSnapshot,
        };
      }
      function sameTime(left, right) {
        if (left === right) return true;
        function comparable(value) {
          if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value) > 100000000000 ? value / 1000 : value;
          if (typeof value === 'string' && value.trim() !== '') {
            var parsed = Number(value);
            if (Number.isFinite(parsed)) return Math.abs(parsed) > 100000000000 ? parsed / 1000 : parsed;
          }
          return null;
        }
        var a = comparable(left);
        var b = comparable(right);
        return a !== null && b !== null && a === b;
      }
      function comparableTime(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value) > 100000000000 ? value / 1000 : value;
        if (typeof value === 'string' && value.trim() !== '') {
          var parsed = Number(value);
          if (Number.isFinite(parsed)) return Math.abs(parsed) > 100000000000 ? parsed / 1000 : parsed;
        }
        return null;
      }
      function isLaterTime(left, right) {
        var a = comparableTime(left);
        var b = comparableTime(right);
        return a !== null && b !== null && a > b;
      }
      function numericLabelX(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
          var parsed = Number(value);
          if (Number.isFinite(parsed)) return parsed;
        }
        return null;
      }
      // Pine label x can be either an epoch or a logical bar index. Compare it
      // only in a known coordinate system: an ambiguous relation must not mark
      // a label as seen before its actual bar arrives.
      function labelXRelation(labelX, activeOpenTime, activeLogicalIndex) {
        var rawX = numericLabelX(labelX);
        var activeTime = comparableTime(activeOpenTime);
        if (rawX === null || activeTime === null) return { comparable: false, reason: 'label_x_uncomparable' };
        var normalizedTime = Math.abs(rawX) > 100000000000 ? rawX / 1000 : rawX;
        var activeIsEpoch = Math.abs(activeTime) >= 100000000;
        if (activeIsEpoch && Math.abs(normalizedTime) < 100000000) {
          if (typeof activeLogicalIndex !== 'number' || !Number.isFinite(activeLogicalIndex)
              || !Number.isInteger(rawX)) {
            return { comparable: false, reason: 'logical_index_unavailable' };
          }
          return { comparable: true, kind: 'logical', value: rawX, active: activeLogicalIndex };
        }
        return { comparable: true, kind: 'time', value: normalizedTime, active: activeTime };
      }
      function sameBar(left, right) {
        if (!left || !right || !sameTime(left.time, right.time)) return false;
        var fields = ['open', 'high', 'low', 'close', 'volume'];
        for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
          var a = Number(left[fields[fieldIndex]]);
          var b = Number(right[fields[fieldIndex]]);
          if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
          var tolerance = Math.max(1, Math.abs(a), Math.abs(b)) * 1e-10;
          if (Math.abs(a - b) > tolerance) return false;
        }
        return true;
      }
      function failure(code, stage, sequence, message, extra) {
        var value = {
          code: code,
          stage: stage,
          sequence: sequence,
          message: message,
        };
        if (extra && typeof extra === 'object') {
          Object.keys(extra).forEach(function(key) { value[key] = extra[key]; });
        }
        return value;
      }
      // These identities are deliberately independent of Pine labels. Trend
      // PlotList scans are read after finalization and diffed only after every
      // post-target OHLCV/study/label gate has passed.
      var seenShapeKeys = new Set(knownShapeKeys);
      var seenLabelKeys = new Set(knownLabelKeys);
      var acceptedShapeSnapshots = 0;
      function seenShapeKeysAfter() {
        return Array.from(seenShapeKeys).sort();
      }
      function seenLabelKeysAfter() {
        return Array.from(seenLabelKeys).sort();
      }
      function newlySeenPlotshapeSignals(availableSignals, finalizedOpenTime, firstSeenOpenTime) {
        var signals = Array.isArray(availableSignals) ? availableSignals : [];
        var events = [];
        var finalizedSeconds = comparableTime(finalizedOpenTime);
        var initialSeed = !shapeStateInitialized;
        for (var signalIndex = 0; signalIndex < signals.length; signalIndex += 1) {
          var signal = signals[signalIndex];
          if (!signal || !signal.identity || seenShapeKeys.has(signal.identity)) continue;
          var signalSeconds = comparableTime(signal.signal_bar_time);
          // Never consume a shape on the new active preview bar. It has not
          // closed yet and therefore cannot be evidence for this record.
          if (finalizedSeconds !== null && signalSeconds !== null && signalSeconds > finalizedSeconds) continue;
          var delayed = finalizedSeconds !== null && signalSeconds !== null && signalSeconds < finalizedSeconds;
          seenShapeKeys.add(signal.identity);
          // Only an explicitly uninitialized state can seed old rows quietly.
          // The just-finalized row is not historical backpaint: it became
          // observable only at the next active bar and must be emitted there.
          if (initialSeed && delayed) continue;
          events.push({
            identity: signal.identity,
            study_name: signal.study_name,
            source: signal.source,
            plot_id: signal.plot_id,
            code: signal.code,
            text: signal.text,
            title: signal.title,
            value: signal.value,
            signal_bar_time: signal.signal_bar_time,
            target_open_time: finalizedOpenTime,
            availability_open_time: firstSeenOpenTime,
            finalized_open_time: finalizedOpenTime,
            first_seen_at: firstSeenOpenTime,
            first_seen_at_open_time: firstSeenOpenTime,
            delayed: delayed,
            finalized_on_next_active: !delayed,
            history_calculation_may_change: signal.history_calculation_may_change,
            first_seen_in_chunk: acceptedShapeSnapshots === 0,
          });
        }
        shapeStateInitialized = true;
        acceptedShapeSnapshots += 1;
        return events;
      }
      function result(records, stepsInvoked, failureValue) {
        return {
          success: true,
          schema_version: replayCaptureSchemaVersion,
          label_identity_version: replayLabelIdentityVersion,
          feature_phase: 'post_target_final',
          ohlcv_phase: 'post_target_final',
          complete: !failureValue,
          partial: !!failureValue && records.length > 0,
          records: records,
          requested_steps: requestedSteps,
          completed_steps: records.length,
          steps_invoked: stepsInvoked,
          seen_shape_keys_after: seenShapeKeysAfter(),
          shape_state_initialized_after: shapeStateInitialized,
          seen_label_keys_after: seenLabelKeysAfter(),
          failure: failureValue || null,
        };
      }
      function inspectActiveBar() {
        var bars = readRecentBars();
        var activeBar = bars.length > 0 ? bars[bars.length - 1] : null;
        var previousBar = bars.length > 1 ? bars[bars.length - 2] : null;
        var activeOpenSeconds = activeBar ? comparableTime(activeBar.time) : null;
        var previousOpenSeconds = previousBar ? comparableTime(previousBar.time) : null;
        var inferredTimeframeSeconds = activeOpenSeconds !== null && previousOpenSeconds !== null
          ? activeOpenSeconds - previousOpenSeconds
          : null;
        if (!Number.isFinite(inferredTimeframeSeconds) || inferredTimeframeSeconds <= 0) inferredTimeframeSeconds = null;
        var chartResolution = null;
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          chartResolution = chart && typeof chart.resolution === 'function' ? chart.resolution() : null;
        } catch (e) {}
        var nominalTimeframeSeconds = replayResolutionToSeconds(chartResolution);
        var timeframeSeconds = nominalTimeframeSeconds === null ? inferredTimeframeSeconds : nominalTimeframeSeconds;
        var suppliedCloseSeconds = null;
        if (activeOpenSeconds !== null) {
          try {
            var mainBars = mainSeriesBars();
            var found = mainBars && typeof mainBars.searchByTime === 'function'
              ? mainBars.searchByTime(activeBar.time)
              : null;
            var rawBar = found && found.value;
            var rawClose = rawBar && rawBar.timeClose;
            if (rawClose === undefined || rawClose === null) rawClose = rawBar && rawBar.time_close;
            var candidateCloseSeconds = comparableTime(rawClose);
            if (candidateCloseSeconds !== null && candidateCloseSeconds > activeOpenSeconds) {
              suppliedCloseSeconds = candidateCloseSeconds;
            }
          } catch (e) {}
        }
        var expectedCloseSeconds = activeOpenSeconds !== null && timeframeSeconds !== null
          ? activeOpenSeconds + timeframeSeconds - 1
          : null;
        // A supplied close boundary is authoritative for a session-shortened
        // bar, but only when it is earlier than the fixed nominal close. Never
        // invent a session calendar from a weekend/maintenance gap.
        if (expectedCloseSeconds !== null && suppliedCloseSeconds !== null
            && suppliedCloseSeconds - 1 < expectedCloseSeconds) {
          expectedCloseSeconds = suppliedCloseSeconds - 1;
        }
        var replayCurrentDate = unwrap(r.currentDate());
        return {
          bars: bars,
          active_bar: activeBar,
          active_open_seconds: activeOpenSeconds,
          chart_resolution: chartResolution,
          nominal_timeframe_seconds: nominalTimeframeSeconds,
          timeframe_seconds: timeframeSeconds,
          supplied_close_seconds: suppliedCloseSeconds,
          expected_close_seconds: expectedCloseSeconds,
          replay_current_date: replayCurrentDate,
          replay_current_seconds: comparableTime(replayCurrentDate),
        };
      }
      function activeStateEligibility(state, expectation) {
        if (!state.active_bar || state.active_open_seconds === null) return { eligible: false, reason: 'missing_active_bar' };
        if (state.timeframe_seconds === null) return { eligible: false, reason: 'timeframe_not_derivable' };
        if (state.replay_current_seconds === null) return { eligible: false, reason: 'current_date_unavailable' };
        if (state.replay_current_seconds < state.expected_close_seconds) {
          return { eligible: false, reason: 'current_date_before_active_close' };
        }
        if (expectation && !sameTime(state.active_bar.time, expectation.next_active_open_time)) {
          return { eligible: false, reason: 'unexpected_next_active_bar' };
        }
        if (expectation && sameTime(state.replay_current_date, expectation.before_replay_current_date)) {
          return { eligible: false, reason: 'current_date_not_advanced' };
        }
        return { eligible: true, reason: null };
      }
      async function waitActiveBarReady(expectation) {
        var startMs = Date.now();
        var barStableCount = 0;
        var stableSinceMs = null;
        var stableBar = null;
        var pollAttempt = 0;
        var last = null;
        while (Date.now() - startMs <= activeReadyTimeoutMs) {
          pollAttempt += 1;
          if (!unwrap(r.isReplayStarted())) {
            return { ready: false, reason: 'replay_stopped', failure_code: 'active_bar_not_settled', last: last };
          }
          if (unwrap(r.isAutoplayStarted())) {
            return { ready: false, reason: 'autoplay_active', failure_code: 'active_bar_not_settled', last: last };
          }

          var state = inspectActiveBar();
          var eligibility = activeStateEligibility(state, expectation);
          last = {
            replay_current_date: state.replay_current_date,
            active_open_time: state.active_bar ? state.active_bar.time : null,
            timeframe_seconds: state.timeframe_seconds,
            expected_close_seconds: state.expected_close_seconds,
            bars: state.bars,
            ready_poll_attempt: pollAttempt,
            eligibility_reason: eligibility.reason,
            bar_stable_polls: barStableCount,
          };
          if (eligibility.eligible) {
            var sameStableBar = stableBar && sameBar(stableBar, state.active_bar);
            if (sameStableBar) {
              barStableCount += 1;
            } else {
              stableBar = state.active_bar;
              barStableCount = 1;
              stableSinceMs = Date.now();
            }
            last.bar_stable_polls = barStableCount;
            // The active Data Window is a live preview and can legitimately
            // change until doStep finalizes this timestamp. It is therefore
            // diagnostic-only in v4; the causal target-study gate happens
            // post-step against source._data.searchByTime(T). Here, settle_ms
            // proves only the replay clock and preview OHLCV are quiet enough
            // to issue exactly one manual step.
            if (barStableCount >= activeReadyStablePolls
                && stableSinceMs !== null
                && Date.now() - stableSinceMs >= settleMs) {
              return {
                ready: true,
                active_bar: state.active_bar,
                replay_current_date: state.replay_current_date,
                timeframe_seconds: state.timeframe_seconds,
                expected_close_seconds: state.expected_close_seconds,
                ready_poll_attempt: pollAttempt,
                stable_polls: barStableCount,
                study_stable_polls: null,
                study_snapshot: null,
                study_fingerprint: null,
                quiet_ms: Date.now() - stableSinceMs,
              };
            }
          } else {
            barStableCount = 0;
            stableSinceMs = null;
            stableBar = null;
          }
          await sleep(activeReadyPollIntervalMs);
        }
        return { ready: false, reason: 'timeout', failure_code: 'active_bar_not_settled', last: last };
      }

      var started = unwrap(r.isReplayStarted());
      if (!started) return result([], 0, failure('replay_not_started', 'preflight', 1, 'Replay is not started. Use replay_start first.'));
      if (unwrap(r.isAutoplayStarted())) {
        return result([], 0, failure('autoplay_active', 'preflight', 1, 'Stop Replay autoplay before using replay_capture_chunk.'));
      }

      var records = [];
      var stepsInvoked = 0;
      var nextStepExpectation = null;
      for (var sequence = 1; sequence <= requestedSteps; sequence += 1) {
        // This gate runs before every indicator/label observation and every
        // doStep().  It prevents a still-building Replay candle from being
        // mistaken for a completed historical bar.
        var activeReady = await waitActiveBarReady(nextStepExpectation);
        if (!activeReady.ready) {
          var readinessFailureCode = activeReady.failure_code || 'active_bar_not_settled';
          return result(records, stepsInvoked, failure(
            readinessFailureCode,
            'pre_step_ready',
            sequence,
            'The active replay bar did not reach its derived close time with stable OHLCV before the bounded readiness deadline.',
            {
              expected_next_active_open_time: nextStepExpectation ? nextStepExpectation.next_active_open_time : null,
              previous_replay_current_date: nextStepExpectation ? nextStepExpectation.before_replay_current_date : null,
              settle_ms: settleMs,
              active_ready_timeout_ms: activeReadyTimeoutMs,
              active_ready_poll_interval_ms: activeReadyPollIntervalMs,
              active_ready_stable_polls: activeReadyStablePolls,
              active_ready_study_stable_polls: activeReadyStudyStablePolls,
              readiness_reason: activeReady.reason,
              last_readiness: activeReady.last,
            }
          ));
        }

        var activeBar = activeReady.active_bar;
        var observedActiveOpenTime = activeBar.time;

        // Recheck the preview OHLCV/clock immediately before stepping. Active
        // Data Window/label state is captured only as diagnostic evidence here:
        // it belongs to a potentially partial preview row, whereas v4 features
        // are read later from the finalized historical row at this same time.
        var preStepState = inspectActiveBar();
        var preStepEligibility = activeStateEligibility(preStepState, nextStepExpectation);
        if (!preStepEligibility.eligible || !sameBar(activeBar, preStepState.active_bar)) {
          return result(records, stepsInvoked, failure(
            'active_bar_not_settled',
            'pre_step_final_check',
            sequence,
            'The active replay bar changed or its clock fell out of close-state before the final combined indicator/label snapshot; no step was issued.',
            {
              observed_active_open_time: observedActiveOpenTime,
              readiness_reason: preStepEligibility.reason,
              active_ready_bar: activeBar,
              final_active_state: preStepState,
            }
          ));
        }
        var finalStudySnapshot = readCombinedSnapshot(observedActiveOpenTime);
        var finalStudyFingerprint = combinedSnapshotFingerprint(finalStudySnapshot);
        var postStudyState = inspectActiveBar();
        var postStudyEligibility = activeStateEligibility(postStudyState, nextStepExpectation);
        if (!postStudyEligibility.eligible || !sameBar(activeBar, postStudyState.active_bar)
            || !sameBar(preStepState.active_bar, postStudyState.active_bar)
            || !sameTime(preStepState.replay_current_date, postStudyState.replay_current_date)) {
          return result(records, stepsInvoked, failure(
            'active_bar_not_settled',
            'pre_step_final_sandwich',
            sequence,
            'The active replay OHLCV or close-state clock drifted while reading the final combined indicator/label snapshot; no step was issued.',
            {
              observed_active_open_time: observedActiveOpenTime,
              pre_study_active_state: preStepState,
              post_study_active_state: postStudyState,
              readiness_reason: postStudyEligibility.reason,
            }
          ));
        }

        // The pre-step snapshot proves the preview UI had settled enough to
        // advance, but it is not a close-value record: TradingView can replace
        // the same timestamped OHLCV row during doStep(). Keep it only as an
        // audit fingerprint; final values are read by timestamp after closing.
        var preStepPreviewFingerprint = finalStudyFingerprint;
        var beforeReplayCurrentDate = postStudyState.replay_current_date;

        // Exactly one manual Replay step for this candidate record.  Autoplay is
        // never enabled, and an alignment failure below does not retry doStep().
        var maybeStep = r.doStep();
        stepsInvoked += 1;
        if (maybeStep && typeof maybeStep.then === 'function') await maybeStep;

        var aligned = null;
        var lastPostBars = [];
        var lastPostEvidence = null;
        var sawMatchingClosedTime = false;
        var stableClosedBar = null;
        var stableNextActiveOpenTime = null;
        var stableEvidenceFingerprint = null;
        var postCloseStableCount = 0;
        var postCloseStableSinceMs = null;
        for (var pollAttempt = 1; pollAttempt <= maxPollAttempts; pollAttempt += 1) {
          await sleep(pollIntervalMs);
          lastPostBars = readRecentBars();
          if (lastPostBars.length < 2) continue;
          var confirmedBar = lastPostBars[lastPostBars.length - 2];
          var nextActiveBar = lastPostBars[lastPostBars.length - 1];
          if (confirmedBar && nextActiveBar
              && sameTime(confirmedBar.time, observedActiveOpenTime)
              && isLaterTime(nextActiveBar.time, observedActiveOpenTime)) {
            sawMatchingClosedTime = true;
            // The matching timestamp may transition from a preview OHLCV row
            // to a final close after doStep(). Read all final strategy values
            // by that closed timestamp, never from the newly active Data
            // Window, and require the complete evidence to settle together.
            var closedStudySnapshot = readClosedStudySnapshot(observedActiveOpenTime);
            var postStepLabelSnapshot = readLabelSnapshot(nextActiveBar.time);
            var evidenceFingerprint = closedEvidenceFingerprint(
              closedStudySnapshot,
              postStepLabelSnapshot
            );
            lastPostEvidence = {
              confirmed_bar: confirmedBar,
              next_active_bar: nextActiveBar,
              closed_study_snapshot: closedStudySnapshot,
              raw_pine_labels: postStepLabelSnapshot.raw_pine_labels,
              evidence_fingerprint: evidenceFingerprint,
              stable_polls: postCloseStableCount,
            };
            if (evidenceFingerprint === null) {
              postCloseStableCount = 0;
              postCloseStableSinceMs = null;
              stableClosedBar = null;
              stableNextActiveOpenTime = null;
              stableEvidenceFingerprint = null;
              continue;
            }
            if (stableClosedBar && sameBar(stableClosedBar, confirmedBar)
                && sameTime(stableNextActiveOpenTime, nextActiveBar.time)
                && stableEvidenceFingerprint === evidenceFingerprint) {
              postCloseStableCount += 1;
            } else {
              stableClosedBar = confirmedBar;
              stableNextActiveOpenTime = nextActiveBar.time;
              stableEvidenceFingerprint = evidenceFingerprint;
              postCloseStableCount = 1;
              postCloseStableSinceMs = Date.now();
            }
            lastPostEvidence.stable_polls = postCloseStableCount;
            lastPostEvidence.quiet_ms = postCloseStableSinceMs === null
              ? null
              : Date.now() - postCloseStableSinceMs;
            if (postCloseStableCount >= postStepClosedBarStablePolls) {
              if (postCloseStableSinceMs !== null
                  && Date.now() - postCloseStableSinceMs >= settleMs) {
                aligned = {
                  confirmed_bar: confirmedBar,
                  next_active_bar: nextActiveBar,
                  confirmation_poll_attempt: pollAttempt,
                  closed_study_snapshot: closedStudySnapshot,
                  label_snapshot: postStepLabelSnapshot,
                  evidence_fingerprint: evidenceFingerprint,
                  stable_polls: postCloseStableCount,
                  quiet_ms: Date.now() - postCloseStableSinceMs,
                };
                break;
              }
            }
          } else {
            postCloseStableCount = 0;
            postCloseStableSinceMs = null;
            stableClosedBar = null;
            stableNextActiveOpenTime = null;
            stableEvidenceFingerprint = null;
          }
        }
        if (!aligned) {
          var postFailureCode = sawMatchingClosedTime
            ? 'post_step_closed_bar_not_settled'
            : 'post_step_alignment_timeout';
          return result(records, stepsInvoked, failure(
            postFailureCode,
            'post_step_confirmation',
            sequence,
            sawMatchingClosedTime
              ? 'The matching closed bar or its timestamped final study evidence did not remain stable after doStep.'
              : 'The pre-step active bar did not become postBars[-2] before the polling deadline.',
            {
              observed_active_open_time: observedActiveOpenTime,
              pre_step_active_bar: activeBar,
              last_post_bars: lastPostBars,
              last_post_evidence: lastPostEvidence,
              post_step_closed_bar_stable_polls: postStepClosedBarStablePolls,
              post_step_settle_ms: settleMs,
              mutating_steps_invoked: stepsInvoked,
            }
          ));
        }

        // The final row is stable. Scan PlotList only now, because a shape that
        // materializes while the same timestamp closes is first visible at the
        // next active bar—not retroactively at its signal bar.
        var postStepShapeScan = scanAvailablePlotshapeSignals();
        if (!postStepShapeScan.success) {
          return result(records, stepsInvoked, failure(
            'plotshape_signal_scan_failed',
            'post_step_final_shape_scan',
            sequence,
            'The finalized Trend PlotList could not be scanned after the matching bar closed.',
            {
              observed_active_open_time: observedActiveOpenTime,
              next_active_open_time: aligned.next_active_bar.time,
              shape_scan: postStepShapeScan,
            }
          ));
        }
        var postScanClosedStudySnapshot = readClosedStudySnapshot(observedActiveOpenTime);
        var postScanLabelSnapshot = readLabelSnapshot(aligned.next_active_bar.time);
        var postScanEvidenceFingerprint = closedEvidenceFingerprint(
          postScanClosedStudySnapshot,
          postScanLabelSnapshot
        );
        var finalPostBars = readRecentBars();
        var finalConfirmedBar = finalPostBars.length >= 2 ? finalPostBars[finalPostBars.length - 2] : null;
        var finalNextActiveBar = finalPostBars.length >= 1 ? finalPostBars[finalPostBars.length - 1] : null;
        if (postScanEvidenceFingerprint === null
            || postScanEvidenceFingerprint !== aligned.evidence_fingerprint
            || !finalConfirmedBar || !finalNextActiveBar
            || !sameBar(aligned.confirmed_bar, finalConfirmedBar)
            || !sameTime(aligned.next_active_bar.time, finalNextActiveBar.time)) {
          return result(records, stepsInvoked, failure(
            'post_step_closed_bar_not_settled',
            'post_step_final_sandwich',
            sequence,
            'The final closed OHLCV row, timestamped study values, shapes, or labels drifted during post-step confirmation.',
            {
              observed_active_open_time: observedActiveOpenTime,
              aligned_confirmed_bar: aligned.confirmed_bar,
              final_confirmed_bar: finalConfirmedBar,
              aligned_next_active_open_time: aligned.next_active_bar.time,
              final_next_active_open_time: finalNextActiveBar ? finalNextActiveBar.time : null,
              aligned_evidence_fingerprint: aligned.evidence_fingerprint,
              final_evidence_fingerprint: postScanEvidenceFingerprint,
            }
          ));
        }
        var shapeScanConsistency = activeShapeValuesMatchScan(
          postScanClosedStudySnapshot.shape_values,
          observedActiveOpenTime,
          postStepShapeScan.signals
        );
        if (!shapeScanConsistency.consistent) {
          return result(records, stepsInvoked, failure(
            'shape_not_settled',
            'post_step_final_shape_scan_consistency',
            sequence,
            'The finalized Trend PlotList row and full post-step scan disagree.',
            {
              observed_active_open_time: observedActiveOpenTime,
              next_active_open_time: aligned.next_active_bar.time,
              missing_active_shape_identities: shapeScanConsistency.missing_active_shape_identities,
              unexpected_active_scan_identities: shapeScanConsistency.unexpected_active_scan_identities,
            }
          ));
        }
        var rawStudyValues = postScanClosedStudySnapshot.raw_study_values;
        var shapeValues = postScanClosedStudySnapshot.shape_values;
        postScanLabelSnapshot.raw_pine_labels.target_open_time = observedActiveOpenTime;
        var plotshapeSignals = newlySeenPlotshapeSignals(
          postStepShapeScan.signals,
          observedActiveOpenTime,
          aligned.next_active_bar.time
        );
        var labelSnapshot = materializeLabels(
          postScanLabelSnapshot,
          seenLabelKeys,
          sequence - 1,
          aligned.next_active_bar.time,
          observedActiveOpenTime
        );
        var recordSeenShapeKeys = seenShapeKeysAfter();
        var recordSeenLabelKeys = seenLabelKeysAfter();

        records.push({
          schema_version: replayCaptureSchemaVersion,
          label_identity_version: replayLabelIdentityVersion,
          feature_phase: 'post_target_final',
          ohlcv_phase: 'post_target_final',
          sequence: sequence,
          capture_phase: 'pre_step_preview_confirmed_post_step_final',
          // The record candle is the final same-time bar. The preview is kept
          // separately so consumers cannot mistake its partial OHLCV or UI
          // indicators for a close-value strategy observation.
          active_bar: aligned.confirmed_bar,
          pre_step_active_bar: activeBar,
          observed_active_open_time: observedActiveOpenTime,
          target_open_time: observedActiveOpenTime,
          target_bar: aligned.confirmed_bar,
          availability_open_time: aligned.next_active_bar.time,
          pre_step_preview_study_fingerprint: preStepPreviewFingerprint,
          study_observation_phase: 'post_target_final',
          raw_study_values: rawStudyValues,
          shape_values: shapeValues,
          plotshape_signals: plotshapeSignals,
          plotshape_scan_phase: 'post_target_final',
          plotshape_scan_observed_active_open_time: observedActiveOpenTime,
          plotshape_scan_first_visible_open_time: aligned.next_active_bar.time,
          seen_shape_keys_after: recordSeenShapeKeys,
          shape_state_initialized_after: shapeStateInitialized,
          seen_label_keys_after: recordSeenLabelKeys,
          raw_pine_labels: labelSnapshot.raw_pine_labels,
          label_observation_open_time: aligned.next_active_bar.time,
          newly_visible_labels: labelSnapshot.newly_visible_labels,
          confirmed_bar: aligned.confirmed_bar,
          confirmed_closed_open_time: aligned.confirmed_bar.time,
          next_active_open_time: aligned.next_active_bar.time,
          confirmation_poll_attempt: aligned.confirmation_poll_attempt,
          post_step_closed_bar_stable_polls: aligned.stable_polls,
          post_target_stable_polls: aligned.stable_polls,
          post_target_quiet_ms: aligned.quiet_ms,
          post_step_settle_ms: settleMs,
          replay_current_date_before_step: beforeReplayCurrentDate,
          active_bar_ready_current_date: activeReady.replay_current_date,
          active_bar_ready_poll_attempt: activeReady.ready_poll_attempt,
          active_bar_ready_stable_polls: activeReady.stable_polls,
          active_study_values_ready_stable_polls: activeReady.study_stable_polls,
          active_bar_ready_quiet_ms: activeReady.quiet_ms,
          active_bar_ready_timeframe_seconds: activeReady.timeframe_seconds,
          active_bar_ready_expected_close_seconds: activeReady.expected_close_seconds,
          step_count: 1,
        });
        nextStepExpectation = {
          next_active_open_time: aligned.next_active_bar.time,
          before_replay_current_date: beforeReplayCurrentDate,
        };
      }
      return result(records, stepsInvoked, null);
    })()
  `;
}

/**
 * Collect a small checkpointable run of manually stepped Replay bars.  The
 * failure case is deliberately an ordinary structured result (success:true,
 * complete:false), so callers can persist already-confirmed rows.
 */
export async function captureChunk({
  bars,
  poll_attempts,
  poll_interval_ms,
  settle_ms,
  active_ready_timeout_ms,
  active_ready_poll_interval_ms,
  active_ready_stable_polls,
  active_ready_study_stable_polls,
  post_step_closed_bar_stable_polls,
  known_label_keys,
  known_shape_keys,
  shape_state_initialized,
  _deps,
} = {}) {
  const steps = validateCaptureChunkBars(bars);
  const pollAttempts = validateCapturePollAttempts(poll_attempts);
  const pollIntervalMs = validateCapturePollInterval(poll_interval_ms);
  const settleMs = validateCaptureSettleMs(settle_ms);
  const activeReadyTimeoutMs = validateActiveReadyTimeoutMs(active_ready_timeout_ms);
  const activeReadyPollIntervalMs = validateActiveReadyPollIntervalMs(active_ready_poll_interval_ms);
  const activeReadyStablePolls = validateActiveReadyStablePolls(active_ready_stable_polls);
  const activeReadyStudyStablePolls = validateActiveReadyStudyStablePolls(active_ready_study_stable_polls);
  const postStepClosedBarStablePolls = validatePostStepClosedBarStablePolls(
    post_step_closed_bar_stable_polls
  );
  const shapeStateInitialized = validateShapeStateInitialized(shape_state_initialized);
  const knownLabelKeys = validateReplayLabelCheckpointKeys(known_label_keys, 'known_label_keys');
  const knownShapeKeys = validateReplayCaptureCheckpointKeys(known_shape_keys, 'known_shape_keys');
  if (!shapeStateInitialized && knownShapeKeys.length > 0) {
    throw new Error('known_shape_keys must be empty when shape_state_initialized is false');
  }
  const { evaluateAsync, getReplayApi } = _resolve(_deps);
  const replayApiPath = await getReplayApi();
  const raw = await evaluateAsync(buildReplayCaptureChunkExpression({
    replayApiPath,
    bars: steps,
    pollAttempts,
    pollIntervalMs,
    settleMs,
    activeReadyTimeoutMs,
    activeReadyPollIntervalMs,
    activeReadyStablePolls,
    activeReadyStudyStablePolls,
    postStepClosedBarStablePolls,
    knownLabelKeys,
    knownShapeKeys,
    shapeStateInitialized,
  }));
  return validateReplayCaptureChunkResult(raw, steps);
}

export async function start({ date, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const wait = typeof _deps?.wait === 'function'
    ? _deps.wait
    : ms => new Promise(resolve => setTimeout(resolve, ms));
  const now = typeof _deps?.now === 'function' ? _deps.now : Date.now;
  const log = typeof _deps?.log === 'function' ? _deps.log : logReplayStart;
  const requestedDate = date || '(first available)';
  const timestamp = date ? new Date(date).getTime() : null;
  if (date && isNaN(timestamp)) throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD format.`);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) {
    log('failure', { failed_stage: 'availability', reason: 'replay_not_available' });
    throw new Error('Replay is not available for the current symbol/timeframe');
  }

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() waits internally for ReadyToPlay. Do not invoke it until the
  // UI reports ready: a pending selection Promise cannot be cancelled by CDP.
  const readyToPlayExpression = wv(`${rp}.isReadyToPlay()`);
  const readinessStartedAt = now();
  let readyToPlay = false;
  let readinessAttempts = 0;
  log('readiness', { status: 'waiting', timeout_ms: REPLAY_START_READY_TIMEOUT_MS });
  while (now() - readinessStartedAt < REPLAY_START_READY_TIMEOUT_MS) {
    readinessAttempts += 1;
    readyToPlay = Boolean(await evaluate(readyToPlayExpression));
    if (readyToPlay) break;
    await wait(REPLAY_START_POLL_INTERVAL_MS);
  }
  if (!readyToPlay) {
    const elapsedMs = now() - readinessStartedAt;
    log('failure', {
      failed_stage: 'readiness',
      reason: 'ready_to_play_timeout',
      attempts: readinessAttempts,
      elapsed_ms: elapsedMs,
    });
    try {
      await evaluate(`${rp}.stopReplay()`);
      log('failure', { failed_stage: 'readiness_cleanup', cleanup: 'stop_replay_sent' });
    } catch (err) {
      log('failure', { failed_stage: 'readiness_cleanup', cleanup_error: err.message });
    }
    throw new Error(`Replay start timed out waiting for Replay UI readiness after ${REPLAY_START_READY_TIMEOUT_MS}ms; no date selection was sent.`);
  }
  log('readiness', {
    status: 'ready',
    attempts: readinessAttempts,
    elapsed_ms: now() - readinessStartedAt,
  });

  // Do not await this Promise through Runtime.evaluate. The causal completion
  // check below is started + currentDate, which remains bounded even if the
  // page's selection Promise is stuck during an unexpected UI transition.
  let selectionExpression;
  if (date) {
    selectionExpression = `${rp}.selectDate(${timestamp})`;
  } else {
    selectionExpression = `${rp}.selectFirstAvailableDate()`;
  }
  log('selection', { status: 'sending', date: requestedDate });
  try {
    const selection = await evaluate(`(function() {
      var pending = ${selectionExpression};
      if (pending && typeof pending.then === 'function') {
        pending.catch(function(error) {
          try { console.error('tv-mcp replay_start selection rejected', error && (error.message || String(error))); } catch (ignored) {}
        });
      }
      return { promise: !!(pending && typeof pending.then === 'function') };
    })()`);
    log('selection', { status: 'sent', date: requestedDate, promise: selection?.promise === true });
  } catch (err) {
    log('failure', { failed_stage: 'selection', selection_error: err.message });
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    throw new Error(`Replay date selection failed: ${err.message}`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // currentDate is the causal start confirmation; isReplayStarted alone is not.
  const confirmationStartedAt = now();
  let started = false;
  let currentDate = null;
  let confirmationAttempts = 0;
  log('started', { status: 'waiting', timeout_ms: REPLAY_START_CONFIRM_TIMEOUT_MS });
  while (now() - confirmationStartedAt < REPLAY_START_CONFIRM_TIMEOUT_MS) {
    confirmationAttempts += 1;
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate != null) {
      log('started', {
        status: 'ready',
        attempts: confirmationAttempts,
        elapsed_ms: now() - confirmationStartedAt,
        current_date: currentDate,
      });
      return { success: true, replay_started: true, date: requestedDate, current_date: currentDate };
    }
    await wait(REPLAY_START_POLL_INTERVAL_MS);
  }

  const failureReason = started ? 'current_date_unavailable' : 'replay_not_started';
  log('failure', {
    failed_stage: 'started',
    reason: failureReason,
    attempts: confirmationAttempts,
    elapsed_ms: now() - confirmationStartedAt,
    current_date: currentDate,
  });
  try { await evaluate(`${rp}.stopReplay()`); } catch {}
  if (started) {
    throw new Error(`Replay start timed out: replay started but currentDate did not become available within ${REPLAY_START_CONFIRM_TIMEOUT_MS}ms. Try a more recent date or a higher timeframe (e.g., Daily).`);
  }
  throw new Error(`Replay failed to start within ${REPLAY_START_CONFIRM_TIMEOUT_MS}ms. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).`);
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, evaluateAsync, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  // stopReplay can be asynchronous. Await the public API result in page
  // context, then prove that Replay actually left its active state. This
  // prevents a stale private "stopping" flag from becoming a false success.
  await evaluateAsync(`
    (async function() {
      var result = ${rp}.stopReplay();
      if (result && typeof result.then === 'function') await result;
      return result;
    })()
  `);
  const wait = typeof _deps?.wait === 'function'
    ? _deps.wait
    : ms => new Promise(resolve => setTimeout(resolve, ms));
  let recoveryAttempted = false;
  // Check the public API once before touching a private recovery hook. Normal
  // stops never reach the hook; it exists solely for the verified stale
  // `_isReplayStopping` state where public stopReplay() becomes a no-op.
  let stillStarted = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!stillStarted) {
    return { success: true, action: 'replay_stopped', stop_poll_attempt: 1, recovery_attempted: false };
  }
  const recovery = await evaluateAsync(`
    (async function() {
      function unwrap(value) {
        return (value && typeof value === 'object' && typeof value.value === 'function') ? value.value() : value;
      }
      var replay = ${rp};
      // Re-check in the page context: a public stop can finish in the narrow
      // interval between Node's probe and this recovery attempt.
      if (!unwrap(replay.isReplayStarted())) return { attempted: false, reason: 'already_stopped' };
      var manager = null;
      try {
        var activeWidgetValue = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV;
        var activeWidget = activeWidgetValue && typeof activeWidgetValue.value === 'function'
          ? activeWidgetValue.value() : null;
        var chartWidget = activeWidget && activeWidget._chartWidget;
        var controller = chartWidget && chartWidget._replayUIController;
        manager = controller && controller._replayManager;
      } catch (e) {}
      if (!manager || manager._isReplayStopping !== true || typeof manager._stopReplay !== 'function') {
        return { attempted: false, reason: 'stuck_manager_unavailable' };
      }
      // This is intentionally the only private mutation: it is guarded by an
      // active replay plus the known stuck state, follows a public stop call,
      // and invokes the manager's stop routine exactly once.
      manager._isReplayStopping = false;
      var result = manager._stopReplay();
      if (result && typeof result.then === 'function') await result;
      return { attempted: true };
    })()
  `);
  recoveryAttempted = recovery && recovery.attempted === true;
  for (let attempt = 2; attempt <= REPLAY_STOP_POLL_ATTEMPTS; attempt += 1) {
    stillStarted = await evaluate(wv(`${rp}.isReplayStarted()`));
    if (!stillStarted) {
      return { success: true, action: 'replay_stopped', stop_poll_attempt: attempt, recovery_attempted: recoveryAttempted };
    }
    if (attempt < REPLAY_STOP_POLL_ATTEMPTS) await wait(REPLAY_STOP_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Replay stop did not complete within ${REPLAY_STOP_POLL_ATTEMPTS * REPLAY_STOP_POLL_INTERVAL_MS}ms; replay remains active.`
  );
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
