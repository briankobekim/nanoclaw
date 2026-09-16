/**
 * `record_usage` delivery action (docs/specs/usage-digest/plan.md §4.2).
 *
 * The payload is untrusted telemetry written by the agent container. Who
 * the turn belongs to, which provider ran it and which model was configured
 * all come from host-owned state; every payload field is bounded and
 * validated; anything malformed is dropped with a warning naming the field
 * and never blocks the row behind it. Redelivery of the same turn is a no-op.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export const RECORD_USAGE_ACTION = 'record_usage';
export const TOKEN_MAX = 1_000_000_000;
export const COST_MAX = 10_000;
export const MODEL_USAGE_MAX_KEYS = 8;
export const PAYLOAD_MAX_BYTES = 8 * 1024;
export const OCCURRED_AT_SKEW_MS = 24 * 60 * 60 * 1000;
export const RECORDS_PER_SESSION_PER_HOUR = 120;

const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_KEY_RE = /^[A-Za-z0-9._:/-]{1,64}$/;

interface TokenSet {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number | null;
}

interface ValidUsage extends TokenSet {
  model_usage: Record<string, TokenSet>;
  duration_ms: number | null;
  num_turns: number | null;
}

interface ValidRecord {
  turnId: string;
  reported: boolean;
  isError: boolean;
  occurredAt: string;
  usage: ValidUsage | null;
}

class RecordShapeError extends Error {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = 'RecordShapeError';
  }
}

function tokenField(obj: Record<string, unknown>, field: string, prefix: string): number {
  const v = obj[field];
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > TOKEN_MAX) {
    throw new RecordShapeError(`${prefix}${field}`, `must be an integer in [0, ${TOKEN_MAX}]`);
  }
  return v;
}

function costField(obj: Record<string, unknown>, prefix: string): number | null {
  const v = obj.cost_usd;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > COST_MAX) {
    throw new RecordShapeError(`${prefix}cost_usd`, `must be null or a finite number in [0, ${COST_MAX}]`);
  }
  return v;
}

function optionalCount(obj: Record<string, unknown>, field: string): number | null {
  const v = obj[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > TOKEN_MAX) {
    throw new RecordShapeError(field, `must be an integer in [0, ${TOKEN_MAX}]`);
  }
  return v;
}

function tokenSet(obj: unknown, prefix: string): TokenSet {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new RecordShapeError(prefix.replace(/\.$/, '') || 'usage', 'must be an object');
  }
  const o = obj as Record<string, unknown>;
  return {
    input_tokens: tokenField(o, 'input_tokens', prefix),
    output_tokens: tokenField(o, 'output_tokens', prefix),
    cache_read_tokens: tokenField(o, 'cache_read_tokens', prefix),
    cache_creation_tokens: tokenField(o, 'cache_creation_tokens', prefix),
    cost_usd: costField(o, prefix),
  };
}

/** Pure shape validation. Throws RecordShapeError naming the offending field. */
export function validateUsageRecord(content: Record<string, unknown>, ingestedAt: Date): ValidRecord {
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > PAYLOAD_MAX_BYTES) {
    throw new RecordShapeError('payload', `exceeds ${PAYLOAD_MAX_BYTES} bytes`);
  }
  const turnId = content.turn_id;
  if (typeof turnId !== 'string' || !TURN_ID_RE.test(turnId)) {
    throw new RecordShapeError('turn_id', 'must match ^[A-Za-z0-9._:-]{1,128}$');
  }
  if (typeof content.reported !== 'boolean') throw new RecordShapeError('reported', 'must be a boolean');
  if (typeof content.is_error !== 'boolean') throw new RecordShapeError('is_error', 'must be a boolean');
  const reported = content.reported;
  if (reported && content.usage === undefined) throw new RecordShapeError('usage', 'required when reported');
  if (!reported && content.usage !== undefined) throw new RecordShapeError('usage', 'forbidden when not reported');

  let occurredAt = ingestedAt.toISOString();
  const rawOccurred = content.occurred_at;
  if (typeof rawOccurred === 'string' && Number.isFinite(Date.parse(rawOccurred))) {
    const skew = Math.abs(Date.parse(rawOccurred) - ingestedAt.getTime());
    if (skew <= OCCURRED_AT_SKEW_MS) occurredAt = new Date(Date.parse(rawOccurred)).toISOString();
    else log.info('record_usage: occurred_at outside ±24h of ingest; using ingest time', { occurred_at: rawOccurred });
  } else {
    log.info('record_usage: occurred_at missing or unparsable; using ingest time', { occurred_at: rawOccurred });
  }

  let usage: ValidUsage | null = null;
  if (reported) {
    const base = tokenSet(content.usage, 'usage.');
    const u = content.usage as Record<string, unknown>;
    const rawModels = u.model_usage ?? {};
    if (typeof rawModels !== 'object' || rawModels === null || Array.isArray(rawModels)) {
      throw new RecordShapeError('model_usage', 'must be an object');
    }
    const keys = Object.keys(rawModels as object);
    if (keys.length > MODEL_USAGE_MAX_KEYS) {
      throw new RecordShapeError('model_usage', `at most ${MODEL_USAGE_MAX_KEYS} models`);
    }
    const models: Record<string, TokenSet> = {};
    for (const key of keys) {
      if (!MODEL_KEY_RE.test(key)) throw new RecordShapeError('model_usage', 'model key has disallowed characters');
      models[key] = tokenSet((rawModels as Record<string, unknown>)[key], `model_usage.${key}.`);
    }
    usage = {
      ...base,
      model_usage: models,
      duration_ms: optionalCount(u, 'duration_ms'),
      num_turns: optionalCount(u, 'num_turns'),
    };
  }
  return { turnId, reported, isError: content.is_error, occurredAt, usage };
}

async function recordUsage(content: Record<string, unknown>, session: Session): Promise<void> {
  const ingestedAt = new Date();
  let record: ValidRecord;
  try {
    record = validateUsageRecord(content, ingestedAt);
  } catch (err) {
    if (err instanceof RecordShapeError) {
      log.warn('record_usage dropped: malformed record', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        field: err.field,
        detail: err.message,
      });
      return;
    }
    throw err;
  }

  const db = getDb();
  const hourAgo = new Date(ingestedAt.getTime() - 60 * 60 * 1000).toISOString();
  const recent = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM usage_turns WHERE session_id = ? AND ingested_at > ?',
    session.id,
    hourAgo,
  );
  if ((recent?.n ?? 0) >= RECORDS_PER_SESSION_PER_HOUR) {
    log.warn('record_usage dropped: rate cap for this session reached', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      cap: RECORDS_PER_SESSION_PER_HOUR,
    });
    return;
  }

  // Provider and model are host-owned facts; a payload that names others is only logged.
  const config = await getContainerConfig(session.agent_group_id);
  const provider = session.agent_provider ?? config?.provider ?? 'unknown';
  const model = config?.model ?? 'unknown';
  if (
    (typeof content.provider === 'string' && content.provider !== provider) ||
    (typeof content.model === 'string' && content.model !== model)
  ) {
    log.info('record_usage: payload provider/model ignored in favour of host configuration', {
      sessionId: session.id,
      payloadProvider: content.provider,
      payloadModel: content.model,
      provider,
      model,
    });
  }

  const u = record.usage;
  const result = await db.run(
    `INSERT OR IGNORE INTO usage_turns
       (session_id, turn_id, agent_group_id, provider, model, reported, is_error, cost_usd,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model_usage_json,
        duration_ms, num_turns, occurred_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    session.id,
    record.turnId,
    session.agent_group_id,
    provider,
    model,
    record.reported ? 1 : 0,
    record.isError ? 1 : 0,
    u?.cost_usd ?? null,
    u?.input_tokens ?? 0,
    u?.output_tokens ?? 0,
    u?.cache_read_tokens ?? 0,
    u?.cache_creation_tokens ?? 0,
    JSON.stringify(u?.model_usage ?? {}),
    u?.duration_ms ?? null,
    u?.num_turns ?? null,
    record.occurredAt,
    ingestedAt.toISOString(),
  );
  if (result.changes === 0) {
    log.info('record_usage: duplicate turn ignored', { sessionId: session.id, turnId: record.turnId });
  }
}

registerDeliveryAction(
  RECORD_USAGE_ACTION,
  recordUsage,
  unguarded(
    'record_usage has no parameter an owner could meaningfully approve per turn; the boundary is closed by validation and by host-derived attribution, provider and model, not by a tap',
  ),
);
