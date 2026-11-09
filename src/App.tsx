import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "./api";
import { Settings } from "./components/Settings";
import { getPref } from "./prefs";
import { FlowStudio } from "./components/FlowStudio";
import { SlotChips } from "./components/SlotChips";
import { WorkflowPlan } from "./components/WorkflowPlan";
import { loadSideClosed, loadSideWidth, saveSideClosed, saveSideWidth, SideResizer } from "./components/SideResizer";
import type { Flow } from "./flowModel";
import { defaultTools, describeProgress, describeResult, generateGraph } from "./flowCloud";
import { addFlow, loadFlows, replaceFlow } from "./flowStore";
import { PROVIDER_META } from "./providers";
import type { ProviderConfig, ProviderConfigUpdate } from "./types";

function friendly(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return "Something went wrong.";
}

function providerTitle(config: ProviderConfig): string {
  if (config.mode === "demo") return "Demo mode";
  return `${PROVIDER_META[config.mode].label} · ${config[config.mode].model}`;
}

export default function App() {
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The cloud model that just answered; shown for a moment, then gone. */
  const [cloudUsed, setCloudUsed] = useState<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const stop = api.onCloudUsed(({ model }) => {
      setCloudUsed(model);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCloudUsed(null), 2200);
    });
    return () => {
      window.clearTimeout(timer);
      void stop.then((off) => off());
    };
  }, []);
  /** The plan pane, on a window too narrow to keep it beside the canvas. */
  const [briefOpen, setBriefOpen] = useState(false);
  /** The workflow the cloud model is writing, or has just written. */
  const [flowGen, setFlowGen] = useState<{ busy: boolean; text: string; flowId?: string; failed?: boolean } | null>(null);
  /** A cloud request is waiting out Gemini's per-minute limit; shown until it goes. */
  const [cloudWait, setCloudWait] = useState<number | null>(null);
  const flowGenRunningRef = useRef(false);
  /** Which node-canvas workflow the Workflows view opens on. */
  const [studioFlowId, setStudioFlowId] = useState<string | undefined>(undefined);
  /** How wide the right-hand pane is, in pixels; the person drags it, and it is remembered. */
  const [sideWidth, setSideWidth] = useState(loadSideWidth);
  /** The pane has been dragged shut. On a narrow window it is a drawer anyway, and this does not apply. */
  const [sideClosed, setSideClosed] = useState(loadSideClosed);
  const appRef = useRef<HTMLDivElement>(null);
  const applySideWidth = (width: number) => appRef.current?.style.setProperty("--side-w", `${width}px`);
  /** The workflow open in the Workflows view, whose whole plan takes the Brief's place on the right. */
  const [studioFlow, setStudioFlow] = useState<Flow | null>(null);

  // A countdown while a cloud request waits for its place, so a queued edit or workflow does not look stuck.
  useEffect(() => {
    let timer: number | undefined;
    const stop = api.onCloudWait(({ seconds }) => {
      window.clearInterval(timer);
      let left = seconds;
      setCloudWait(left);
      timer = window.setInterval(() => {
        left -= 1;
        if (left <= 0) {
          window.clearInterval(timer);
          setCloudWait(null);
        } else setCloudWait(left);
      }, 1000);
    });
    return () => {
      window.clearInterval(timer);
      void stop.then((off) => off());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const providerConfig = await api.getConfig();
        if (!cancelled) setConfig(providerConfig);
      } catch {
        // The canvas still works without a model; Settings shows the error when it is opened.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === getPref("shortcutSettings")) {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setBriefOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /**
   * Draw a whole workflow from a few words, typed in the box that opens when you double-click the canvas. The cloud model
   * draws the node graph in a planner request and one request per section. The prompts are written by a template from each
   * step's fields; the cloud model only polishes them when asked.
   */
  async function handleDrawWorkflow(ask: string) {
    if (!ask.trim() || flowGenRunningRef.current) return;
    flowGenRunningRef.current = true;
    setFlowGen({ busy: true, text: describeProgress({ stage: "graph", batches: 0, batchesDone: 0, nodes: 0, nodesDone: 0 }) });
    try {
      const result = await generateGraph(
        { ask, messages: [], items: [], tools: defaultTools(loadFlows()) },
        api.cloudComplete,
        Date.now(),
        (progress) => setFlowGen({ busy: true, text: describeProgress(progress) }),
      );
      addFlow(result.flow);
      setFlowGen({ busy: false, text: describeResult(result), flowId: result.flow.id });
    } catch (cause) {
      setFlowGen({ busy: false, failed: true, text: `The workflow could not be written. ${friendly(cause)}` });
    } finally {
      flowGenRunningRef.current = false;
    }
  }

  function handleOpenGeneratedFlow(flowId: string) {
    setStudioFlowId(flowId);
    // Cleared straight after, so opening the same workflow again later still counts as a change.
    window.setTimeout(() => setStudioFlowId(undefined), 150);
    setSettingsOpen(false);
    setFlowGen(null);
  }

  /** Show the written plan: as a drawer on a narrow window, and beside the canvas on a wide one (brought back if it was dragged shut). */
  function openPlan() {
    setBriefOpen(true);
    if (sideClosed) {
      setSideClosed(false);
      saveSideClosed(false);
    }
  }

  async function handleSaveConfig(update: ProviderConfigUpdate) {
    const saved = await api.saveConfig(update);
    setConfig(saved);
    setSettingsOpen(false);
  }

  if (!loaded) {
    return (
      <div className="boot">
        <div className="boot-mark">S</div>
        <div className="boot-word">Soren</div>
      </div>
    );
  }

  return (
    <div className={`app ${sideClosed ? "side-closed" : ""}`} ref={appRef} style={{ "--side-w": `${sideWidth}px` } as CSSProperties}>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-drag" data-tauri-drag-region>
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">
                S
              </span>
              <span className="brand-word">Soren</span>
            </div>
          </div>
          <div className="topbar-actions">
            <SlotChips />
            <button
              type="button"
              className={`mode-pill ${config?.mode ?? ""}`}
              onClick={() => setSettingsOpen(true)}
              title={config ? providerTitle(config) : "Model settings"}
            >
              <span className="mode-dot" />
              <span className="mode-label">{config ? PROVIDER_META[config.mode].shortLabel : "Settings"}</span>
            </button>
          </div>
        </header>

        <FlowStudio
          openId={studioFlowId}
          onActive={setStudioFlow}
          onDraw={(ask) => void handleDrawWorkflow(ask)}
          onSettings={() => setSettingsOpen(true)}
          onPlan={openPlan}
        />

        {(cloudWait !== null || flowGen) && (
          <div className="float-status">
            {cloudWait !== null && (
              <div className="held-reply" role="status">
                Waiting {cloudWait} s for the cloud model's per-minute limit; it goes by itself.
              </div>
            )}
            {flowGen && (
              <div className={`flow-gen ${flowGen.failed ? "failed" : ""}`} role="status" aria-live="polite">
                <span className="flow-gen-text">{flowGen.text}</span>
                {flowGen.flowId && (
                  <button type="button" className="ghost" onClick={() => handleOpenGeneratedFlow(flowGen.flowId!)}>
                    Open workflow
                  </button>
                )}
                {!flowGen.busy && (
                  <button type="button" className="ghost" onClick={() => setFlowGen(null)}>
                    Dismiss
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {briefOpen && (
        <div className="brief-scrim" onClick={() => setBriefOpen(false)} />
      )}

      <aside className={`brief-panel ${briefOpen ? "open" : ""}`}>
        <SideResizer
          width={sideWidth}
          onLive={applySideWidth}
          onCommit={(width) => {
            applySideWidth(width);
            setSideWidth(width);
            saveSideWidth(width);
          }}
          onClose={() => {
            // The width it had before the drag is kept, so reopening brings it back as it was.
            applySideWidth(sideWidth);
            setSideClosed(true);
            saveSideClosed(true);
          }}
          onReopen={() => {
            setSideClosed(false);
            saveSideClosed(false);
          }}
        />
        <WorkflowPlan flow={studioFlow} onClose={() => setBriefOpen(false)} onEdit={replaceFlow} />
      </aside>

      {settingsOpen && config && (
        <Settings
          config={config}
          onConfig={setConfig}
          onSave={handleSaveConfig}
          onEffort={(effort) => void api.setEffort(effort).then(setConfig).catch(() => {})}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {cloudUsed && (
        <div className="cloud-toast" role="status" aria-live="polite">
          Used {cloudUsed}
        </div>
      )}
    </div>
  );
}
