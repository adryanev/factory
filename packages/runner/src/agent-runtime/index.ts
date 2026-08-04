/**
 * The one seam this issue locks down for real execution to fill in later
 * (spec: "Runner mengimpor `@ai-hero/sandcastle` ... seluruh pemakaiannya
 * diisolasi di satu direktori agent-runtime yang jadi satu-satunya importir,
 * mengekspor satu fungsi `startTurn(spec) -> { done, cancel() }`"). This
 * issue proves the Runner protocol, not the sandbox — the implementation
 * below is deliberately fake and reports success immediately, with no
 * sandcastle import anywhere in this file or this directory.
 *
 * Nothing outside `agent-runtime/` may import sandcastle directly (the real
 * implementation, when it lands, enforces that the same way this fake one
 * does today: by being the only file that could).
 */

export interface TurnSpec {
  /** Fully-rendered prompt — the format-instruction block is already appended by the caller, never by this seam. */
  prompt: string;
  /** Working directory the turn executes in — already checked out by the caller before `startTurn` is invoked. */
  workingDirectory: string;
}

export interface TurnResult {
  /** Raw stdout the caller extracts the `<factory-output>` tag from. */
  stdout: string;
}

export interface Turn {
  /** Resolves once the turn ends, one way or another. Never rejects for a normal agent failure — that's data inside `TurnResult`, not a thrown error; it rejects only for a seam-level fault (e.g. `cancel()` before the fake work would finish). */
  done: Promise<TurnResult>;
  /** Best-effort: asks the turn to stop. The fake implementation below treats this as immediate. */
  cancel(): void;
}

/**
 * Fake `startTurn`. Reports success immediately: `done` resolves on the
 * next microtask with an empty-but-well-formed stdout, so callers testing
 * "the agent said nothing useful" and "the agent emitted `<factory-output>`
 * ..." are free to construct fixtures around a fake with real inputs,
 * exactly like the real one will eventually be exercised.
 */
export function startTurn(spec: TurnSpec): Turn {
  let cancelled = false;
  const done = new Promise<TurnResult>((resolve, reject) => {
    queueMicrotask(() => {
      if (cancelled) {
        reject(new Error("turn was cancelled before it completed"));
        return;
      }
      resolve({ stdout: "" });
    });
  });
  void spec; // the fake never reads the prompt or working directory — a real implementation will.
  return {
    done,
    cancel(): void {
      cancelled = true;
    },
  };
}
