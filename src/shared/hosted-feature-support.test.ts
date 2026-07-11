import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_FEATURE_SUPPORT_ENTRIES,
  HOSTED_FEATURE_SUPPORT_MATRIX,
  getHostedFeatureSupportMatrix,
} from "@/shared/hosted-feature-support";

test("hosted feature support matrix is the single exported source of truth", () => {
  const matrix = getHostedFeatureSupportMatrix();

  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.generatedFrom, "src/shared/hosted-feature-support.ts");
  assert.equal(matrix.docsPath, "docs/getting-started/hosted-feature-support.md");
  assert.deepEqual(matrix, HOSTED_FEATURE_SUPPORT_MATRIX);
  assert.equal(matrix.entries.length, HOSTED_FEATURE_SUPPORT_ENTRIES.length);
});

test("hosted feature support matrix covers the expected OpenClaw feature gaps", () => {
  const byId = new Map(HOSTED_FEATURE_SUPPORT_MATRIX.entries.map((entry) => [entry.id, entry]));

  assert.equal(byId.get("channel-slack")?.hostedStatus, "supported");
  assert.equal(byId.get("channel-telegram")?.hostedStatus, "supported");
  assert.equal(byId.get("channel-discord")?.hostedStatus, "not-supported");
  assert.equal(byId.get("channel-whatsapp")?.hostedStatus, "not-supported");
  assert.equal(byId.get("channels-upstream-rest")?.hostedStatus, "upstream-only");
  assert.equal(byId.get("companion-devices")?.hostedStatus, "upstream-only");
  assert.equal(byId.get("voice-canvas")?.hostedStatus, "upstream-only");
  assert.equal(byId.get("plugins-skills-bundled")?.hostedStatus, "bundled-only");
  assert.equal(byId.get("mcp-browser-tools")?.hostedStatus, "bundled-only");
  assert.equal(byId.get("cron-scheduled-jobs")?.hostedStatus, "experimental");
  assert.equal(byId.get("model-provider-gateway")?.hostedStatus, "supported");
});

test("unsupported hosted feature entries include alternative paths or next actions", () => {
  for (const entry of HOSTED_FEATURE_SUPPORT_MATRIX.entries) {
    assert.ok(entry.feature.length > 0, `${entry.id} has a feature label`);
    assert.ok(entry.verificationSignal.length > 0, `${entry.id} has a verification signal`);
    assert.ok(entry.nextAction.length > 0, `${entry.id} has a next action`);

    if (["upstream-only", "not-supported", "bundled-only"].includes(entry.hostedStatus)) {
      assert.ok(entry.alternativePath, `${entry.id} includes an alternative path`);
    }
  }
});
