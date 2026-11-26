import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  Box,
  Check,
  Copy,
  Download,
  Eject,
  ExternalLink,
  FolderOpen,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Scale,
  Server,
  Sparkles,
  Square,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import logoUrl from "@/assets/logo.png";
import { cn } from "@/lib/utils";

type Page = "status" | "server" | "models" | "about";
type ServerRunState = "stopped" | "starting" | "running" | "stopping";

interface AppConfig {
  modelDir: string;
  selectedModel: string | null;
  selectedDrafter: string | null;
  port: number;
  autoUpdate: boolean;
  autoUpdateDeps: boolean;
}

interface ModelEntry {
  name: string;
  path: string;
  isDrafter: boolean;
  format: string;
  sizeGb: number;
  estRamGb: number;
}

interface HfModelEntry {
  id: string;
  name: string;
  sizeGb: number;
  estRamGb: number;
  isDrafter: boolean;
  downloads: number;
  installed: boolean;
}

interface SystemInfo {
  ramUsedGb: number;
  ramTotalGb: number;
  ramPercent: number;
  thermalState: string;
  chipName: string;
}

interface DepsUpdateCheck {
  upToDate: boolean;
  installedCommit: string | null;
  latestCommit: string | null;
  message: string;
}

interface ServerLogEvent {
  ts: string | null;
  level: string | null;
  tone: string;
  msg: string;
}

interface ServerStatusPayload {
  status: ServerRunState;
  port: number;
  model: string | null;
  drafter: string | null;
  startedAtMs: number | null;
  error: string | null;
}

interface DependencyStatus {
  ready: boolean;
  pythonPath: string | null;
  targetVenv: string;
  missing: string[];
}

interface DepsProgressEvent {
  percent: number;
  stage: string;
  logLine: string;
  done: boolean;
  error: string | null;
}

const NAV_ITEMS: {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "status", label: "Status", icon: Activity },
  { id: "server", label: "Server", icon: Server },
  { id: "models", label: "Models", icon: Box },
  { id: "about", label: "About", icon: Info },
];

function formatUptime(startedAtMs: number | null, nowMs: number): string {
  if (!startedAtMs) return "Not running";
  const secs = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function nowTimeStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function SectionHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2",
        className
      )}
    >
      {children}
    </h2>
  );
}

function CopyButton({
  value,
  label = "Copy",
  disabled = false,
}: {
  value: string;
  label?: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore if clipboard blocked
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled || !value}
      onClick={handleCopy}
      className="h-7 px-2.5 text-xs border border-white/10"
    >
      {copied ? (
        <>
          <Check className="size-3.5 text-emerald-400" />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3.5 opacity-75" />
          {label}
        </>
      )}
    </Button>
  );
}

function StatusPage({
  serverStatus,
  activeModel,
  activeDrafter,
  sysInfo,
  uptimeText,
  autoUpdate,
  autoUpdateDeps,
  guiUpdateNote,
  depsUpdateNote,
  depsChecking,
  depsUpdating,
  depsUpdateAvailable,
  onToggleAutoUpdate,
  onToggleAutoUpdateDeps,
  onCheckGuiUpdate,
  onCheckDepsUpdate,
  onUpdateDepsNow,
  onRun,
  onStop,
}: {
  serverStatus: ServerStatusPayload;
  activeModel: ModelEntry | null;
  activeDrafter: ModelEntry | null;
  sysInfo: SystemInfo;
  uptimeText: string;
  autoUpdate: boolean;
  autoUpdateDeps: boolean;
  guiUpdateNote: string;
  depsUpdateNote: string;
  depsChecking: boolean;
  depsUpdating: boolean;
  depsUpdateAvailable: boolean;
  onToggleAutoUpdate: (val: boolean) => void;
  onToggleAutoUpdateDeps: (val: boolean) => void;
  onCheckGuiUpdate: () => void;
  onCheckDepsUpdate: () => void;
  onUpdateDepsNow: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const isStopped = serverStatus.status === "stopped";
  const isRunning = serverStatus.status === "running";
  const isStarting = serverStatus.status === "starting";
  const isStopping = serverStatus.status === "stopping";

  const badgeLabel = isRunning
    ? "Yes"
    : isStarting
    ? "Starting..."
    : isStopping
    ? "Stopping..."
    : "No";

  const isNormalTherm = sysInfo.thermalState === "Normal";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your local server, system health, and app updates.
        </p>
      </div>

      {/* SERVER */}
      <div>
        <SectionHeader>Server</SectionHeader>
        <Card className="py-0 gap-0">
          <CardContent className="p-0">
            <div className="flex items-center justify-between px-4 py-3.5">
              <div className="flex items-center gap-3">
                <span className="text-sm text-foreground">Server running:</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "rounded-md px-2.5 py-0.5 text-xs font-medium border-white/12",
                    isRunning
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                      : isStarting || isStopping
                      ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                      : "bg-background/60 text-foreground"
                  )}
                >
                  {badgeLabel}
                </Badge>
                {serverStatus.error && (
                  <span className="text-xs text-red-400 truncate max-w-xs">
                    {serverStatus.error}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 px-4"
                  disabled={!isStopped || !activeModel}
                  onClick={onRun}
                >
                  {isStarting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5 fill-current" />
                  )}
                  Run
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isStopped || isStopping}
                  onClick={onStop}
                  className="h-8 px-4 border border-white/10"
                >
                  <Square className="size-3.5" />
                  Stop
                </Button>
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-sm text-foreground">Model</span>
              <span className="text-sm text-foreground/90 font-medium">
                {activeModel ? activeModel.name : "None selected"}
              </span>
            </div>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-sm text-foreground">Drafter</span>
              <span className="text-sm text-foreground/90 font-medium">
                {activeDrafter ? activeDrafter.name : "None"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* SYSTEM */}
      <div>
        <SectionHeader>System</SectionHeader>
        <Card className="py-0 gap-0">
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-6 px-4 py-3.5">
              <span className="text-sm text-foreground shrink-0">
                System RAM
              </span>
              <div className="flex items-center gap-4 ml-auto">
                <Progress
                  value={Math.min(100, Math.max(0, sysInfo.ramPercent))}
                  className="w-44 [&>[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-indicator]]:bg-zinc-300"
                />
                <span className="text-sm tabular-nums text-foreground/90 w-32 text-right">
                  {sysInfo.ramUsedGb.toFixed(1)} /{" "}
                  {sysInfo.ramTotalGb.toFixed(1)} GB
                </span>
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-sm text-foreground">Thermal state</span>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    isNormalTherm ? "bg-emerald-500" : "bg-amber-400"
                  )}
                />
                <span
                  className={cn(
                    "text-sm font-medium",
                    isNormalTherm ? "text-emerald-400" : "text-amber-300"
                  )}
                >
                  {sysInfo.thermalState}
                </span>
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-sm text-foreground">Server uptime</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {uptimeText}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* UPDATES */}
      <div>
        <SectionHeader>Updates</SectionHeader>
        <Card className="py-0 gap-0">
          <CardContent className="p-0">
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-sm text-foreground">LAMQ-Gui version</span>
              <span className="text-sm text-muted-foreground">
                v0.1.0 (Alpha)
              </span>
            </div>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">
                  LAMQ-Gui updates
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {guiUpdateNote}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={onCheckGuiUpdate}
                className="h-8 px-3.5 border border-white/10"
              >
                Check now
              </Button>
            </div>

            <Separator />

            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Dependencies (lookatmyquant · mlx)
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {depsUpdateNote}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {depsUpdateAvailable && (
                  <Button
                    size="sm"
                    disabled={depsUpdating || !isStopped}
                    onClick={onUpdateDepsNow}
                    className="h-8 px-3.5"
                  >
                    {depsUpdating ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Updating...
                      </>
                    ) : (
                      "Update"
                    )}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={depsChecking || depsUpdating}
                  onClick={onCheckDepsUpdate}
                  className="h-8 px-3.5 border border-white/10"
                >
                  {depsChecking ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Checking...
                    </>
                  ) : (
                    "Check now"
                  )}
                </Button>
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Auto update LAMQ-Gui
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Automatically download and install new GUI releases from GitHub.
                </p>
              </div>
              <Checkbox
                checked={autoUpdate}
                onCheckedChange={(v) => onToggleAutoUpdate(Boolean(v))}
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Auto update dependencies
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Automatically keep lookatmyquant, mlx, and mlx-lm up to date.
                </p>
              </div>
              <Checkbox
                checked={autoUpdateDeps}
                onCheckedChange={(v) => onToggleAutoUpdateDeps(Boolean(v))}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ServerPage({
  port,
  serverStatus,
  logs,
  onPortChange,
  onClearLogs,
}: {
  port: number;
  serverStatus: ServerStatusPayload;
  logs: ServerLogEvent[];
  onPortChange: (port: number) => void;
  onClearLogs: () => void;
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [portDraft, setPortDraft] = useState(String(port));
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPortDraft(String(port));
  }, [port]);

  useEffect(() => {
    if (autoScroll) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [logs, autoScroll]);

  const openaiUrl = `http://127.0.0.1:${port}/v1`;
  const anthropicUrl = `http://127.0.0.1:${port}`;
  const isStopped = serverStatus.status === "stopped";

  const commitPort = () => {
    const parsed = Number.parseInt(portDraft, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
      onPortChange(parsed);
    } else {
      setPortDraft(String(port));
    }
  };

  const footerRight =
    serverStatus.status === "running"
      ? `Listening on :${serverStatus.port}`
      : serverStatus.status === "starting"
      ? "Loading model..."
      : serverStatus.status === "stopping"
      ? "Shutting down..."
      : "Server stopped";

  return (
    <div className="flex flex-col h-full gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Server</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Connect your apps and view server output.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Port</span>
          <Input
            value={portDraft}
            disabled={!isStopped}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => e.key === "Enter" && commitPort()}
            className="w-20 h-8 font-mono text-xs text-center bg-card border-white/10"
          />
        </div>
      </div>

      {/* API ENDPOINTS */}
      <div>
        <SectionHeader>API Endpoints</SectionHeader>
        <Card className="py-0 gap-0">
          <CardContent className="p-0">
            <div className="flex items-center gap-4 px-4 py-3">
              <span className="text-sm text-foreground w-44 shrink-0">
                OpenAI-compatible
              </span>
              <Input
                readOnly
                value={openaiUrl}
                className="font-mono text-xs h-8 bg-background/60 border-white/10"
              />
              <CopyButton value={openaiUrl} />
            </div>

            <Separator />

            <div className="flex items-center gap-4 px-4 py-3">
              <span className="text-sm text-foreground w-44 shrink-0">
                Anthropic / Claude Code
              </span>
              <Input
                readOnly
                value={anthropicUrl}
                className="font-mono text-xs h-8 bg-background/60 border-white/10"
              />
              <CopyButton value={anthropicUrl} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* SERVER LOGS */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-2">
          <SectionHeader className="mb-0">Server Logs</SectionHeader>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-foreground/90 cursor-pointer select-none">
              <Checkbox
                checked={autoScroll}
                onCheckedChange={(v) => setAutoScroll(Boolean(v))}
              />
              Auto-scroll
            </label>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-3 text-xs border border-white/10"
              onClick={onClearLogs}
            >
              Clear
            </Button>
          </div>
        </div>

        <Card className="flex-1 flex flex-col min-h-0 py-0 gap-0 bg-[#121214]">
          <ScrollArea className="flex-1 min-h-0 p-4">
            <div className="space-y-1 font-mono text-xs leading-relaxed">
              {logs.length === 0 ? (
                <p className="text-muted-foreground italic">
                  No logs yet. Press Run on Status to start the server.
                </p>
              ) : (
                logs.map((entry, idx) => (
                  <div key={idx} className="flex items-baseline gap-3">
                    <span className="text-zinc-500 w-16 shrink-0 tabular-nums">
                      {entry.ts ?? ""}
                    </span>
                    <span
                      className={cn(
                        "w-10 shrink-0 font-medium",
                        entry.level === "INFO" && "text-sky-400",
                        entry.level === "HTTP" && "text-amber-300",
                        !entry.level && "opacity-0"
                      )}
                    >
                      {entry.level ?? "INFO"}
                    </span>
                    <span
                      className={cn(
                        entry.tone === "success"
                          ? "text-emerald-400"
                          : "text-zinc-200",
                        !entry.ts && "pl-2 text-zinc-300"
                      )}
                    >
                      {entry.msg}
                    </span>
                  </div>
                ))
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>
          <Separator />
          <div className="flex items-center justify-between px-4 py-2 text-[11px] text-muted-foreground bg-card/40">
            <span>{logs.length} lines</span>
            <span>{footerRight}</span>
          </div>
        </Card>
      </div>
    </div>
  );
}

function getDeviceFit(estRamGb: number, totalRamGb: number) {
  if (totalRamGb <= 0 || estRamGb <= totalRamGb * 0.6) {
    return {
      label: "happy fit",
      dotClass: "bg-emerald-500",
      textClass: "text-emerald-400",
    };
  }
  if (estRamGb <= totalRamGb * 0.85) {
    return {
      label: "barely fits",
      dotClass: "bg-amber-400",
      textClass: "text-amber-300",
    };
  }
  return {
    label: "does not fit",
    dotClass: "bg-red-500",
    textClass: "text-red-400",
  };
}

function RamFitLine({
  estRamGb,
  totalRamGb,
  selected = false,
}: {
  estRamGb: number;
  totalRamGb: number;
  selected?: boolean;
}) {
  const fit = getDeviceFit(estRamGb, totalRamGb);
  return (
    <div className="flex items-center gap-2 text-[11px] leading-tight">
      <span
        className={cn(
          "tabular-nums",
          selected ? "text-primary-foreground/80" : "text-muted-foreground"
        )}
      >
        ~{estRamGb.toFixed(1)} GB RAM
      </span>
      <span
        className={cn(
          selected ? "text-primary-foreground/50" : "text-muted-foreground/50"
        )}
      >
        ·
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("size-2 rounded-full shrink-0", fit.dotClass)} />
        <span
          className={cn(
            "font-medium",
            selected ? "text-primary-foreground" : fit.textClass
          )}
        >
          {fit.label}
        </span>
      </span>
    </div>
  );
}

function ModelsPage({
  modelDir,
  models,
  drafters,
  activeModel,
  activeDrafter,
  totalRamGb,
  serverRunning,
  hfModels,
  hfLoading,
  hfError,
  downloadingId,
  downloadMsg,
  onSelectModel,
  onSelectDrafter,
  onPickDir,
  onDirInput,
  onRescan,
  onFetchHfModels,
  onDownload,
}: {
  modelDir: string;
  models: ModelEntry[];
  drafters: ModelEntry[];
  activeModel: ModelEntry | null;
  activeDrafter: ModelEntry | null;
  totalRamGb: number;
  serverRunning: boolean;
  hfModels: HfModelEntry[];
  hfLoading: boolean;
  hfError: string | null;
  downloadingId: string | null;
  downloadMsg: string | null;
  onSelectModel: (name: string | null) => void;
  onSelectDrafter: (name: string | null) => void;
  onPickDir: () => void;
  onDirInput: (dir: string) => void;
  onRescan: () => void;
  onFetchHfModels: () => void;
  onDownload: (repoId: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [dirDraft, setDirDraft] = useState(modelDir);

  useEffect(() => {
    setDirDraft(modelDir);
  }, [modelDir]);

  const openDownloader = () => {
    setDialogOpen(true);
    onFetchHfModels();
  };

  const filteredHf = hfModels.filter((m) =>
    m.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <div className="flex flex-col h-full gap-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All your models, and a downloader.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={openDownloader}
          className="h-8 px-3 text-xs border border-white/10"
        >
          <Download className="size-3.5" />
          Download Model
        </Button>
      </div>

      {/* Download Model Modal */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-base">
              Download LookAtMyQuant Models
            </DialogTitle>
            <DialogDescription className="text-xs">
              Models from <span className="font-mono">shinmegamiboson</span> on
              Hugging Face · Device RAM:{" "}
              <span className="font-medium text-foreground">
                {totalRamGb > 0 ? `${totalRamGb.toFixed(0)} GB` : "Detecting..."}
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter models (e.g. Qwen3.8, Inkling, drafter)..."
              className="h-8 text-xs bg-background/60 border-white/10"
            />
            <Button
              variant="secondary"
              size="icon-sm"
              disabled={hfLoading}
              onClick={onFetchHfModels}
              className="border border-white/10 shrink-0"
              aria-label="Refresh Hugging Face list"
            >
              <RefreshCw
                className={cn("size-3.5", hfLoading && "animate-spin")}
              />
            </Button>
          </div>

          {hfError && (
            <p className="text-xs text-red-400 font-mono">{hfError}</p>
          )}
          {downloadMsg && (
            <p className="text-xs text-muted-foreground font-mono">
              {downloadMsg}
            </p>
          )}

          <ScrollArea className="h-[380px] rounded-lg border border-white/8 bg-background/40">
            {hfLoading && hfModels.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Fetching shinmegamiboson models from Hugging Face...
              </div>
            ) : filteredHf.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-12">
                No matching models found.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {filteredHf.map((m) => {
                  const isDownloadingThis = downloadingId === m.id;
                  const alreadyLocal =
                    m.installed ||
                    models.some((loc) => loc.name === m.name) ||
                    drafters.some((loc) => loc.name === m.name);
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/30 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">
                            {m.name}
                          </span>
                          {m.isDrafter && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0 h-4 border-white/15 text-muted-foreground"
                            >
                              Drafter
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2.5 mt-1">
                          <RamFitLine
                            estRamGb={m.estRamGb}
                            totalRamGb={totalRamGb}
                          />
                          <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                            ({m.sizeGb.toFixed(2)} GB download)
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0">
                        {alreadyLocal ? (
                          <Badge
                            variant="secondary"
                            className="h-7 px-2.5 text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/25"
                          >
                            <Check className="size-3" />
                            Downloaded
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            disabled={downloadingId !== null}
                            onClick={() => onDownload(m.id)}
                            className="h-7 px-3 text-xs"
                          >
                            {isDownloadingThis ? (
                              <>
                                <Loader2 className="size-3.5 animate-spin" />
                                Downloading...
                              </>
                            ) : (
                              <>
                                <Download className="size-3.5" />
                                Download
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* ACTIVE MODELS */}
      <div>
        <SectionHeader>Active Models</SectionHeader>
        <Card className="py-0 gap-0">
          <CardContent className="p-3">
            <div className="rounded-lg border border-white/8 bg-background/45">
              {/* Model */}
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Model</p>
                  <p className="text-sm font-medium text-foreground mt-0.5 truncate">
                    {activeModel ? activeModel.name : "No model selected"}
                  </p>
                  {activeModel && (
                    <div className="mt-1">
                      <RamFitLine
                        estRamGb={activeModel.estRamGb}
                        totalRamGb={totalRamGb}
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <CopyButton
                    value={activeModel?.name ?? ""}
                    label="Copy Model Id"
                    disabled={!activeModel}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="secondary"
                          size="icon-sm"
                          disabled={!activeModel || serverRunning}
                          onClick={() => onSelectModel(null)}
                          className="border border-white/10"
                          aria-label="Unload model"
                        />
                      }
                    >
                      <Eject className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>
                      {serverRunning
                        ? "Stop server before unloading"
                        : "Unload model from memory"}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <Separator />

              {/* Drafter */}
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Drafter</p>
                  <p className="text-sm font-medium text-foreground mt-0.5 truncate">
                    {activeDrafter ? activeDrafter.name : "No drafter selected"}
                  </p>
                  {activeDrafter && (
                    <div className="mt-1">
                      <RamFitLine
                        estRamGb={activeDrafter.estRamGb}
                        totalRamGb={totalRamGb}
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <CopyButton
                    value={activeDrafter?.name ?? ""}
                    label="Copy Model Id"
                    disabled={!activeDrafter}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="secondary"
                          size="icon-sm"
                          disabled={!activeDrafter || serverRunning}
                          onClick={() => onSelectDrafter(null)}
                          className="border border-white/10"
                          aria-label="Unload drafter"
                        />
                      }
                    >
                      <Eject className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>
                      {serverRunning
                        ? "Stop server before unloading"
                        : "Unload drafter from memory"}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* MODEL DIRECTORY */}
      <div className="flex items-center gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
          Model Directory
        </span>
        <Input
          value={dirDraft}
          disabled={serverRunning}
          onChange={(e) => setDirDraft(e.target.value)}
          onBlur={() => dirDraft !== modelDir && onDirInput(dirDraft)}
          onKeyDown={(e) =>
            e.key === "Enter" && dirDraft !== modelDir && onDirInput(dirDraft)
          }
          className="flex-1 h-8 font-mono text-xs bg-card border-white/10"
        />
        <Button
          variant="secondary"
          size="icon-sm"
          disabled={serverRunning}
          onClick={onPickDir}
          className="border border-white/10"
          aria-label="Browse model directory"
        >
          <FolderOpen className="size-3.5" />
        </Button>
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={onRescan}
          className="border border-white/10"
          aria-label="Rescan models"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {/* DUAL COLUMNS */}
      <Card className="flex-1 min-h-0 py-0 gap-0">
        <div className="grid grid-cols-2 h-full divide-x divide-border">
          {/* Model Column */}
          <div className="flex flex-col min-h-0">
            <div className="px-4 py-2.5 text-center text-xs font-semibold text-foreground/90 border-b border-border">
              Model
            </div>
            <ScrollArea className="flex-1 min-h-0 p-3">
              {models.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  No models found in directory.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {models.map((m) => {
                    const selected = activeModel?.name === m.name;
                    return (
                      <button
                        key={m.path}
                        type="button"
                        disabled={serverRunning}
                        onClick={() => onSelectModel(m.name)}
                        className={cn(
                          "w-full flex flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors disabled:opacity-60",
                          selected
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-foreground/85 hover:bg-muted/70"
                        )}
                      >
                        <div className="w-full flex items-center justify-between gap-2">
                          <span className="text-xs font-medium truncate">
                            {m.name}
                          </span>
                          <span
                            className={cn(
                              "text-[10px] shrink-0 tabular-nums",
                              selected
                                ? "text-primary-foreground/80"
                                : "text-muted-foreground"
                            )}
                          >
                            {m.sizeGb.toFixed(1)} GB
                          </span>
                        </div>
                        <RamFitLine
                          estRamGb={m.estRamGb}
                          totalRamGb={totalRamGb}
                          selected={selected}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Drafter Column */}
          <div className="flex flex-col min-h-0">
            <div className="px-4 py-2.5 text-center text-xs font-semibold text-foreground/90 border-b border-border">
              Drafter(optional)
            </div>
            <ScrollArea className="flex-1 min-h-0 p-3">
              {drafters.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  No drafters found in directory.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {drafters.map((d) => {
                    const selected = activeDrafter?.name === d.name;
                    return (
                      <button
                        key={d.path}
                        type="button"
                        disabled={serverRunning}
                        onClick={() =>
                          onSelectDrafter(selected ? null : d.name)
                        }
                        className={cn(
                          "w-full flex flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors disabled:opacity-60",
                          selected
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-foreground/85 hover:bg-muted/70"
                        )}
                      >
                        <div className="w-full flex items-center justify-between gap-2">
                          <span className="text-xs font-medium truncate">
                            {d.name}
                          </span>
                          <span
                            className={cn(
                              "text-[10px] shrink-0 tabular-nums",
                              selected
                                ? "text-primary-foreground/80"
                                : "text-muted-foreground"
                            )}
                          >
                            {d.sizeGb.toFixed(1)} GB
                          </span>
                        </div>
                        <RamFitLine
                          estRamGb={d.estRamGb}
                          totalRamGb={totalRamGb}
                          selected={selected}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      </Card>
    </div>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

const CODING_APPS: {
  name: string;
  configHint: string;
  glyph: string;
  accent: string;
}[] = [
  { name: "Cursor", configHint: "settings.json", glyph: "CU", accent: "bg-sky-500/20 text-sky-300 border-sky-400/30" },
  { name: "Claude Code", configHint: "~/.claude.json", glyph: "CC", accent: "bg-amber-500/20 text-amber-300 border-amber-400/30" },
  { name: "Codex", configHint: "~/.codex/config.toml", glyph: "CX", accent: "bg-emerald-500/20 text-emerald-300 border-emerald-400/30" },
  { name: "OpenCode", configHint: "opencode.json", glyph: "OC", accent: "bg-indigo-500/20 text-indigo-300 border-indigo-400/30" },
  { name: "Aider", configHint: ".aider.conf.yml", glyph: "AI", accent: "bg-rose-500/20 text-rose-300 border-rose-400/30" },
  { name: "Pi Agent", configHint: "models.json", glyph: "PI", accent: "bg-violet-500/20 text-violet-300 border-violet-400/30" },
  { name: "Qwen Code", configHint: "~/.qwen/settings.json", glyph: "QW", accent: "bg-cyan-500/20 text-cyan-300 border-cyan-400/30" },
  { name: "Windsurf", configHint: "mcp_config.json", glyph: "WS", accent: "bg-teal-500/20 text-teal-300 border-teal-400/30" },
];

function AboutPage() {
  const openExternal = async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">About</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Credits, source links, license, and upcoming integrations.
        </p>
      </div>

      {/* IDENTITY & LICENSE */}
      <Card className="py-0 gap-0">
        <CardContent className="p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <img
              src={logoUrl}
              alt="LookAtMyQuant"
              className="w-36 h-auto object-contain select-none shrink-0"
              draggable={false}
            />
            <Separator orientation="vertical" className="h-8" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  LookAtMyQuant Launcher
                </span>
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 h-4 border border-white/10"
                >
                  v0.1.0 Alpha
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Copyright © 2026 Shreyas Dasari · Released under the MIT License
              </p>
            </div>
          </div>
          <Badge
            variant="outline"
            className="h-7 px-2.5 text-xs border-white/15 text-muted-foreground shrink-0 gap-1.5"
          >
            <Scale className="size-3.5" />
            MIT License
          </Badge>
        </CardContent>
      </Card>

      {/* REPOSITORIES & CREDITS */}
      <div>
        <SectionHeader>Links & Credits</SectionHeader>
        <Card className="py-0 gap-0">
          <CardContent className="p-0">
            <button
              type="button"
              onClick={() =>
                openExternal("https://github.com/Shreyas-Dasari/LookAtMyQuant-Gui")
              }
              className="w-full flex items-center justify-between gap-4 px-4 py-3.5 text-left hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <GithubIcon className="size-5 text-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    LookAtMyQuant-Gui Repository
                  </p>
                  <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
                    github.com/Shreyas-Dasari/LookAtMyQuant-Gui
                  </p>
                </div>
              </div>
              <ExternalLink className="size-4 text-muted-foreground shrink-0" />
            </button>

            <Separator />

            <button
              type="button"
              onClick={() =>
                openExternal("https://github.com/ShinMegamiBoson/lookatmyquant")
              }
              className="w-full flex items-center justify-between gap-4 px-4 py-3.5 text-left hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Terminal className="size-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Original lookatmyquant (CLI & Runtime)
                  </p>
                  <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
                    github.com/ShinMegamiBoson/lookatmyquant · by ShinMegamiBoson
                  </p>
                </div>
              </div>
              <ExternalLink className="size-4 text-muted-foreground shrink-0" />
            </button>

            <Separator />

            <button
              type="button"
              onClick={() =>
                openExternal("https://github.com/ml-explore/mlx-lm")
              }
              className="w-full flex items-center justify-between gap-4 px-4 py-3.5 text-left hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Sparkles className="size-5 text-sky-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    MLX & mlx-lm
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    Apple Silicon ML framework and LLM inference foundation (ml-explore)
                  </p>
                </div>
              </div>
              <ExternalLink className="size-4 text-muted-foreground shrink-0" />
            </button>

            <Separator />

            <div className="flex items-center justify-between px-4 py-3 text-xs text-muted-foreground">
              <span>Built with Tauri 2, React, Tailwind CSS & Shadcn UI</span>
              <span>MIT License · 2026</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* COMING SOON: INTEGRATIONS */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <SectionHeader className="mb-0">Coding App Integrations</SectionHeader>
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 h-4 border-primary/40 bg-primary/15 text-primary"
          >
            Coming Soon
          </Badge>
        </div>

        <div className="relative rounded-xl overflow-hidden border border-border">
          {/* Blurred preview cards underneath */}
          <div
            aria-hidden
            className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 bg-card/60 blur-[4px] opacity-75 pointer-events-none select-none"
          >
            {CODING_APPS.map((app) => (
              <div
                key={app.name}
                className="rounded-lg border border-white/10 bg-background/70 p-3 flex flex-col justify-between gap-3"
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className={cn(
                      "size-8 rounded-md border flex items-center justify-center text-xs font-bold tracking-tight shrink-0",
                      app.accent
                    )}
                  >
                    {app.glyph}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">
                      {app.name}
                    </p>
                    <p className="text-[10px] font-mono text-muted-foreground truncate">
                      {app.configHint}
                    </p>
                  </div>
                </div>
                <div className="h-6 rounded-md bg-secondary border border-white/10 flex items-center justify-center text-[11px] font-medium text-foreground/80">
                  Import config.json
                </div>
              </div>
            ))}
          </div>

          {/* Overlay */}
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background/45 backdrop-blur-[3px] p-6 text-center">
            <Badge className="mb-2 px-3 py-1 text-xs font-semibold">
              Coming Soon
            </Badge>
            <p className="text-sm font-medium text-foreground">
              One-Click Coding Agent & IDE Setup
            </p>
            <p className="text-xs text-muted-foreground max-w-md mt-1">
              Automatically write a ready-to-use <span className="font-mono text-foreground/90">config.json</span> for Cursor, Claude Code, Codex, OpenCode, Aider, Pi Agent, Qwen Code, and Windsurf pointing to your local LookAtMyQuant server.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("status");
  const [config, setConfig] = useState<AppConfig>({
    modelDir: "",
    selectedModel: null,
    selectedDrafter: null,
    port: 8080,
    autoUpdate: true,
    autoUpdateDeps: true,
  });
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [sysInfo, setSysInfo] = useState<SystemInfo>({
    ramUsedGb: 0,
    ramTotalGb: 0,
    ramPercent: 0,
    thermalState: "Normal",
    chipName: "",
  });
  const [serverStatus, setServerStatus] = useState<ServerStatusPayload>({
    status: "stopped",
    port: 8080,
    model: null,
    drafter: null,
    startedAtMs: null,
    error: null,
  });
  const [logs, setLogs] = useState<ServerLogEvent[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [guiUpdateNote, setGuiUpdateNote] = useState(
    "Not published on GitHub yet."
  );
  const [depsUpdateNote, setDepsUpdateNote] = useState(
    "Click Check now to check lookatmyquant upstream."
  );
  const [depsChecking, setDepsChecking] = useState(false);
  const [depsUpdating, setDepsUpdating] = useState(false);
  const [depsUpdateAvailable, setDepsUpdateAvailable] = useState(false);
  const [hfModels, setHfModels] = useState<HfModelEntry[]>([]);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);
  const [depsReady, setDepsReady] = useState(true);
  const [depsTargetVenv, setDepsTargetVenv] = useState<string>("");
  const [depsInstalling, setDepsInstalling] = useState(false);
  const [depsPercent, setDepsPercent] = useState(0);
  const [depsStage, setDepsStage] = useState("Ready to install Python dependencies.");
  const [depsLogs, setDepsLogs] = useState<string[]>([]);
  const [depsError, setDepsError] = useState<string | null>(null);
  const depsLogsEndRef = useRef<HTMLDivElement>(null);

  const models = useMemo(() => entries.filter((e) => !e.isDrafter), [entries]);
  const drafters = useMemo(() => entries.filter((e) => e.isDrafter), [entries]);

  const activeModel = useMemo(
    () => models.find((m) => m.name === config.selectedModel) ?? null,
    [models, config.selectedModel]
  );
  const activeDrafter = useMemo(
    () => drafters.find((d) => d.name === config.selectedDrafter) ?? null,
    [drafters, config.selectedDrafter]
  );

  const persistConfig = async (next: AppConfig) => {
    setConfig(next);
    try {
      await invoke("save_config", { config: next });
    } catch {
      // ignore
    }
  };

  const scanDir = async (dir: string, currentCfg?: AppConfig) => {
    try {
      const list = await invoke<ModelEntry[]>("scan_models", { dir });
      setEntries(list);
      const baseCfg = currentCfg ?? config;
      const mains = list.filter((e) => !e.isDrafter);
      const drafts = list.filter((e) => e.isDrafter);

      let nextModel = baseCfg.selectedModel;
      let nextDrafter = baseCfg.selectedDrafter;

      if (!nextModel || !mains.some((m) => m.name === nextModel)) {
        nextModel = mains[0]?.name ?? null;
        nextDrafter =
          nextModel &&
          drafts.find((d) => d.name.startsWith(nextModel!))?.name
            ? drafts.find((d) => d.name.startsWith(nextModel!))!.name
            : null;
      } else if (nextDrafter && !drafts.some((d) => d.name === nextDrafter)) {
        nextDrafter = null;
      }

      if (
        nextModel !== baseCfg.selectedModel ||
        nextDrafter !== baseCfg.selectedDrafter
      ) {
        await persistConfig({
          ...baseCfg,
          modelDir: dir,
          selectedModel: nextModel,
          selectedDrafter: nextDrafter,
        });
      }
    } catch (e) {
      setLogs((prev) => [
        ...prev,
        {
          ts: nowTimeStr(),
          level: "INFO",
          tone: "default",
          msg: `Scan error: ${e}`,
        },
      ]);
    }
  };

  const handleCheckDepsUpdate = async (autoApply = false) => {
    setDepsChecking(true);
    try {
      const res = await invoke<DepsUpdateCheck>("check_deps_updates", {
        modelDir: config.modelDir || null,
      });
      setDepsUpdateNote(res.message);
      setDepsUpdateAvailable(!res.upToDate);
      if (!res.upToDate && autoApply) {
        setDepsUpdating(true);
        setDepsUpdateNote("Updating lookatmyquant & MLX dependencies...");
        try {
          const updated = await invoke<DepsUpdateCheck>("update_dependencies", {
            modelDir: config.modelDir || null,
          });
          setDepsUpdateNote(updated.message);
          setDepsUpdateAvailable(false);
        } catch (e) {
          setDepsUpdateNote(`Auto-update failed: ${e}`);
        } finally {
          setDepsUpdating(false);
        }
      }
    } catch (e) {
      setDepsUpdateNote(`Check failed: ${e}`);
    } finally {
      setDepsChecking(false);
    }
  };

  const handleUpdateDepsNow = async () => {
    setDepsUpdating(true);
    setDepsUpdateNote("Updating lookatmyquant & MLX dependencies...");
    try {
      const res = await invoke<DepsUpdateCheck>("update_dependencies", {
        modelDir: config.modelDir || null,
      });
      setDepsUpdateNote(res.message);
      setDepsUpdateAvailable(false);
    } catch (e) {
      setDepsUpdateNote(`Update failed: ${e}`);
    } finally {
      setDepsUpdating(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const cfg = await invoke<AppConfig>("load_config");
        if (!mounted) return;
        setConfig(cfg);
        await scanDir(cfg.modelDir, cfg);
        const st = await invoke<ServerStatusPayload>("get_server_status");
        if (mounted) setServerStatus(st);
        const dep = await invoke<DependencyStatus>("check_dependencies", {
          modelDir: cfg.modelDir,
        });
        if (mounted) {
          setDepsReady(dep.ready);
          setDepsTargetVenv(dep.targetVenv);
          if (dep.ready && cfg.autoUpdateDeps && st.status === "stopped") {
            const check = await invoke<DepsUpdateCheck>("check_deps_updates", {
              modelDir: cfg.modelDir,
            });
            if (!mounted) return;
            setDepsUpdateNote(check.message);
            setDepsUpdateAvailable(!check.upToDate);
            if (!check.upToDate) {
              setDepsUpdating(true);
              setDepsUpdateNote("Auto-updating dependencies...");
              try {
                const updated = await invoke<DepsUpdateCheck>(
                  "update_dependencies",
                  { modelDir: cfg.modelDir }
                );
                if (mounted) {
                  setDepsUpdateNote(updated.message);
                  setDepsUpdateAvailable(false);
                }
              } catch (e) {
                if (mounted) setDepsUpdateNote(`Auto-update failed: ${e}`);
              } finally {
                if (mounted) setDepsUpdating(false);
              }
            }
          }
        }
      } catch {
        // ignore outside tauri
      }
    })();

    const unlistenLog = listen<ServerLogEvent>("server-log", (e) => {
      setLogs((prev) => [...prev.slice(-999), e.payload]);
    });
    const unlistenStatus = listen<ServerStatusPayload>("server-status", (e) => {
      setServerStatus(e.payload);
    });
    const unlistenDeps = listen<DepsProgressEvent>("deps-progress", (e) => {
      const p = e.payload;
      setDepsPercent(p.percent);
      setDepsStage(p.stage);
      if (p.logLine) {
        setDepsLogs((prev) => [...prev.slice(-80), p.logLine]);
      }
      if (p.error) {
        setDepsError(p.error);
      }
    });

    return () => {
      mounted = false;
      unlistenLog.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenDeps.then((f) => f());
    };
  }, []);

  useEffect(() => {
    depsLogsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [depsLogs]);

  // System info poll
  useEffect(() => {
    const refresh = async () => {
      try {
        const info = await invoke<SystemInfo>("get_system_info");
        setSysInfo(info);
      } catch {
        // ignore
      }
    };
    refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, []);

  // Uptime tick while running
  useEffect(() => {
    if (serverStatus.status !== "running") return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [serverStatus.status]);

  const handleSelectModel = (name: string | null) => {
    let nextDrafter: string | null = null;
    if (name) {
      const matched = drafters.find((d) => d.name.startsWith(name));
      nextDrafter = matched ? matched.name : null;
    }
    persistConfig({
      ...config,
      selectedModel: name,
      selectedDrafter: nextDrafter,
    });
  };

  const handleSelectDrafter = (name: string | null) => {
    persistConfig({
      ...config,
      selectedDrafter: name,
    });
  };

  const handleRun = async () => {
    if (!activeModel) return;
    setLogs([]);
    try {
      const st = await invoke<ServerStatusPayload>("start_server", {
        modelPath: activeModel.path,
        drafterPath: activeDrafter?.path ?? null,
        port: config.port,
      });
      setServerStatus(st);
    } catch (e) {
      setServerStatus((prev) => ({
        ...prev,
        status: "stopped",
        error: String(e),
      }));
      setLogs((prev) => [
        ...prev,
        {
          ts: nowTimeStr(),
          level: "INFO",
          tone: "default",
          msg: `Failed to start: ${e}`,
        },
      ]);
    }
  };

  const handleStop = async () => {
    try {
      const st = await invoke<ServerStatusPayload>("stop_server");
      setServerStatus(st);
    } catch (e) {
      setLogs((prev) => [
        ...prev,
        {
          ts: nowTimeStr(),
          level: "INFO",
          tone: "default",
          msg: `Stop error: ${e}`,
        },
      ]);
    }
  };

  const handlePickDir = async () => {
    try {
      const picked = await invoke<string | null>("pick_model_dir");
      if (picked) {
        const next = { ...config, modelDir: picked };
        await persistConfig(next);
        await scanDir(picked, next);
      }
    } catch {
      // ignore
    }
  };

  const handleDirInput = async (dir: string) => {
    const next = { ...config, modelDir: dir };
    await persistConfig(next);
    await scanDir(dir, next);
  };

  const handleFetchHfModels = async () => {
    setHfLoading(true);
    setHfError(null);
    try {
      const list = await invoke<HfModelEntry[]>("list_hf_models", {
        modelDir: config.modelDir,
      });
      setHfModels(list);
    } catch (e) {
      setHfError(String(e));
    } finally {
      setHfLoading(false);
    }
  };

  const handleDownload = async (repoId: string) => {
    setDownloadingId(repoId);
    setDownloadMsg(`Downloading ${repoId}...`);
    try {
      await invoke<string>("download_model", {
        repoId,
        modelDir: config.modelDir,
      });
      setDownloadMsg(`Downloaded ${repoId}.`);
      await scanDir(config.modelDir);
      setHfModels((prev) =>
        prev.map((m) => (m.id === repoId ? { ...m, installed: true } : m))
      );
    } catch (e) {
      setDownloadMsg(String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleInstallDependencies = async () => {
    setDepsInstalling(true);
    setDepsError(null);
    setDepsPercent(2);
    setDepsStage("pip install mlx mlx-lm numpy huggingface-hub lookatmyquant");
    setDepsLogs([]);
    try {
      const res = await invoke<DependencyStatus>("install_dependencies");
      if (res.ready) {
        setDepsPercent(100);
        setDepsStage("Dependencies installed!");
        setTimeout(() => {
          setDepsReady(true);
          setDepsInstalling(false);
        }, 450);
      } else {
        setDepsError(`Missing packages: ${res.missing.join(", ")}`);
        setDepsInstalling(false);
      }
    } catch (e) {
      setDepsError(String(e));
      setDepsInstalling(false);
    }
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background text-foreground select-none">
      <div
        aria-hidden={!depsReady}
        inert={!depsReady ? true : undefined}
        className={cn(
          "flex h-full w-full overflow-hidden transition-[filter] duration-300",
          !depsReady && "blur-md pointer-events-none select-none"
        )}
      >
      {/* Sidebar */}
      <aside className="w-[196px] shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="px-4 pt-5 pb-4">
          <img
            src={logoUrl}
            alt="LookAtMyQuant"
            className="w-[162px] h-auto object-contain select-none"
            draggable={false}
          />
        </div>

        <nav className="flex-1 px-2.5 py-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={cn(
                  "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <Icon className="size-4 opacity-90" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="px-4 pb-4">
          <Separator className="mb-3" />
          <p className="text-[11px] font-medium text-muted-foreground truncate">
            {sysInfo.chipName && sysInfo.ramTotalGb > 0
              ? `${sysInfo.chipName} • ${Math.round(sysInfo.ramTotalGb)} GB RAM`
              : "Detecting hardware..."}
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 overflow-hidden bg-background">
        <div className="h-full overflow-y-auto px-8 py-7">
          {page === "status" && (
            <StatusPage
              serverStatus={serverStatus}
              activeModel={activeModel}
              activeDrafter={activeDrafter}
              sysInfo={sysInfo}
              uptimeText={
                serverStatus.status === "running"
                  ? formatUptime(serverStatus.startedAtMs, nowMs)
                  : serverStatus.status === "starting"
                  ? "Starting..."
                  : "Not running"
              }
              autoUpdate={config.autoUpdate}
              autoUpdateDeps={config.autoUpdateDeps}
              guiUpdateNote={guiUpdateNote}
              depsUpdateNote={depsUpdateNote}
              depsChecking={depsChecking}
              depsUpdating={depsUpdating}
              depsUpdateAvailable={depsUpdateAvailable}
              onToggleAutoUpdate={(val) =>
                persistConfig({ ...config, autoUpdate: val })
              }
              onToggleAutoUpdateDeps={(val) =>
                persistConfig({ ...config, autoUpdateDeps: val })
              }
              onCheckGuiUpdate={() =>
                setGuiUpdateNote(
                  `Checked at ${nowTimeStr()} — no GitHub releases published yet.`
                )
              }
              onCheckDepsUpdate={() =>
                handleCheckDepsUpdate(config.autoUpdateDeps)
              }
              onUpdateDepsNow={handleUpdateDepsNow}
              onRun={handleRun}
              onStop={handleStop}
            />
          )}
          {page === "server" && (
            <ServerPage
              port={config.port}
              serverStatus={serverStatus}
              logs={logs}
              onPortChange={(port) => persistConfig({ ...config, port })}
              onClearLogs={() => setLogs([])}
            />
          )}
          {page === "models" && (
            <ModelsPage
              modelDir={config.modelDir}
              models={models}
              drafters={drafters}
              activeModel={activeModel}
              activeDrafter={activeDrafter}
              totalRamGb={sysInfo.ramTotalGb}
              serverRunning={serverStatus.status !== "stopped"}
              hfModels={hfModels}
              hfLoading={hfLoading}
              hfError={hfError}
              downloadingId={downloadingId}
              downloadMsg={downloadMsg}
              onSelectModel={handleSelectModel}
              onSelectDrafter={handleSelectDrafter}
              onPickDir={handlePickDir}
              onDirInput={handleDirInput}
              onRescan={() => scanDir(config.modelDir)}
              onFetchHfModels={handleFetchHfModels}
              onDownload={handleDownload}
            />
          )}
          {page === "about" && <AboutPage />}
        </div>
      </main>
      </div>

      {!depsReady && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md p-6">
          <Card className="w-full max-w-md border-white/15 bg-card/95 shadow-2xl py-0 gap-0">
            <CardContent className="p-6 space-y-5">
              <div className="space-y-2">
                <img
                  src={logoUrl}
                  alt="LookAtMyQuant"
                  className="w-40 h-auto object-contain select-none mb-3"
                  draggable={false}
                />
                <h2 className="text-lg font-semibold tracking-tight text-foreground">
                  Python Runtime Required
                </h2>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Install <span className="font-mono text-foreground/90">mlx</span>,{" "}
                  <span className="font-mono text-foreground/90">mlx-lm</span>,{" "}
                  <span className="font-mono text-foreground/90">huggingface-hub</span>, and{" "}
                  <span className="font-mono text-foreground/90">lookatmyquant</span> into your local environment to unlock the app.
                </p>
                {depsTargetVenv && (
                  <p className="text-[11px] font-mono text-muted-foreground/80 truncate">
                    {depsTargetVenv}
                  </p>
                )}
              </div>

              {depsInstalling ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-mono text-foreground truncate">
                      {depsStage}
                    </span>
                    <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">
                      {depsPercent}%
                    </span>
                  </div>
                  <Progress
                    value={depsPercent}
                    className="w-full [&>[data-slot=progress-track]]:h-2 [&_[data-slot=progress-indicator]]:bg-primary"
                  />
                  <div className="h-32 overflow-y-auto rounded-lg border border-white/10 bg-[#0d0d10] p-2.5 font-mono text-[11px] leading-relaxed text-zinc-400 select-text">
                    {depsLogs.length === 0 ? (
                      <span>Preparing environment...</span>
                    ) : (
                      depsLogs.map((line, idx) => (
                        <div key={idx} className="truncate">
                          {line}
                        </div>
                      ))
                    )}
                    <div ref={depsLogsEndRef} />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {depsError && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs font-mono text-red-300 max-h-32 overflow-y-auto whitespace-pre-wrap select-text">
                      {depsError}
                    </div>
                  )}
                  <Button
                    onClick={handleInstallDependencies}
                    className="w-full h-10 text-sm font-medium"
                  >
                    <Download className="size-4" />
                    {depsError ? "Retry Install Dependencies" : "Install Dependencies"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
