/**
 * Runs Muse Code through the whole orchestrator with the real driver: the
 * driver probes the binary and spawns `muse serve`. One full-access thread
 * writes a file, stops a running shell command, and answers again in the same
 * session; a Supervised thread approves one command and declines another.
 *
 *   MUSE_LIVE_BIN=$(which muse) MUSE_LIVE_ROOT=/scratch/dir \
 *     vp test run src/orchestration-v2/MuseOrchestratorV2.live.test.ts
 *
 * Muse uses the developer's own `muse login`. `MUSE_LIVE_MODEL` picks a model
 * other than the driver default. Each step waits up to `MUSE_STEP_WAIT`
 * seconds (120 by default).
 */
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MUSE_DEFAULT_MODEL,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import { describe } from "vite-plus/test";

import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistryHydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderEventLoggers from "../provider/ProviderEventLoggers.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerLedger from "../provider/OpenCodeServerLedger.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";

const binaryPath = process.env.MUSE_LIVE_BIN;
const ROOT = process.env.MUSE_LIVE_ROOT ?? "";
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("muse"),
  model: process.env.MUSE_LIVE_MODEL ?? MUSE_DEFAULT_MODEL,
};
const STEP_WAIT_SECONDS = Number(process.env.MUSE_STEP_WAIT ?? "120");

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(`${ROOT}/work`, { prefix: "t3-muse-live-" });
const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);
const layerServerSettings = ServerSettings.layerTest({
  providers: { muse: { enabled: true, ...(binaryPath ? { binaryPath } : {}) } },
});
const layerBackgroundPolicy = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(layerServerSettings),
);
const layerProviderInstanceRegistry = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerServerConfig.pipe(Layer.provide(layerPlatformTest)),
      layerServerSettings,
      ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
      OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(layerPlatformTest),
      ),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      ModelManifest.layerTest,
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerConfig.pipe(Layer.provide(layerPlatformTest))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(layerPlatformTest),
      ),
      // The Codex driver resolves managed ChatGPT installs; these runs never launch Codex.
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  ),
);
const layerLive = RuntimeLayer.layer.pipe(
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
  Layer.provide(layerServerConfig),
  Layer.provide(layerServerSettings),
  Layer.provide(layerProviderInstanceRegistry),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(layerBackgroundPolicy),
  Layer.provide(layerPlatformTest),
);

const settled = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.length > 0 &&
  projection.runs.every(
    (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
  );
const pendingRequest = (projection: OrchestrationV2ThreadProjection) =>
  projection.runtimeRequests.find((request) => request.status === "pending");
const assistantText = (projection: OrchestrationV2ThreadProjection) =>
  projection.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");

const waitFor = Effect.fn("MuseLive.waitFor")(function* (
  threadId: ThreadId,
  done: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (let attempt = 0; attempt < STEP_WAIT_SECONDS * 2; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (done(projection)) return projection;
    yield* Effect.sleep("500 millis");
  }
  const last = yield* orchestrator.getThreadProjection(threadId);
  const items = last.turnItems.map((item) =>
    item.type === "error" ? `error:${item.failure.message}` : `${item.type}:${item.status}`,
  );
  return yield* Effect.die(
    new Error(
      `Timed out waiting on Muse thread ${threadId}: runs ${last.runs.map((run) => run.status).join(",")}; items ${items.join(",")}`,
    ),
  );
});

const createThread = Effect.fn("MuseLive.createThread")(function* (
  threadId: ThreadId,
  runtimeMode: "full-access" | "approval-required",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${threadId}:create`),
    threadId,
    projectId: ProjectId.make("project:muse-live"),
    title: `Muse live ${runtimeMode}`,
    modelSelection: MODEL,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: `${ROOT}/work`,
  });
});

const send = Effect.fn("MuseLive.send")(function* (threadId: ThreadId, key: string, text: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${threadId}:${key}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${key}`),
    text,
    attachments: [],
    modelSelection: MODEL,
    dispatchMode: { type: "start_immediately" },
  });
});

describe.runIf(binaryPath !== undefined && ROOT !== "")("Muse V2 live orchestrator", () => {
  it.live(
    "writes a file, stops a running command, and keeps the session usable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(ROOT, "work"), { recursive: true });
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:muse-live-full-access");
        yield* createThread(threadId, "full-access");

        yield* send(
          threadId,
          "write",
          "Create a file named muse-live.txt in the current directory containing exactly MUSE_LIVE_7H3Q, then reply DONE.",
        );
        const written = yield* waitFor(threadId, settled);
        assert.equal(written.runs.at(-1)?.status, "completed");
        assert.equal(
          (yield* fs.readFileString(path.join(ROOT, "work", "muse-live.txt"))).trim(),
          "MUSE_LIVE_7H3Q",
        );

        yield* send(
          threadId,
          "sleep",
          "Run the shell command `sleep 90` and wait for it to finish, then reply SLEPT.",
        );
        const sleeping = yield* waitFor(
          threadId,
          (projection) =>
            projection.runs.length === 2 &&
            projection.turnItems.some(
              (item) => item.type === "command_execution" && item.status === "running",
            ),
        );
        const sleepRun = sleeping.runs.at(-1)!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`command:${threadId}:interrupt`),
          threadId,
          runId: sleepRun.id,
        });
        const interrupted = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 2 && settled(projection),
        );
        assert.equal(interrupted.runs.at(-1)?.status, "interrupted");

        yield* send(threadId, "after", "Reply with exactly: AFTER_INTERRUPT");
        const after = yield* waitFor(
          threadId,
          (projection) => projection.runs.length === 3 && settled(projection),
        );
        assert.equal(after.runs.at(-1)?.status, "completed");
        assert.include(assistantText(after), "AFTER_INTERRUPT");
      }).pipe(Effect.provide(Layer.merge(layerLive, NodeServices.layer)), Effect.scoped),
    600_000,
  );

  it.live(
    "asks before shell commands in Supervised, runs the approved one, and skips the declined one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(ROOT, "work"), { recursive: true });
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:muse-live-supervised");
        yield* createThread(threadId, "approval-required");
        const answer = (key: string, decision: "accept" | "decline") =>
          Effect.gen(function* () {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const request = pendingRequest(projection)!;
            yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make(`command:${threadId}:${key}`),
              threadId,
              requestId: request.id,
              decision,
            });
          });

        yield* send(
          threadId,
          "approve",
          "Run the shell command `touch approved.txt` with your shell tool, then reply DONE.",
        );
        const asked = yield* waitFor(
          threadId,
          (projection) => pendingRequest(projection) !== undefined || settled(projection),
        );
        assert.equal(pendingRequest(asked)?.kind, "command");
        yield* answer("approve-answer", "accept");
        const approved = yield* waitFor(threadId, settled);
        assert.equal(approved.runs.at(-1)?.status, "completed");
        assert.isTrue(yield* fs.exists(path.join(ROOT, "work", "approved.txt")));

        yield* send(
          threadId,
          "decline",
          "Run the shell command `touch declined.txt` with your shell tool, then reply DONE.",
        );
        // The model may retry after a decline; decline each retry, then stop the run.
        const runCount = 2;
        let declined = yield* waitFor(
          threadId,
          (projection) =>
            projection.runs.length === runCount &&
            (pendingRequest(projection) !== undefined || settled(projection)),
        );
        assert.isDefined(pendingRequest(declined));
        for (let retry = 0; pendingRequest(declined) !== undefined && retry < 4; retry += 1) {
          const answered = pendingRequest(declined)!.id;
          yield* answer(`decline-${retry}`, "decline");
          declined = yield* waitFor(threadId, (projection) => {
            const next = pendingRequest(projection);
            return (next !== undefined && next.id !== answered) || settled(projection);
          });
        }
        if (!settled(declined)) {
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`command:${threadId}:stop-retries`),
            threadId,
            runId: declined.runs.at(-1)!.id,
          });
          declined = yield* waitFor(threadId, settled);
        }
        assert.include(["completed", "interrupted"], declined.runs.at(-1)?.status);
        assert.isFalse(yield* fs.exists(path.join(ROOT, "work", "declined.txt")));
      }).pipe(Effect.provide(Layer.merge(layerLive, NodeServices.layer)), Effect.scoped),
    600_000,
  );
});
