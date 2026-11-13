import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function pollingDelay(hidden, active) {
  return hidden ? 60000 : active ? 2500 : 15000;
}
export function useViewStatus(kind) {
  const [state, setState] = useState(null),
    [error, setError] = useState("");
  const trigger = useRef(null);
  const refresh = useCallback(() => trigger.current?.(), []);
  useEffect(() => {
    let alive = true,
      timer,
      controller;
    async function load() {
      clearTimeout(timer);
      controller?.abort();
      const request = new AbortController();
      controller = request;
      let active = false;
      try {
        const value = await api(`view/${kind}/status`, undefined, {
          signal: request.signal,
        });
        if (alive && !request.signal.aborted) {
          setState(value);
          setError("");
          active = !!value.active;
        }
      } catch (e) {
        if (alive && !request.signal.aborted) setError(e.message);
      } finally {
        if (alive && !request.signal.aborted)
          timer = setTimeout(load, pollingDelay(document.hidden, active));
      }
    }
    trigger.current = load;
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      trigger.current = null;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [kind]);
  return { state, error, refresh };
}

export function useViewRows(kind, version, filters, refresh) {
  const [result, setResult] = useState(null),
    [attempt, setAttempt] = useState(0);
  const query = version
    ? new URLSearchParams({ ...filters, v: version }).toString()
    : "";
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    api(`view/${kind}/rows?${query}`, undefined, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && data.version === version)
          setResult({ query, attempt, data });
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setResult({ query, attempt, error: e.message });
        if (e.status === 409) refresh();
      });
    return () => controller.abort();
  }, [kind, query, version, refresh, attempt]);
  const current =
    query && result?.query === query && result.attempt === attempt
      ? result
      : null;
  return {
    data: current?.data,
    error: current?.error,
    loading: !!query && !current,
    retry: () => setAttempt((x) => x + 1),
  };
}

export function PageNav({ result, onPage }) {
  if (result.error)
    return (
      <p className="notice error" role="alert">
        {result.error} <button onClick={result.retry}>重读本页</button>
      </p>
    );
  if (result.loading) return <p role="status">正在读取本页…</p>;
  if (!result.data) return null;
  const { page, pages, total, size, rows } = result.data;
  return (
    <div className="daily-buttons" role="group" aria-label="分页">
      <span>
        第 {page}／{pages} 页 · {total ? (page - 1) * size + 1 : 0}–
        {(page - 1) * size + rows.length}／{total} 条
      </span>
      {pages > 1 && (
        <>
          <button disabled={page === 1} onClick={() => onPage(1)}>
            首页
          </button>
          <button disabled={page === 1} onClick={() => onPage(page - 1)}>
            上一页
          </button>
          <button disabled={page === pages} onClick={() => onPage(page + 1)}>
            下一页
          </button>
          <button disabled={page === pages} onClick={() => onPage(pages)}>
            末页
          </button>
        </>
      )}
    </div>
  );
}
export async function downloadView(kind, version, format, options = {}) {
  const query = new URLSearchParams({ ...options, v: version, format });
  const response = await fetch(`/api/view/${kind}/export?${query}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const { error } = await response.json();
    throw Object.assign(Error(error || "导出失败"), {
      status: response.status,
    });
  }
  const blob = await response.blob();
  const name = /filename="([a-z0-9.-]+)"/.exec(
    response.headers.get("Content-Disposition"),
  )?.[1];
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name || `${kind}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
