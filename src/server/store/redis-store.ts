import { randomUUID } from "node:crypto";

import Redis from "ioredis";

import type { SingleMeta } from "@/shared/types";
import { getOpenclawInstanceId, getStoreEnv } from "@/server/env";
import {
  assertScopedRedisKey,
  metaKey as resolveMetaKey,
} from "@/server/store/keyspace";

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const RENEW_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

const SET_VALUE_IF_LOCK_HELD_LUA = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("set", KEYS[2], ARGV[2], "EX", tonumber(ARGV[3]))
return 1
`;

const CAS_META_LUA = `
local current = redis.call("get", KEYS[1])
if not current then
  return -1
end

local decoded = cjson.decode(current)
local currentVersion = tonumber(decoded["version"])
if not currentVersion then
  currentVersion = 1
end

if currentVersion ~= tonumber(ARGV[1]) then
  return 0
end

redis.call("set", KEYS[1], ARGV[2])
return 1
`;

const CAS_VALUE_LUA = `
local current = redis.call("get", KEYS[1])
local expected = ARGV[1]

if expected == "absent" then
  if current then
    return 0
  end
else
  if not current then
    return 0
  end

  local ok, decoded = pcall(cjson.decode, current)
  if not ok or type(decoded) ~= "table" or tonumber(decoded["revision"]) ~= tonumber(expected) then
    return 0
  end
end

redis.call("set", KEYS[1], ARGV[2])
return 1
`;

const CAS_VALUE_TOKEN_LUA = `
local current = redis.call("get", KEYS[1])
if not current or current ~= ARGV[1] then
  return 0
end

redis.call("set", KEYS[1], ARGV[2])
return 1
`;

const DELETE_VALUES_IF_TOKEN_LUA = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
  return 0
end

if #KEYS > 1 then
  redis.call("del", unpack(KEYS, 2))
end
return 1
`;

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

let sharedClient: Redis | null = null;

function getSharedClient(url: string): Redis {
  if (sharedClient) return sharedClient;
  sharedClient = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
  });
  return sharedClient;
}

export class RedisStore {
  readonly name = "redis";

  constructor(
    private readonly redis: Redis,
    private readonly configuredMetaKey?: string,
  ) {}

  private getMetaKey(): string {
    const key = this.configuredMetaKey ?? resolveMetaKey();
    if (this.configuredMetaKey && process.env.NODE_ENV !== "test") {
      throw new Error("configuredMetaKey is only supported in test mode.");
    }
    assertScopedRedisKey(key);
    return key;
  }

  private validateMetaOwnership(meta: SingleMeta): SingleMeta {
    const instanceId = getOpenclawInstanceId();
    if (meta.id !== instanceId) {
      throw new Error(
        `Refusing meta for instance "${meta.id}" while current instance is "${instanceId}".`,
      );
    }
    return meta;
  }

  static fromEnv(): RedisStore | null {
    const env = getStoreEnv();
    if (!env) {
      return null;
    }

    return new RedisStore(getSharedClient(env.url));
  }

  async getMeta(): Promise<SingleMeta | null> {
    const raw = await this.redis.get(this.getMetaKey());
    if (!raw) {
      return null;
    }

    let parsed: SingleMeta;
    try {
      parsed = JSON.parse(raw) as SingleMeta;
    } catch {
      return null;
    }

    return this.validateMetaOwnership(parsed);
  }

  async setMeta(meta: SingleMeta): Promise<void> {
    this.validateMetaOwnership(meta);
    await this.redis.set(this.getMetaKey(), JSON.stringify(meta));
  }

  async createMetaIfAbsent(meta: SingleMeta): Promise<boolean> {
    this.validateMetaOwnership(meta);
    const result = await this.redis.set(
      this.getMetaKey(),
      JSON.stringify(meta),
      "NX",
    );
    return result === "OK";
  }

  async compareAndSetMeta(
    expectedVersion: number,
    next: SingleMeta,
  ): Promise<boolean> {
    this.validateMetaOwnership(next);
    const result = await this.redis.eval(
      CAS_META_LUA,
      1,
      this.getMetaKey(),
      String(expectedVersion),
      JSON.stringify(next),
    );

    return toNumber(result) === 1;
  }

  async getValue<T>(key: string): Promise<T | null> {
    assertScopedRedisKey(key);
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async getValueState<T>(key: string): Promise<
    | { status: "absent" }
    | { status: "present"; value: T | null; token: string }
  > {
    assertScopedRedisKey(key);
    const raw = await this.redis.get(key);
    if (raw === null) return { status: "absent" };
    try {
      return {
        status: "present",
        value: JSON.parse(raw) as T,
        token: raw,
      };
    } catch {
      return { status: "present", value: null, token: raw };
    }
  }

  async hasValue(key: string): Promise<boolean> {
    assertScopedRedisKey(key);
    return (await this.redis.exists(key)) === 1;
  }

  async setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    assertScopedRedisKey(key);
    const payload = JSON.stringify(value);
    if (typeof ttlSeconds === "number") {
      await this.redis.set(key, payload, "EX", ttlSeconds);
      return;
    }

    await this.redis.set(key, payload);
  }

  async compareAndSetValue<T extends { revision: number }>(
    key: string,
    expectedRevision: number | null,
    next: T,
  ): Promise<boolean> {
    assertScopedRedisKey(key);
    const result = await this.redis.eval(
      CAS_VALUE_LUA,
      1,
      key,
      expectedRevision === null ? "absent" : String(expectedRevision),
      JSON.stringify(next),
    );
    return toNumber(result) === 1;
  }

  async compareAndSetValueToken<T>(
    key: string,
    expectedToken: string,
    next: T,
  ): Promise<boolean> {
    assertScopedRedisKey(key);
    const result = await this.redis.eval(
      CAS_VALUE_TOKEN_LUA,
      1,
      key,
      expectedToken,
      JSON.stringify(next),
    );
    return toNumber(result) === 1;
  }

  async deleteValuesIfValueToken(
    ownerKey: string,
    expectedToken: string,
    keys: readonly string[],
  ): Promise<boolean> {
    assertScopedRedisKey(ownerKey);
    for (const key of keys) assertScopedRedisKey(key);
    const result = await this.redis.eval(
      DELETE_VALUES_IF_TOKEN_LUA,
      1 + keys.length,
      ownerKey,
      ...keys,
      expectedToken,
    );
    return toNumber(result) === 1;
  }

  async deleteValue(key: string): Promise<void> {
    assertScopedRedisKey(key);
    await this.redis.del(key);
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    assertScopedRedisKey(key);
    const token = randomUUID();
    const result = await this.redis.set(key, token, "EX", ttlSeconds, "NX");

    return result === "OK" ? token : null;
  }

  async renewLock(
    key: string,
    token: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    assertScopedRedisKey(key);
    const result = await this.redis.eval(
      RENEW_LOCK_LUA,
      1,
      key,
      token,
      String(ttlSeconds),
    );

    return toNumber(result) > 0;
  }

  async setValueIfLockHeld<T>(
    lockKey: string,
    token: string,
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    assertScopedRedisKey(lockKey);
    assertScopedRedisKey(key);
    const result = await this.redis.eval(
      SET_VALUE_IF_LOCK_HELD_LUA,
      2,
      lockKey,
      key,
      token,
      JSON.stringify(value),
      String(ttlSeconds),
    );

    return toNumber(result) > 0;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    assertScopedRedisKey(key);
    await this.redis.eval(RELEASE_LOCK_LUA, 1, key, token);
  }
}
