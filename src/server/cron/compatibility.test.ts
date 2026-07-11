import assert from "node:assert/strict";
import test from "node:test";

import {
  CRON_PROJECTION_CAPABILITY,
  supportsCronProjectionBundleIdentity,
  type CronProjectionBundleIdentity,
} from "@/server/cron/compatibility";

const identity: CronProjectionBundleIdentity = {
  packageSpec: "openclaw@2026.7.2-beta.1",
  version: "2026.7.2-beta.1",
  forkSha: "a".repeat(40),
  upstreamSha: "b".repeat(40),
  canonicalSha256: "c".repeat(64),
  capabilities: [CRON_PROJECTION_CAPABILITY],
  verified: true,
};

test("cron projection requires an exact verified capable bundle identity", () => {
  assert.equal(
    supportsCronProjectionBundleIdentity(identity, identity.packageSpec),
    true,
  );
  assert.equal(supportsCronProjectionBundleIdentity(null, identity.packageSpec), false);
  assert.equal(
    supportsCronProjectionBundleIdentity(
      { ...identity, verified: false },
      identity.packageSpec,
    ),
    false,
  );
  assert.equal(
    supportsCronProjectionBundleIdentity(
      { ...identity, capabilities: [] },
      identity.packageSpec,
    ),
    false,
  );
  assert.equal(
    supportsCronProjectionBundleIdentity(identity, "openclaw@2026.7.2"),
    false,
  );
  assert.equal(
    supportsCronProjectionBundleIdentity(
      { ...identity, packageSpec: "openclaw@latest" },
      "openclaw@latest",
    ),
    false,
  );
  assert.equal(
    supportsCronProjectionBundleIdentity(
      { ...identity, forkSha: "unverified" },
      identity.packageSpec,
    ),
    false,
  );
});
