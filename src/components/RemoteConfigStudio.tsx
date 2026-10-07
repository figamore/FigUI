import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useMachineStore } from "../store";
import { loadFluidConfig } from "../lib/fluidSchema";
import { loadConfigStudio } from "../lib/remoteConfigStudio";
import type {
  ConfigStudioInstance,
  ConfigStudioProps,
} from "../lib/configStudioContract";

export function RemoteConfigStudio(
  props: Pick<ConfigStudioProps, "content" | "onChange" | "isActive">,
) {
  const firmwareVersion = useMachineStore((s) => s.espInfo?.version);
  const studioProps = {
    ...props,
    firmwareVersion,
    loadConfig: loadFluidConfig,
  };
  const propsRef = useRef(studioProps);
  propsRef.current = studioProps;
  const targetRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ConfigStudioInstance | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Keep Studio mounted while hidden; CodeEditor controls source resets.
  const [opened, setOpened] = useState(props.isActive);
  useEffect(() => {
    if (props.isActive) setOpened(true);
  }, [props.isActive]);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setError(null);
    setReady(false);
    loadConfigStudio()
      .then((studio) => {
        if (cancelled || !targetRef.current) return;
        instanceRef.current = studio.mount(targetRef.current, propsRef.current);
        setReady(true);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load Config Studio.",
          );
      });
    return () => {
      cancelled = true;
      instanceRef.current?.unmount();
      instanceRef.current = null;
    };
  }, [opened, attempt]);

  useEffect(() => {
    instanceRef.current?.update(studioProps);
  }, [props.content, props.onChange, props.isActive, firmwareVersion]);

  return (
    <div className="relative flex min-h-0 flex-1">
      {/* Separate DOM roots: the remote renderer never owns the loading UI. */}
      <div ref={targetRef} className="flex min-h-0 min-w-0 flex-1" />
      {!ready && opened && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-elevated px-6 text-center text-text-muted">
          {error ? (
            <>
              <AlertTriangle size={26} className="text-warn" />
              <div className="font-semibold text-text-primary">
                Config Studio unavailable
              </div>
              <p className="max-w-md text-sm">{error}</p>
              <button
                className="btn btn-ghost text-sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw size={14} /> Retry
              </button>
            </>
          ) : (
            <>
              <Loader2 size={22} className="animate-spin text-accent" />
              <span className="text-sm">Loading Config Studio…</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
