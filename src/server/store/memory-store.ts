import { randomUUID } from "node:crypto";

import type { SingleMeta } from "@/shared/types";
import { metaKey as resolveMetaKey } from "@/server/store/keyspace";

type MemoryLock = {
  token: string;
  expiresAt: number;
};

type MemoryValue = {
  value: string;
  expiresAt: number | null;
};

export class MemoryStore {
  readonly name = "memory";

  private readonly values = new Map<string, MemoryValue>();

  private readonly locks = new Map<string, MemoryLock>();

  constructor(private readonly configuredMetaKey?: string) {}

  private getMetaKey(): string {
    return this.configuredMetaKey ?? resolveMetaKey();
  }

  private readStoredMeta(): SingleMeta | null {
    const entry = this.values.get(this.getMetaKey());
    if (!entry) {
      return null;
    }

    try {
      return JSON.parse(entry.value) as SingleMeta;
    } catch {
      return null;
    }
  }

  async getMeta(): Promise<SingleMeta | null> {
    const meta = this.readStoredMeta();
    return meta ? structuredClone(meta) : null;
  }

  async setMeta(meta: SingleMeta): Promise<void> {
    this.values.set(this.getMetaKey(), {
      value: JSON.stringify(meta),
      expiresAt: null,
    });
  }

  async createMetaIfAbsent(meta: SingleMeta): Promise<boolean> {
    if (this.values.has(this.getMetaKey())) {
      return false;
    }

    this.values.set(this.getMetaKey(), {
      value: JSON.stringify(meta),
      expiresAt: null,
    });
    return true;
  }

  async compareAndSetMeta(expectedVersion: number, next: SingleMeta): Promise<boolean> {
    const current = this.readStoredMeta();
    if (!current) {
      return false;
    }

    const currentVersion =
      typeof current.version === "number" && Number.isSafeInteger(current.version)
        ? current.version
        : 1;

    if (currentVersion !== expectedVersion) {
      return false;
    }

    this.values.set(this.getMetaKey(), {
      value: JSON.stringify(next),
      expiresAt: null,
    });
    return true;
  }

  async getValue<T>(key: string): Promise<T | null> {
    this.gc();
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }

    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }

  async hasValue(key: string): Promise<boolean> {
    this.gc();
    return this.values.has(key);
  }

  async setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.gc();
    this.values.set(key, {
      value: JSON.stringify(value),
      expiresAt: typeof ttlSeconds === "number" ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async compareAndSetValue<T extends { revision: number }>(
    key: string,
    expectedRevision: number | null,
    next: T,
  ): Promise<boolean> {
    this.gc();
    const current = this.values.get(key);
    if (expectedRevision === null) {
      if (current) return false;
    } else {
      if (!current) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(current.value);
      } catch {
        return false;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { revision?: unknown }).revision !== expectedRevision
      ) {
        return false;
      }
    }

    this.values.set(key, {
      value: JSON.stringify(next),
      expiresAt: null,
    });
    return true;
  }

  async deleteValue(key: string): Promise<void> {
    this.values.delete(key);
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    this.gc();
    const existing = this.locks.get(key);
    if (existing) {
      return null;
    }

    const token = randomUUID();
    this.locks.set(key, {
      token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    return token;
  }

  async renewLock(key: string, token: string, ttlSeconds: number): Promise<boolean> {
    this.gc();

    const current = this.locks.get(key);
    if (!current || current.token !== token) {
      return false;
    }

    this.locks.set(key, {
      token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    return true;
  }

  async setValueIfLockHeld<T>(
    lockKey: string,
    token: string,
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    this.gc();
    const current = this.locks.get(lockKey);
    if (!current || current.token !== token) {
      return false;
    }

    this.values.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    const current = this.locks.get(key);
    if (current?.token === token) {
      this.locks.delete(key);
    }
  }

  private gc(): void {
    const now = Date.now();

    for (const [key, value] of this.locks.entries()) {
      if (value.expiresAt <= now) {
        this.locks.delete(key);
      }
    }

    for (const [key, value] of this.values.entries()) {
      if (value.expiresAt !== null && value.expiresAt <= now) {
        this.values.delete(key);
      }
    }
  }
}
