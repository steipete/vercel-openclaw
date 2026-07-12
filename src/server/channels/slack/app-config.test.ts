import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeSlackInstallToken,
  createSlackInstallToken,
} from "@/server/channels/slack/app-config";
import { slackInstallTokenKey } from "@/server/store/keyspace";
import {
  _resetLogBuffer,
  getServerLogs,
} from "@/server/log";
import { withHarness } from "@/test-utils/harness";

test("Slack install tokens have one atomic consumer", async () => {
  await withHarness(async () => {
    const token = await createSlackInstallToken();
    const results = await Promise.all([
      consumeSlackInstallToken(token),
      consumeSlackInstallToken(token),
    ]);

    assert.deepEqual(results.sort(), [false, true]);
  });
});

test("Slack install token logs contain neither bearer nor lookup key", async () => {
  await withHarness(async () => {
    _resetLogBuffer();
    const token = await createSlackInstallToken();
    const key = slackInstallTokenKey(token);
    assert.equal(await consumeSlackInstallToken(token), true);

    const serializedLogs = JSON.stringify(getServerLogs());
    assert.equal(serializedLogs.includes(token), false);
    assert.equal(serializedLogs.includes(key), false);
  });
});
