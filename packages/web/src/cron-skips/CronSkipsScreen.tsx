/**
 * The visible half of "skip saat tumpang tindih" (issue 18): cron fires that
 * were skipped because a Run was already active for the same (Pipeline, ref).
 * The reason vocabulary mirrors the control plane — `run-active` is the only
 * closed value.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchCronSkips, type CronSkipRecord, type CronSkipsPage } from "./api";

function shortSha(refSha: string): string {
  return refSha.slice(0, 7);
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

const REASON_COPY: Record<CronSkipRecord["reason"], string> = {
  "run-active": "A Run was already active for the same Pipeline and ref.",
};

export function CronSkipsScreen({ projectId }: { projectId: string }): React.JSX.Element {
  const [page, setPage] = useState<CronSkipsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadMore = useCallback(async (): Promise<void> => {
    if (page === null || page.nextCursor === null) return;
    setLoadingMore(true);
    try {
      const next = await fetchCronSkips(projectId, page.nextCursor);
      setPage({ skips: [...page.skips, ...next.skips], nextCursor: next.nextCursor });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingMore(false);
    }
  }, [page, projectId]);

  useEffect(() => {
    let disposed = false;
    setPage(null);
    setError(null);
    void fetchCronSkips(projectId)
      .then((firstPage) => {
        if (!disposed) setPage(firstPage);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [projectId]);

  if (error !== null) {
    return <p role="alert">Could not load cron skips: {error}</p>;
  }
  if (page === null) {
    return <p aria-busy="true">Loading cron skips…</p>;
  }
  if (page.skips.length === 0) {
    return (
      <section aria-label="Cron skips">
        <p><strong>No cron fire has been skipped.</strong></p>
        <p>When a schedule fires while a Run is still active for the same Pipeline and ref, the overlap is skipped and recorded here.</p>
      </section>
    );
  }
  return (
    <section aria-label="Cron skips" data-testid="cron-skips">
      <h2>Cron skips</h2>
      <p>Cron fires skipped because a Run was already active for the same Pipeline and ref.</p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {page.skips.map((skip) => (
          <li key={skip.id}>
            <header>
              <code>{skip.pipelinePath}</code>
              {" · "}
              <code>
                {skip.refBranch} @ {shortSha(skip.refSha)}
              </code>
            </header>
            <p>
              {REASON_COPY[skip.reason]}
              <br />
              Scheduled for <time dateTime={skip.scheduledFor}>{formatWhen(skip.scheduledFor)}</time>
              {" · skipped "}
              <time dateTime={skip.skippedAt}>{formatWhen(skip.skippedAt)}</time>
            </p>
          </li>
        ))}
      </ul>
      {page.nextCursor !== null ? (
        <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? "Loading more…" : "Show more"}
        </button>
      ) : null}
    </section>
  );
}
