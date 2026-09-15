import type { MangekyoLoopSession, MangekyoStopRequest } from "@design-sharingan/core";
import {
  claimMangekyoWorkerLease,
  commitMangekyoTerminalTransition,
  releaseMangekyoWorkerLease,
  saveMangekyoLoopSession,
  type MangekyoWorkerLease,
} from "./mangekyo-loop-store";

export interface MangekyoWorkerLeaseOwner {
  assertOwnership(sessionVersion: string): Promise<void>;
  persist(session: MangekyoLoopSession): Promise<void>;
  commitTerminalTransition(input: {
    expectedVersion: string;
    session: MangekyoLoopSession;
  }): Promise<
    | { outcome: "COMMITTED"; session: MangekyoLoopSession }
    | { outcome: "STOP_WON"; stopRequest: MangekyoStopRequest }
  >;
  close(input: { release: boolean }): Promise<void>;
}

export function createMangekyoWorkerLeaseOwner(input: {
  rootPath: string;
  projectId: string;
  lease: MangekyoWorkerLease;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}): MangekyoWorkerLeaseOwner {
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 20_000;
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 250 ||
    leaseDurationMs > 120_000 ||
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 50 ||
    heartbeatIntervalMs * 2 > leaseDurationMs
  ) {
    throw new Error("Mangekyo worker heartbeat timing is invalid");
  }
  const now = input.now ?? (() => new Date());
  let currentLease = structuredClone(input.lease);
  let queue: Promise<void> = Promise.resolve();
  let failure: unknown;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const clearHeartbeat = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const nextLease = (sessionVersion: string): MangekyoWorkerLease => {
    const observed = now();
    if (!Number.isFinite(observed.getTime())) {
      throw new Error("Mangekyo worker heartbeat time is invalid");
    }
    const acquiredAtMs = Math.max(
      observed.getTime(),
      Date.parse(currentLease.acquiredAt) + 1,
    );
    return {
      ...currentLease,
      sessionVersion,
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      expiresAt: new Date(acquiredAtMs + leaseDurationMs).toISOString(),
    };
  };

  const renewUnlocked = async (sessionVersion: string): Promise<void> => {
    if (currentLease.sessionVersion !== sessionVersion) {
      throw new Error("Mangekyo worker ownership does not match the exact session version");
    }
    const renewed = nextLease(sessionVersion);
    await claimMangekyoWorkerLease(
      input.rootPath,
      input.projectId,
      renewed,
      renewed.acquiredAt,
    );
    currentLease = renewed;
  };

  const advanceUnlocked = async (sessionVersion: string): Promise<void> => {
    const renewed = nextLease(sessionVersion);
    await claimMangekyoWorkerLease(
      input.rootPath,
      input.projectId,
      renewed,
      renewed.acquiredAt,
    );
    currentLease = renewed;
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      if (failure !== undefined) throw failure;
      if (closed) throw new Error("Mangekyo worker lease owner is closed");
      return operation();
    });
    queue = result.then(
      () => undefined,
      (error: unknown) => {
        failure ??= error;
        clearHeartbeat();
      },
    );
    return result;
  };

  timer = setInterval(() => {
    void serialize(() => renewUnlocked(currentLease.sessionVersion)).catch(() => undefined);
  }, heartbeatIntervalMs);
  timer.unref?.();

  return {
    assertOwnership(sessionVersion) {
      return serialize(() => renewUnlocked(sessionVersion));
    },
    persist(session) {
      return serialize(async () => {
        if (
          session.id !== currentLease.loopSessionId ||
          session.projectId !== input.projectId ||
          Date.parse(session.updatedAt) < Date.parse(currentLease.sessionVersion)
        ) {
          throw new Error("Mangekyo persistence does not match the exact worker owner");
        }
        await renewUnlocked(currentLease.sessionVersion);
        await saveMangekyoLoopSession(input.rootPath, session);
        if (!["COMPLETE", "BLOCKED", "FAILED"].includes(session.status)) {
          await advanceUnlocked(session.updatedAt);
        }
      });
    },
    commitTerminalTransition(transitionInput) {
      return serialize(async () => {
        if (
          transitionInput.session.id !== currentLease.loopSessionId ||
          transitionInput.expectedVersion !== currentLease.sessionVersion
        ) {
          throw new Error("Mangekyo terminal transition does not match the exact worker owner");
        }
        await renewUnlocked(currentLease.sessionVersion);
        return commitMangekyoTerminalTransition(
          input.rootPath,
          input.projectId,
          transitionInput,
        );
      });
    },
    async close({ release }) {
      clearHeartbeat();
      await queue;
      closed = true;
      if (failure !== undefined) throw failure;
      if (release) {
        await releaseMangekyoWorkerLease(input.rootPath, input.projectId, currentLease);
      }
    },
  };
}
