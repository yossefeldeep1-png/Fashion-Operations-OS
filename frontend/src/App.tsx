import { useMemo, useState, useCallback, useEffect } from "react";
import AuthGate, { type LiveData } from "./AuthGate";
import {
  addReceiptLine,
  completePutaway,
  createProductSku,
  createReceipt,
  confirmReceipt,
  recordQC,
  uploadQcEvidence,
  removeQcEvidence,
  getInboundDashboard,
  getInboundJobTrace,
  getInboundOptionsTyped,
  getOperationalReadiness,
  getPutawayTasks,
  getReceiptActivity,
  getReceiptAudit,
  getReceiptDetail,
  getReceiptNotes,
  addReceiptNote,
  getReceiptDocuments,
  uploadReceiptDocument,
  downloadReceiptDocument,
  mapDashboard,
  mapPutawayTasks,
  mapReceiptLines,
  newIdempotencyKey,
  scanPutawayBin,
  startPutaway,
  startReceiving,
  type InboundOptions,
  type LiveLine,
  type LivePutawayTask,
  type OperationalReadiness,
} from "./lib/mita";

// =============================================================================
// TYPES
// =============================================================================

type Status =
  | "waiting_truck" | "truck_registered" | "receiving" | "identifying"
  | "counting" | "qc_in_progress" | "confirmed" | "putaway_pending"
  | "putaway_in_progress" | "completed" | "validation_failed" | "cancelled";

type InboundTab = "Control Tower" | "Receiving" | "Validation" | "QC" | "Putaway" | "Exceptions" | "Workforce" | "Reports";

type DrawerTab = "Overview" | "Receipt Lines" | "Timeline" | "Audit" | "Relationships" | "Documents" | "Notes" | "Metrics";

type SortKey = "id" | "supplier" | "status" | "expected" | "received" | "difference" | "variance" | "damage" | "age" | "owner" | "updated";
type SortDir = "asc" | "desc";

type VehicleType = "supplier" | "company" | "carrier";

type PutawayTask = LivePutawayTask;

type Job = {
  id: string; // stable database UUID used for selection and joins
  jobNumber?: string; receiptId?: string | null; createdAt?: string;
  receipt: string; supplier: string; po: string; warehouse: string;
  status: Status; expected: number; received: number; damage: number;
  ageMinutes: number; age: string; owner: string; updated: string;
  issue?: "Validation" | "QC" | "Variance" | "Aging" | "Blocked" | "Cancelled";
  dock?: string; vehicleNumber?: string; driver?: string; vehicleType?: VehicleType;
};

type ActionDef = { label: string; primary?: boolean; fn: () => void };
type StageInfo = { id: Status; label: string; tooltip: string };

type BinResult = { valid: boolean; reason: string; available?: number };

/** Validate only against the current, permission-checked location data returned by Supabase. */
function validateBin(binCode: string, qty: number, bins: InboundOptions["bins"]): BinResult {
  const code = binCode.trim();
  if (!code) return { valid: false, reason: "Scan or enter a destination bin code." };
  if (!bins.length) return { valid: false, reason: "Live location data is unavailable. Reload before validating a bin." };
  const bin = bins.find((item) => item.code.toLowerCase() === code.toLowerCase());
  if (!bin) return { valid: false, reason: "Bin not found in the current active-bin list." };
  if (bin.status.toLowerCase() === "blocked") return { valid: false, reason: "This bin is blocked." };
  if (bin.overCapacity) return { valid: false, reason: "The database reports that this bin is already over capacity." };
  const available = Number.isFinite(bin.availableCapacity) ? bin.availableCapacity : bin.capacity - bin.onHand;
  if (!Number.isFinite(available) || available < qty) return { valid: false, reason: `Insufficient live capacity — ${Math.max(0, available || 0)} available, ${qty} required.`, available };
  return { valid: true, reason: `${bin.code} · ${available} units available`, available };
}

// =============================================================================
// CONSTANTS
// =============================================================================

const STAGE_DEFS: StageInfo[] = [
  { id: "waiting_truck", label: "Waiting Truck", tooltip: "Awaiting truck arrival at dock" },
  { id: "truck_registered", label: "Registered", tooltip: "Trucks registered at gate" },
  { id: "receiving", label: "Receiving", tooltip: "Active receiving sessions" },
  { id: "identifying", label: "Identifying", tooltip: "SKU identification in progress" },
  { id: "counting", label: "Counting", tooltip: "Physical count in progress" },
  { id: "qc_in_progress", label: "QC Review", tooltip: "Under quality control review" },
  { id: "confirmed", label: "Confirmed", tooltip: "Receipt confirmed, awaiting putaway" },
  { id: "putaway_pending", label: "Putaway Pending", tooltip: "In putaway queue" },
  { id: "putaway_in_progress", label: "Putaway Active", tooltip: "Putaway tasks in progress" },
  { id: "completed", label: "Completed", tooltip: "Completed this shift" },
  { id: "validation_failed", label: "Val. Failed", tooltip: "Validation failures blocking receipt" },
  { id: "cancelled", label: "Cancelled", tooltip: "Cancelled this shift" },
];

const INBOUND_TABS: InboundTab[] = ["Control Tower", "Receiving", "Validation", "QC", "Putaway", "Exceptions", "Workforce", "Reports"];
const MODULE_NAV = ["Outbound", "Cycle Count", "Problematic", "RTO", "Inventory", "Quality", "Location"];

// =============================================================================
// STYLE MAPS
// =============================================================================

const statusStyle: Record<Status, string> = {
  waiting_truck: "bg-slate-100 text-slate-600 border-slate-200",
  truck_registered: "bg-cyan-50 text-cyan-800 border-cyan-200",
  receiving: "bg-blue-50 text-blue-800 border-blue-200",
  identifying: "bg-amber-50 text-amber-800 border-amber-200",
  counting: "bg-violet-50 text-violet-800 border-violet-200",
  qc_in_progress: "bg-rose-50 text-rose-800 border-rose-200",
  validation_failed: "bg-red-100 text-red-800 border-red-300",
  confirmed: "bg-teal-50 text-teal-800 border-teal-200",
  putaway_pending: "bg-orange-50 text-orange-800 border-orange-200",
  putaway_in_progress: "bg-indigo-50 text-indigo-800 border-indigo-200",
  completed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-200",
};

const stageIndicatorColor: Record<Status, string> = {
  waiting_truck: "bg-slate-400", truck_registered: "bg-cyan-500", receiving: "bg-blue-500",
  identifying: "bg-amber-500", counting: "bg-violet-500", qc_in_progress: "bg-rose-500",
  validation_failed: "bg-red-600", confirmed: "bg-teal-500", putaway_pending: "bg-orange-500",
  putaway_in_progress: "bg-indigo-500", completed: "bg-emerald-500", cancelled: "bg-slate-300",
};

// =============================================================================
// UTILITIES
// =============================================================================

const prettify = (v: string) => v.replace(/_/g, " ");
const difference = (job: Job) => job.received - job.expected;
const variancePct = (job: Job) => job.expected ? (difference(job) / job.expected) * 100 : 0;

function sortJobs(jobs: Job[], key: SortKey, dir: SortDir): Job[] {
  return [...jobs].sort((a, b) => {
    let av: number | string, bv: number | string;
    switch (key) {
      case "id": av = a.id; bv = b.id; break;
      case "supplier": av = a.supplier; bv = b.supplier; break;
      case "status": av = a.status; bv = b.status; break;
      case "expected": av = a.expected; bv = b.expected; break;
      case "received": av = a.received; bv = b.received; break;
      case "difference": av = difference(a); bv = difference(b); break;
      case "variance": av = Math.abs(variancePct(a)); bv = Math.abs(variancePct(b)); break;
      case "damage": av = a.damage; bv = b.damage; break;
      case "age": av = a.ageMinutes; bv = b.ageMinutes; break;
      case "owner": av = a.owner; bv = b.owner; break;
      default: av = a.updated; bv = b.updated;
    }
    if (typeof av === "string") return dir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
    return dir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
  });
}

// =============================================================================
// APP
// =============================================================================

export default function App() {
  return <AuthGate>{(live) => <InboundApp live={live} />}</AuthGate>;
}

type DetailState = { id: string; loading: boolean; error?: string; lines: LiveLine[] | null };
type HistoryEvent = {
  id?: string; eventId?: string; eventType?: string; entityType?: string; entityId?: string;
  actor?: string; actorId?: string; actorRole?: string; reason?: string | null;
  before?: unknown; after?: unknown; beforeData?: unknown; afterData?: unknown;
  createdAt?: string; source?: string; requestId?: string;
};
type HistoryState = { receiptId: string; loading: boolean; events: HistoryEvent[]; error?: string };
const EMPTY_OPTIONS: InboundOptions = { suppliers: [], warehouses: [], purchaseOrders: [], skus: [], bins: [] };

function InboundApp({ live }: { live: LiveData }) {
  const [inboundTab, setInboundTab] = useState<InboundTab>("Control Tower");
  const [jobs, setJobs] = useState<Job[]>(live.jobs);
  const [putawayTasks, setPutawayTasks] = useState<PutawayTask[]>([]);
  const [options, setOptions] = useState<InboundOptions>(EMPTY_OPTIONS);
  const [optionsError, setOptionsError] = useState("");
  const [selected, setSelected] = useState<Job | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("Overview");
  const [showCreate, setShowCreate] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showSkuSetup, setShowSkuSetup] = useState(false);
  const [skuSetupKey, setSkuSetupKey] = useState(() => newIdempotencyKey("create-product-sku"));
  const [readiness, setReadiness] = useState<OperationalReadiness | null>(null);
  const [readinessError, setReadinessError] = useState("");
  const [notice, setNotice] = useState("Connecting to live operations…");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [activity, setActivity] = useState<HistoryState | null>(null);
  const [audit, setAudit] = useState<HistoryState | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  useEffect(() => { setJobs(live.jobs); }, [live.jobs]);

  const reloadOperationalData = useCallback(async () => {
    const results = await Promise.allSettled([
      getInboundDashboard(100),
      getPutawayTasks(200, null),
      getInboundOptionsTyped(),
      getOperationalReadiness(),
    ]);
    if (results[0].status === "fulfilled") {
      try {
        const mapped = mapDashboard(results[0].value) as Job[];
        setJobs(mapped);
        setSelected((current) => current ? (mapped.find((job) => job.id === current.id) ?? current) : current);
      } catch (e) { setNotice(`Dashboard data mapping failed: ${e instanceof Error ? e.message : String(e)}`); }
    } else {
      setNotice(`Dashboard refresh failed: ${results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason)}`);
    }
    if (results[1].status === "fulfilled") setPutawayTasks(mapPutawayTasks(results[1].value));
    else setNotice(`Putaway read failed: ${results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)}`);
    if (results[2].status === "fulfilled") { setOptions(results[2].value); setOptionsError(""); }
    else { setOptionsError(results[2].reason instanceof Error ? results[2].reason.message : String(results[2].reason)); setOptions(EMPTY_OPTIONS); }
    if (results[3].status === "fulfilled") {
      setReadiness(results[3].value as OperationalReadiness);
      setReadinessError("");
    } else {
      setReadiness(null);
      setReadinessError(results[3].reason instanceof Error ? results[3].reason.message : String(results[3].reason));
    }
    return results[0].status === "fulfilled" ? (() => { try { return mapDashboard(results[0].value) as Job[]; } catch { return []; } })() : [];
  }, []);

  useEffect(() => { void reloadOperationalData(); }, [reloadOperationalData]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowCommandPalette(true);
      } else if (event.key === "Escape") {
        setShowCommandPalette(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedId = selected?.id ?? null;
  const selectedReceiptId = selected?.receiptId ?? null;
  useEffect(() => {
    if (!selectedId || !selectedReceiptId) { setDetail(null); return; }
    let cancelled = false;
    setDetail({ id: selectedId, loading: true, lines: null });
    getReceiptDetail(selectedReceiptId)
      .then((raw) => { if (!cancelled) setDetail({ id: selectedId, loading: false, lines: mapReceiptLines(raw) }); })
      .catch((e) => { if (!cancelled) setDetail({ id: selectedId, loading: false, lines: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [selectedId, selectedReceiptId, detailNonce]);

  useEffect(() => {
    if (!selectedId || (drawerTab !== "Timeline" && drawerTab !== "Audit")) return;
    let cancelled = false;
    const targetId = selectedReceiptId ?? selectedId;
    const setState = drawerTab === "Timeline" ? setActivity : setAudit;
    setState({ receiptId: targetId, loading: true, events: [] });
    const request = selectedReceiptId
      ? (drawerTab === "Timeline" ? getReceiptActivity(selectedReceiptId) : getReceiptAudit(selectedReceiptId, 100))
      : getInboundJobTrace(selectedId);
    request.then((raw) => {
      const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const rawEvents = Array.isArray(root.events) ? root.events : Array.isArray(root.timeline) ? root.timeline : [];
      const events = rawEvents as HistoryEvent[];
      if (!cancelled) setState({ receiptId: targetId, loading: false, events });
    }).catch((e) => {
      if (!cancelled) setState({ receiptId: targetId, loading: false, events: [], error: e instanceof Error ? e.message : String(e) });
    });
    return () => { cancelled = true; };
  }, [selectedId, selectedReceiptId, drawerTab, detailNonce]);

  const [activeStage, setActiveStage] = useState<Status | "all">("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("age");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showFilters, setShowFilters] = useState(false);
  const [filterOwner, setFilterOwner] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterVariance, setFilterVariance] = useState<"all" | "ok" | "warn" | "alert">("all");
  const [filterIssue, setFilterIssue] = useState<"all" | "issue">("all");
  const [filterAge, setFilterAge] = useState<"all" | "fresh" | "aging" | "critical">("all");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);

  const stageCounts = useMemo(() => {
    const c: Partial<Record<Status, number>> = {};
    for (const j of jobs) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [jobs]);

  const stageAttention = useMemo(() => {
    const a: Partial<Record<Status, number>> = {};
    for (const j of jobs) if (j.issue) a[j.status] = (a[j.status] ?? 0) + 1;
    return a;
  }, [jobs]);

  const stageAging = useMemo(() => {
    const a: Partial<Record<Status, number>> = {};
    for (const j of jobs) if (j.ageMinutes > 240) a[j.status] = (a[j.status] ?? 0) + 1;
    return a;
  }, [jobs]);

  const kpis = useMemo(() => {
    const open = jobs.filter((j) => j.status !== "completed" && j.status !== "cancelled");
    const rcv = jobs.filter((j) => j.status === "receiving");
    const vf = jobs.filter((j) => j.status === "validation_failed");
    const qcJ = jobs.filter((j) => j.status === "qc_in_progress");
    const pp = jobs.filter((j) => j.status === "putaway_pending");
    const pip = jobs.filter((j) => j.status === "putaway_in_progress");
    const comp = jobs.filter((j) => j.status === "completed");
    const withR = jobs.filter((j) => j.received > 0 && j.expected > 0);
    const avgVar = withR.length ? withR.reduce((s, j) => s + Math.abs(variancePct(j)), 0) / withR.length : 0;
    return {
      openCount: open.length, rcvCount: rcv.length,
      unassRcv: rcv.filter((j) => j.owner === "Unassigned").length,
      vfCount: vf.length, qcCount: jobs.filter((j) => j.status === "counting" || j.status === "qc_in_progress").length,
      totalDmg: qcJ.reduce((s, j) => s + j.damage, 0),
      ppCount: pp.length, ppAging: pp.filter((j) => j.ageMinutes > 240).length,
      pipCount: pip.length, compCount: comp.length, avgVar,
    };
  }, [jobs]);

  const intelSignals = useMemo(() => {
    const critical: { tone: "red" | "rose"; signal: string; context: string; rootCause: string; nextAction: string; onClick: () => void }[] = [];
    const warning: { tone: "amber"; signal: string; context: string; rootCause: string; nextAction: string; onClick: () => void }[] = [];
    const health: { tone: "green"; signal: string; context: string; rootCause: string; nextAction: string; onClick: () => void }[] = [];

    const vf = jobs.filter((j) => j.status === "validation_failed");
    if (vf.length) critical.push({ tone: "red", signal: `${vf.length} validation failure${vf.length > 1 ? "s" : ""}`, context: vf.slice(0, 2).map((j) => j.id).join(" · "), rootCause: "Barcode conflicts blocking receipt confirmation", nextAction: "Review Issues", onClick: () => setActiveStage("validation_failed") });
    const qcD = jobs.filter((j) => j.status === "qc_in_progress" && j.damage > 0);
    if (qcD.length) { const dmg = qcD.reduce((s, j) => s + j.damage, 0); critical.push({ tone: "rose", signal: `${dmg} QC damage units`, context: `${qcD[0].supplier} · ${qcD[0].receipt}`, rootCause: "Damage logged during inbound · pending QC sign-off", nextAction: "Open QC", onClick: () => { setSelected(qcD[0]); setDrawerTab("Overview"); } }); }
    const agP = jobs.filter((j) => j.status === "putaway_pending" && j.ageMinutes > 240);
    if (agP.length) warning.push({ tone: "amber", signal: `${agP.length} putaway job${agP.length > 1 ? "s" : ""} aging`, context: agP.map((j) => j.id.split("-").pop()).join(", ") + " · >4h", rootCause: "Putaway queue backlog · no task assignment", nextAction: "View queue", onClick: () => { setInboundTab("Putaway"); } });
    const unR = jobs.filter((j) => j.status === "receiving" && j.owner === "Unassigned");
    if (unR.length) warning.push({ tone: "amber", signal: "Unassigned receiving dock", context: `${unR[0].id} · ${unR[0].supplier} · ${unR[0].dock ?? ""}`, rootCause: "Receiving session without owner", nextAction: "Inspect", onClick: () => { setSelected(unR[0]); setDrawerTab("Overview"); } });
    const hiV = jobs.filter((j) => j.received > 0 && Math.abs(variancePct(j)) > 1 && j.status !== "completed" && j.status !== "cancelled");
    if (hiV.length) { const w = hiV.reduce((a, b) => Math.abs(variancePct(a)) > Math.abs(variancePct(b)) ? a : b); warning.push({ tone: "amber", signal: "Variance above the app review threshold", context: `${w.supplier} · ${variancePct(w) > 0 ? "+" : ""}${variancePct(w).toFixed(1)}%`, rootCause: `${Math.abs(difference(w))} units ${difference(w) > 0 ? "over" : "under"} expected`, nextAction: "Review", onClick: () => { setSelected(w); setDrawerTab("Overview"); } }); }
    const comp = jobs.filter((j) => j.status === "completed");
    if (comp.length) health.push({ tone: "green", signal: `${comp.length} completed job${comp.length === 1 ? "" : "s"}`, context: "Live dashboard snapshot", rootCause: "Historical comparison is not connected; trend change is not calculated", nextAction: "View", onClick: () => setActiveStage("completed") });
    return { critical, warning, health };
  }, [jobs]);

  const owners = useMemo(() => Array.from(new Set(jobs.map((j) => j.owner).filter((o) => !["Unassigned", "System", "Gate System", "Dock 03"].includes(o)))), [jobs]);
  const suppliers = useMemo(() => Array.from(new Set(jobs.map((j) => j.supplier))).sort(), [jobs]);

  const visibleJobs = useMemo(() => {
    const list = jobs.filter((j) => {
      const q = [j.id, j.jobNumber, j.receipt, j.supplier, j.po].join(" ").toLowerCase().includes(query.toLowerCase());
      const st = activeStage === "all" || j.status === activeStage;
      const ow = !filterOwner || j.owner === filterOwner;
      const su = !filterSupplier || j.supplier === filterSupplier;
      const vp = Math.abs(variancePct(j));
      const va = filterVariance === "all" || (filterVariance === "ok" && vp <= 1) || (filterVariance === "warn" && vp > 1 && vp <= 3) || (filterVariance === "alert" && vp > 3);
      const is = filterIssue === "all" || (filterIssue === "issue" && !!j.issue);
      const ag = filterAge === "all" || (filterAge === "fresh" && j.ageMinutes < 60) || (filterAge === "aging" && j.ageMinutes >= 60 && j.ageMinutes < 240) || (filterAge === "critical" && j.ageMinutes >= 240);
      return q && st && ow && su && va && is && ag;
    });
    return sortJobs(list, sortKey, sortDir);
  }, [activeStage, jobs, query, sortKey, sortDir, filterOwner, filterSupplier, filterVariance, filterIssue, filterAge]);

  const activeFilterCount = [filterOwner ? 1 : 0, filterSupplier ? 1 : 0, filterVariance !== "all" ? 1 : 0, filterIssue !== "all" ? 1 : 0, filterAge !== "all" ? 1 : 0, activeStage !== "all" ? 1 : 0].reduce((a, b) => a + b, 0);

  const selectJob = useCallback((job: Job) => { setSelected(job); setDrawerTab("Overview"); }, []);

  const selectJobTab = useCallback((job: Job, tab: DrawerTab) => { setSelected(job); setDrawerTab(tab); }, []);

  const traceEntity = useCallback((kind: string, value: string) => {
    if (kind === "supplier" || kind === "po") { setQuery(value); setInboundTab("Receiving"); setNotice(`Receiving filtered by ${kind.toUpperCase()} · ${value}`); }
    else setNotice(`${value} · ${kind} owner module is not yet integrated (planned)`);
  }, []);

  const updateSelected = useCallback(async (nextStatus: Status, message: string) => {
    if (!selected) return;
    if (nextStatus === "receiving") {
      if (!selected.receiptId) {
        setNotice("Cannot start receiving: this job has no linked receipt ID. No change was made.");
        setDrawerTab("Overview");
        return;
      }
      try {
        await startReceiving(selected.receiptId);
        setNotice(`Receiving started · ${selected.jobNumber ?? selected.id}`);
        await reloadOperationalData();
        setDrawerTab("Receipt Lines");
      } catch (e) {
        setNotice(`Start Receiving failed · ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    setNotice(`${message} · This action is not connected to a validated backend operation yet; no database change was made.`);
  }, [selected, reloadOperationalData]);

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }, [sortKey]);

  const toggleRow = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedRows((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const toggleAllRows = useCallback(() => {
    setSelectedRows((prev) => prev.size === visibleJobs.length ? new Set() : new Set(visibleJobs.map((j) => j.id)));
  }, [visibleJobs]);

  const stageActions = useMemo((): ActionDef[] => {
    if (!selected) return [];
    const s = selected.status;
    const audit: ActionDef = { label: "Audit", fn: () => setDrawerTab("Audit") };
    const view: ActionDef = { label: "View", fn: () => setDrawerTab("Overview") };
    if (s === "waiting_truck") return [{ label: "Registration unavailable", fn: () => setNotice(`Cannot register legacy job ${selected.jobNumber ?? selected.id}: no protected truck-registration RPC exists yet. Use Create Inbound Job for a new receipt; no database change was made.`) }, { label: "Open", fn: () => setDrawerTab("Overview") }];
    if (s === "truck_registered") return [{ label: "Start Receiving", primary: true, fn: () => updateSelected("receiving", `Receiving started · ${selected.jobNumber ?? selected.id}`) }, { label: "Open", fn: () => setNotice(`${selected.jobNumber ?? selected.id} opened`) }];
    if (s === "receiving") return [{ label: "Continue Receiving", primary: true, fn: () => setDrawerTab("Receipt Lines") }, { label: "Open Audit", fn: () => setDrawerTab("Audit") }];
    if (s === "identifying") return [{ label: "Open Receipt Lines", primary: true, fn: () => setDrawerTab("Receipt Lines") }, { label: "Open Audit", fn: () => setDrawerTab("Audit") }];
    if (s === "counting") return [{ label: "Record QC", primary: true, fn: () => setDrawerTab("Receipt Lines") }, { label: "Open Audit", fn: () => setDrawerTab("Audit") }];
    if (s === "qc_in_progress") return [{ label: "Review QC", primary: true, fn: () => setDrawerTab("Receipt Lines") }, { label: "Open Audit", fn: () => setDrawerTab("Audit") }];
    if (s === "validation_failed") return [{ label: "Review Issues", primary: true, fn: () => setDrawerTab("Audit") }, { label: "Open Receipt Lines", fn: () => setDrawerTab("Receipt Lines") }];
    if (s === "confirmed") return [{ label: "View Receipt", primary: true, fn: () => setDrawerTab("Receipt Lines") }, { label: "View Putaway", fn: () => setDrawerTab("Relationships") }];
    if (s === "putaway_pending") return [{ label: "View Putaway", primary: true, fn: () => setInboundTab("Putaway") }, { label: "View Tasks", fn: () => setDrawerTab("Relationships") }];
    if (s === "putaway_in_progress") return [{ label: "View Tasks", primary: true, fn: () => setDrawerTab("Relationships") }, { label: "Overview", fn: () => setDrawerTab("Overview") }];
    if (s === "completed" || s === "cancelled") return [view, audit];
    return [{ label: "Open", fn: () => setNotice(`${selected.jobNumber ?? selected.id} opened`) }];
  }, [selected, updateSelected]);

  const clearAllFilters = useCallback(() => {
    setActiveStage("all"); setQuery(""); setFilterOwner(""); setFilterSupplier("");
    setFilterVariance("all"); setFilterIssue("all"); setFilterAge("all");
  }, []);

  const createJob = useCallback(async (created: { jobId: string; jobNumber: string; receiptId: string; receiptNumber: string }) => {
    setShowCreate(false);
    let startError = "";
    try {
      await startReceiving(created.receiptId);
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
    }
    const refreshed = await reloadOperationalData();
    const match = refreshed.find((job) => job.id === created.jobId || job.receiptId === created.receiptId);
    if (match) {
      setSelected(match);
      setDrawerTab("Receipt Lines");
      setInboundTab("Receiving");
      setNotice(startError
        ? `Created ${created.jobNumber}, but Start Receiving failed: ${startError}. The record is preserved; do not create it again.`
        : `Created and started receiving · ${created.jobNumber}`);
    } else {
      setNotice(`Receipt ${created.receiptNumber} was created, but the dashboard refresh did not return job ${created.jobNumber}. Use Reload to reconcile; do not submit the create form again.`);
    }
  }, [reloadOperationalData]);

  const updatePutawayTask = useCallback(async (taskId: string, update: Partial<PutawayTask>, _allTasks: PutawayTask[]) => {
    const task = putawayTasks.find((t) => t.id === taskId);
    try {
      if (update.status === "in_progress") {
        await startPutaway(taskId);
        setNotice(`Putaway started · ${task?.jobNumber ?? taskId}`);
      } else if (update.status === "completed") {
        const code = update.actualBin?.trim();
        const bin = options.bins.find((b) => b.code.toLowerCase() === (code ?? "").toLowerCase());
        if (!bin) throw new Error(`Bin ${code || "(empty)"} is not in the active database bin list. No stock movement was made.`);
        const taskWarehouse = options.warehouses.find((w) => w.code === task?.warehouse);
        if (!taskWarehouse || bin.warehouseId !== taskWarehouse.id) throw new Error(`Destination bin ${bin.code} is not in the task warehouse (${task?.warehouse ?? "unknown"}). No stock movement was made.`);
        const binCheck = validateBin(bin.code, task?.qty ?? 0, options.bins);
        if (!binCheck.valid) throw new Error(`${bin.code}: ${binCheck.reason}`);
        await scanPutawayBin(taskId, bin.id);
        await completePutaway(taskId);
        setNotice(`Putaway completed · ${task?.sku ?? taskId} → ${bin.code}`);
      } else {
        setNotice("This task change is not a supported backend action; no local-only status change was made.");
        return;
      }
      await reloadOperationalData();
      setDetailNonce((n) => n + 1);
    } catch (e) {
      setNotice(`Putaway action failed · ${e instanceof Error ? e.message : String(e)}. Reconciling the stored state…`);
      await reloadOperationalData();
      setDetailNonce((n) => n + 1);
    }
  }, [putawayTasks, options.bins, reloadOperationalData]);

  const navigateToTab = useCallback((tab: InboundTab, stage?: Status | "all") => {
    setInboundTab(tab);
    if (stage !== undefined) setActiveStage(stage);
  }, []);

  const exceptionsCount = kpis.vfCount + kpis.qcCount + kpis.unassRcv;

  return (
    <div className="h-screen min-w-[1280px] overflow-hidden bg-[#f0f0ec] text-foreground">
      <div className="relative grid h-full grid-cols-[220px_minmax(0,1fr)]">

        {/* === LEFT NAV: Module level only === */}
        <aside className="flex h-full flex-col border-r border-[#1a3530] bg-[#172b27] overflow-hidden">
          <div className="flex items-center gap-2.5 border-b border-[#1f3d38] px-4 py-3.5 flex-shrink-0">
            <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded bg-[#d6b45c] font-mono text-[11px] font-bold text-[#182f2b]">M</span>
            <div className="leading-tight">
              <span className="font-slab text-[15px] font-bold tracking-[0.02em] text-white">MITA-OS</span>
              <p className="font-mono text-[9px] text-[#6b9487] tracking-[0.06em]">v1.0 · Warehouse Group</p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-hidden py-3">
            <div className="px-4 mb-1">
              <p className="font-mono text-[8px] uppercase tracking-[0.18em] text-[#4a7268]">Warehouse Group</p>
            </div>
            <div className="flex w-full items-center gap-2 px-4 py-1.5 bg-[#284d47]">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d6b45c]" />
              <span className="flex-1 text-[13px] font-semibold text-white">Inbound</span>
              {exceptionsCount > 0 && <span className="rounded-full bg-red-600 text-white px-1.5 font-mono text-[8px] font-bold">{exceptionsCount}</span>}
            </div>
            <div className="mt-2 px-2 space-y-0.5">
              {MODULE_NAV.map((item) => (
                <button key={item} type="button" disabled title={`${item} backend module is not connected in this release`} className="flex w-full cursor-not-allowed items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[13px] text-[#7a9d94] opacity-70 transition">
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#3a5e55]" />{item}
                  <span className="ml-auto font-mono text-[9px] text-[#3a5e55]">Soon</span>
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-[#1f3d38] px-3 py-3 space-y-0.5 flex-shrink-0">
            <div className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[11px] text-[#97b5ad]" role="status">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live operational data
            </div>
            <button type="button" onClick={() => setShowCommandPalette(true)} className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[11px] text-[#97b5ad] hover:bg-[#1f3d38]">
              <span className="font-mono text-[10px]">⌘</span> Command palette
              <kbd className="ml-auto font-mono text-[9px] text-[#3a5e55]">⌘K</kbd>
            </button>
          </div>
        </aside>

        {/* === MAIN WORKSPACE === */}
        <main className="flex min-w-0 flex-col overflow-hidden">

          {/* Top header */}
          <header className="flex h-11 flex-shrink-0 items-center border-b border-border bg-card px-4 gap-3">
            <div className="flex items-center gap-1.5 border-r border-border pr-4 text-[12px] font-semibold text-[#1b4740]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {selected?.warehouse ?? (Array.from(new Set(jobs.map((job) => job.warehouse))).length === 1 ? jobs[0]?.warehouse : "All Warehouses")}
              <span className="ml-1 text-muted-foreground text-[10px]">⌄</span>
            </div>
            <div className="flex max-w-[360px] flex-1 items-center gap-2 rounded border border-border bg-[#f7f8f5] px-2.5 py-1 text-muted-foreground">
              <span className="text-[12px]">⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} className="w-full bg-transparent text-[12px] outline-none placeholder:text-[#9ba49f]" placeholder="Search job, receipt, supplier, PO…" />
              {query && <button onClick={() => setQuery("")} className="text-xs text-muted-foreground hover:text-foreground">×</button>}
            </div>
            <div className="ml-auto flex items-center gap-3">
              <button type="button" title="Open exceptions" aria-label="Open exceptions" onClick={() => setInboundTab("Exceptions")} className="relative text-[#42504b] hover:text-[#1b4740]">
                <span className="text-base">♢</span>
                {exceptionsCount > 0 && <span className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-rose-500" />}
              </button>
              <div className="h-5 w-px bg-border" />
              <div className="flex items-center gap-2">
                <div className="grid h-7 w-7 place-items-center rounded-full bg-[#d5e5db] text-[10px] font-bold text-[#1e4840]">{live.userEmail.slice(0, 2).toUpperCase()}</div>
                <div className="leading-tight">
                  <p className="max-w-[180px] truncate text-[12px] font-semibold">{live.userEmail}</p>
                  <p className="text-[10px] text-muted-foreground">Signed in · live data</p>
                </div>
                <button onClick={() => { void reloadOperationalData(); }} className="rounded border border-border px-2 py-0.5 text-[10px] font-semibold text-[#35443f] hover:bg-[#f2f5f2]">Reload</button>
                <button onClick={live.onSignOut} className="rounded border border-border px-2 py-0.5 text-[10px] font-semibold text-[#35443f] hover:bg-[#f2f5f2]">Sign out</button>
              </div>
            </div>
          </header>

          {/* Inbound page shell */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

            {/* Page header */}
            <div className="flex-shrink-0 flex items-center justify-between border-b border-border bg-card px-4 py-2">
              <div>
                <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground mb-0.5">
                  <span>Warehouse</span><span className="text-[#b0bab5]">/</span><span className="text-[#276157] font-medium">Inbound</span>
                </div>
                <h1 className="font-slab text-[17px] font-bold leading-none tracking-[-0.01em] text-[#17201f]">Inbound</h1>
              </div>
              <div className="flex items-center gap-2">
                {activeFilterCount > 0 && inboundTab === "Receiving" && (
                  <button onClick={clearAllFilters} className="flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100">
                    <span className="font-mono">{activeFilterCount}</span> active · clear
                  </button>
                )}
                <div className="flex items-center gap-1.5 rounded-full border border-[#c6d9ce] bg-[#edf5f0] px-3 py-1 text-[11px] font-medium text-[#276157]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#3e8a64]" />{notice}
                </div>
              </div>
            </div>

            {(readiness && (readiness.activeSkus === 0 || readiness.openPurchaseOrders === 0 || readiness.unlinkedJobs > 0 || readiness.completedReceiptsWithUnfinishedLines > 0 || readiness.inconsistentSkuHierarchy > 0 || readiness.overCapacityBins > 0 || readiness.stockLedgerVariances > 0)) && (
              <section role="status" className="flex-shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[10px] text-amber-950">
                <div className="flex items-start gap-2"><span className="font-bold">Operational readiness warning</span><span className="flex-1 leading-relaxed">
                  {[
                    readiness.activeSkus === 0 ? `No active SKUs (draft: ${readiness.draftSkus}). Create a SKU with real master data before entering receipt lines.` : "",
                    readiness.openPurchaseOrders === 0 ? "No open purchase orders; manual receiving may still be possible." : "",
                    readiness.unlinkedJobs > 0 ? `${readiness.unlinkedJobs} legacy job(s) have no linked receipt; those jobs cannot accept receipt lines.` : "",
                    readiness.completedReceiptsWithUnfinishedLines > 0 ? `${readiness.completedReceiptsWithUnfinishedLines} receipt(s) marked complete have unfinished line state. Review history; the app will not silently rewrite it.` : "",
                    readiness.inconsistentSkuHierarchy > 0 ? `${readiness.inconsistentSkuHierarchy} SKU hierarchy inconsistency/inconsistencies detected.` : "",
                    readiness.overCapacityBins > 0 ? `${readiness.overCapacityBins} bin(s) over capacity.` : "",
                    readiness.stockLedgerVariances > 0 ? `${readiness.stockLedgerVariances} stock ledger variance(s).` : "",
                  ].filter(Boolean).join(" · ")}
                </span><button type="button" onClick={() => { void reloadOperationalData(); }} className="rounded border border-amber-300 bg-white px-2 py-0.5 font-semibold hover:bg-amber-100">Recheck</button></div>
              </section>
            )}
            {readinessError && <p role="status" className="flex-shrink-0 border-b border-border bg-[#f7f9f6] px-4 py-1.5 text-[10px] text-muted-foreground">Operational readiness check unavailable: {readinessError}</p>}

            {/* === INBOUND TAB BAR === */}
            <div className="flex-shrink-0 flex border-b border-border bg-card px-4 gap-0 overflow-x-auto scrollbar-hidden">
              {INBOUND_TABS.map((tab) => {
                const badge = tab === "Validation" ? kpis.vfCount : tab === "QC" ? kpis.qcCount : tab === "Exceptions" ? exceptionsCount : tab === "Putaway" ? kpis.ppAging : 0;
                return (
                  <button key={tab} onClick={() => setInboundTab(tab)}
                    className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[12px] font-semibold transition-colors ${inboundTab === tab ? "border-[#1b4740] text-[#1b4740]" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}>
                    {tab}
                    {badge > 0 && <span className={`rounded-full text-white px-1 font-mono text-[8px] ${tab === "Validation" || tab === "Exceptions" ? "bg-red-600" : tab === "QC" ? "bg-rose-500" : "bg-amber-500"}`}>{badge}</span>}
                  </button>
                );
              })}
            </div>

            {/* === TAB CONTENT === */}
            <div className="min-h-0 flex-1 overflow-hidden">
              {inboundTab === "Control Tower" && <ControlTowerTab jobs={jobs} putawayTasks={putawayTasks} bins={options.bins} selected={selected} onNavigate={navigateToTab} onSelectJob={selectJob} onSelectJobTab={selectJobTab} onTrace={traceEntity} onRefresh={reloadOperationalData} />}
              {inboundTab === "Receiving" && (
                <ReceivingTab
                  jobs={jobs} visibleJobs={visibleJobs} kpis={kpis} intelSignals={intelSignals}
                  stageCounts={stageCounts} stageAttention={stageAttention} stageAging={stageAging}
                  hoveredStage={hoveredStage} setHoveredStage={setHoveredStage}
                  activeStage={activeStage} setActiveStage={setActiveStage}
                  selected={selected} selectJob={selectJob}
                  drawerTab={drawerTab} setDrawerTab={setDrawerTab} stageActions={stageActions}
                  query={query} showFilters={showFilters} setShowFilters={setShowFilters}
                  filterOwner={filterOwner} setFilterOwner={setFilterOwner}
                  filterSupplier={filterSupplier} setFilterSupplier={setFilterSupplier}
                  filterVariance={filterVariance} setFilterVariance={setFilterVariance}
                  filterIssue={filterIssue} setFilterIssue={setFilterIssue}
                  filterAge={filterAge} setFilterAge={setFilterAge}
                  owners={owners} suppliers={suppliers} activeFilterCount={activeFilterCount}
                  sortKey={sortKey} sortDir={sortDir} handleSort={handleSort}
                  selectedRows={selectedRows} toggleRow={toggleRow} toggleAllRows={toggleAllRows}
                  onCreate={() => setShowCreate(true)} clearAllFilters={clearAllFilters}
                />
              )}
              {inboundTab === "Validation" && <ValidationTab jobs={jobs} onSelectJob={selectJob} />}
              {inboundTab === "QC" && <QCTab jobs={jobs} onSelectJob={(job) => selectJobTab(job, "Receipt Lines")} />}
              {inboundTab === "Putaway" && <PutawayTab jobs={jobs} tasks={putawayTasks} bins={options.bins} onSelectJob={selectJob} onUpdateTask={(id, update) => { void updatePutawayTask(id, update, putawayTasks); }} setNotice={setNotice} />}
              {inboundTab === "Exceptions" && <ExceptionsTab jobs={jobs} tasks={putawayTasks} onSelectJob={selectJob} onNavigate={navigateToTab} />}
              {inboundTab === "Workforce" && <WorkforceTab jobs={jobs} tasks={putawayTasks} />}
              {inboundTab === "Reports" && <ReportsTab jobs={jobs} kpis={kpis} />}
            </div>
          </div>
        </main>

        {/* Drawer A — job inspection */}
        {selected && !showCreate && (
          <JobDrawer job={selected} tab={drawerTab} onTab={setDrawerTab} detail={detail}
            activity={activity} audit={audit} options={options} optionsError={optionsError}
            onAddedLine={async () => { await reloadOperationalData(); setDetailNonce((n) => n + 1); }}
            onClose={() => setSelected(null)}
            onAction={readOnlyMsg}
            putawayTasks={putawayTasks} />
        )}

        {/* Drawer B — create receiving */}
        {showCreate && (
          <CreateReceivingDrawer onClose={() => setShowCreate(false)} options={options} optionsError={optionsError} onCreate={createJob} setNotice={setNotice} />
        )}

        {showSkuSetup && (
          <div className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#172b27]/40 p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSkuSetup(false); }}>
            <section role="dialog" aria-modal="true" aria-label="Product SKU setup" className="my-4 w-full max-w-[680px] rounded border border-border bg-card p-4 shadow-2xl">
              <div className="mb-2 flex items-start justify-between gap-3"><div><h2 className="font-slab text-[16px] font-bold text-[#17201f]">Product SKU setup</h2><p className="text-[10px] text-muted-foreground">Enter real product master values; this will not create an inbound job.</p></div><button type="button" onClick={() => setShowSkuSetup(false)} className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground">Close</button></div>
              <CreateSkuForm options={options} skuKey={skuSetupKey} setSkuKey={setSkuSetupKey} onCreated={async () => { setSkuSetupKey(newIdempotencyKey("create-product-sku")); await reloadOperationalData(); setNotice("Product SKU setup request completed; catalog refreshed from Supabase."); }} />
            </section>
          </div>
        )}

        {showCommandPalette && (
          <div className="absolute inset-0 z-50 flex items-start justify-center bg-[#172b27]/40 p-8" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCommandPalette(false); }}>
            <section role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-[520px] overflow-hidden rounded border border-border bg-card shadow-2xl">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between"><h2 className="font-slab text-[15px] font-bold text-[#17201f]">Command palette</h2><button type="button" aria-label="Close command palette" onClick={() => setShowCommandPalette(false)} className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground">Esc</button></div>
                <p className="mt-1 text-[10px] text-muted-foreground">Choose an action. Navigation and reads are local UI actions; database changes still use the protected Supabase RPCs.</p>
              </div>
              <div className="p-2">
                {[
                  { label: "Open Control Tower", detail: "Live inbound overview", run: () => setInboundTab("Control Tower") },
                  { label: "Open Receiving", detail: "Search and inspect inbound jobs", run: () => setInboundTab("Receiving") },
                  { label: "Create Inbound Job", detail: "Create a receipt and job in Supabase", run: () => { setSelected(null); setShowCreate(true); } },
                  { label: "Create / activate a SKU", detail: "Product master setup using the protected Supabase RPC", run: () => setShowSkuSetup(true) },
                  { label: "Open Exceptions", detail: "View flagged and aging jobs", run: () => setInboundTab("Exceptions") },
                  { label: "Open Putaway", detail: "View live putaway tasks", run: () => setInboundTab("Putaway") },
                  { label: "Open Audit for selected job", detail: selected ? (selected.jobNumber ?? selected.id) : "Select a job first", run: () => { if (selected) setDrawerTab("Audit"); else setNotice("Select a job before opening its audit history."); } },
                  { label: "Open Receipt Lines for selected job", detail: selected ? (selected.jobNumber ?? selected.id) : "Select a job first", run: () => { if (selected) setDrawerTab("Receipt Lines"); else setNotice("Select a job before opening receipt lines."); } },
                  { label: "Reload live data", detail: "Refresh jobs, receipt options, and putaway tasks", run: () => { void reloadOperationalData(); } },
                  { label: "Sign out", detail: live.userEmail, run: () => live.onSignOut() },
                ].map((command) => (
                  <button key={command.label} type="button" onClick={() => { setShowCommandPalette(false); command.run(); }} className="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left hover:bg-[#edf5f0] focus:bg-[#edf5f0] focus:outline-none">
                    <span className="text-[12px] font-semibold text-[#26302f]">{command.label}</span><span className="truncate text-right text-[10px] text-muted-foreground">{command.detail}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// CONTROL TOWER TAB
// =============================================================================

function ControlTowerTab({ jobs, putawayTasks, bins, selected, onNavigate, onSelectJob, onSelectJobTab, onTrace, onRefresh }: {
  jobs: Job[]; putawayTasks: PutawayTask[]; bins: InboundOptions["bins"]; selected: Job | null; onRefresh: () => Promise<Job[]>;
  onNavigate: (tab: InboundTab, stage?: Status | "all") => void;
  onSelectJob: (j: Job) => void; onSelectJobTab: (j: Job, t: DrawerTab) => void;
  onTrace: (kind: string, value: string) => void;
}) {
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [cat, setCat] = useState<RiskCat>("all");
  const [showAllActions, setShowAllActions] = useState(false);
  const [opsQuery, setOpsQuery] = useState("");
  const [opsFilter, setOpsFilter] = useState<"all" | "risk" | "gate" | "intake" | "control" | "storage">("all");
  const [opsSort, setOpsSort] = useState<{ key: string; dir: SortDir }>({ key: "risk", dir: "desc" });

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const refresh = async () => {
    setLoading(true);
    try { await onRefresh(); setRefreshedAt(Date.now()); setNow(Date.now()); }
    finally { setLoading(false); }
  };
  const staleMin = Math.floor((now - refreshedAt) / 60000);
  const isStale = staleMin >= 3;

  const go = (tab: InboundTab, stage?: Status | "all", job?: Job) => {
    if (job) onSelectJob(job);
    onNavigate(tab, tab === "Receiving" ? (stage ?? "all") : stage);
  };
  const goStage = (s: Status) => { const t = stageTarget(s); go(t.tab, t.stage); };

  const m = useMemo(() => {
    const open = jobs.filter(isOpen);
    const sum = (list: Job[], f: (j: Job) => number) => list.reduce((a, j) => a + f(j), 0);
    const assessed = open.map((job) => {
      const reasons = assessJob(job, putawayTasks, bins).sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
      return { job, reasons, top: reasons[0] as Reason | undefined, exposure: exposureOf(job) };
    });
    const items = assessed.filter((a) => a.top).sort((a, b) => SEV_RANK[b.top!.sev] - SEV_RANK[a.top!.sev] || b.exposure - a.exposure || b.job.ageMinutes - a.job.ageMinutes) as RiskItem[];
    const riskOf = new Map(assessed.map((a) => [a.job.id, a.top]));

    const phases = PHASES.map((p) => {
      const list = jobs.filter((j) => p.stages.includes(j.status));
      const units = sum(list, (j) => (p.id === "gate" ? j.expected : j.received));
      const blockedList = list.filter((j) => assessed.find((a) => a.job.id === j.id)?.reasons.some((r) => BLOCKING.has(r.kind)));
      const agingList = list.filter((j) => isOpen(j) && j.ageMinutes > AGING_MIN && !blockedList.includes(j));
      const u = (l: Job[]) => sum(l, (j) => (p.id === "gate" ? j.expected : j.received));
      return { ...p, count: list.length, units, blocked: blockedList.length, aging: agingList.length, blockedU: u(blockedList), agingU: u(agingList), atRisk: list.filter((j) => assessed.find((a) => a.job.id === j.id)?.top).length };
    });

    const reconciled = open.filter((j) => RECON.has(j.status));
    const over = sum(reconciled.filter((j) => difference(j) > 0), difference);
    const under = sum(reconciled.filter((j) => difference(j) < 0), (j) => -difference(j));
    const outTol = reconciled.filter((j) => Math.abs(variancePct(j)) > 1).length;
    const early = open.filter((j) => ["waiting_truck", "truck_registered", "receiving", "identifying", "counting"].includes(j.status));
    const qcJobs = open.filter((j) => j.status === "qc_in_progress");
    const openTasks = putawayTasks.filter((t) => t.status !== "completed");
    const pTasks = (s: PutawayTask["status"]) => putawayTasks.filter((t) => t.status === s);
    const oldestQc = qcJobs.reduce((a, j) => Math.max(a, j.ageMinutes), 0);
    const atRiskItems = items.filter((i) => SEV_RANK[i.top!.sev] >= 2);

    const docks = new Map<string, "occupied" | "waiting" | "blocked">();
    for (const j of open) {
      if (!j.dock || !["waiting_truck", "truck_registered", "receiving", "identifying", "counting", "validation_failed"].includes(j.status)) continue;
      const blocked = j.status === "validation_failed" || j.issue === "Blocked";
      docks.set(j.dock, blocked ? "blocked" : j.status === "waiting_truck" ? "waiting" : "occupied");
    }

    const zones = bins.reduce((acc, bin) => {
      const group = bin.warehouseId || "Unknown warehouse";
      const current = acc[group] ?? { cap: 0, used: 0 };
      current.cap += Math.max(0, bin.capacity);
      current.used += Math.max(0, bin.onHand);
      acc[group] = current;
      return acc;
    }, {} as Record<string, { cap: number; used: number }>);

    const humans = open.filter((j) => !NON_HUMAN.has(j.owner));
    const ownerLoad = Array.from(humans.reduce((acc, j) => {
      const o = acc.get(j.owner) ?? { owner: j.owner, batches: 0, units: 0, risk: 0 };
      o.batches++; o.units += exposureOf(j); if (riskOf.get(j.id)) o.risk++;
      acc.set(j.owner, o); return acc;
    }, new Map<string, { owner: string; batches: number; units: number; risk: number }>()).values()).sort((a, b) => b.units - a.units);
    const intake = open.filter((j) => ["receiving", "identifying", "counting"].includes(j.status));

    const events = [...jobs].filter((j) => /^\d\d:\d\d$/.test(j.updated) || j.updated === "Just now")
      .sort((a, b) => (b.updated === "Just now" ? "99:99" : b.updated).localeCompare(a.updated === "Just now" ? "99:99" : a.updated)).slice(0, 8);
    const times = jobs.map((j) => j.updated).filter((u) => /^\d\d:\d\d$/.test(u)).sort();

    return {
      open, items, riskOf, phases, atRiskItems,
      expected: sum(open, (j) => j.expected), received: sum(open, (j) => j.received),
      remaining: sum(early, (j) => Math.max(j.expected - j.received, 0)),
      over, under, outTol, qcJobs, qcUnits: sum(qcJobs, (j) => j.received), qcDamage: sum(qcJobs, (j) => j.damage), openDamage: sum(open, (j) => j.damage), oldestQc,
      openTasks, pending: pTasks("pending"), active: pTasks("in_progress"), done: pTasks("completed"), blockedT: pTasks("blocked"),
      agingTasks: openTasks.filter((t) => t.ageMinutes > AGING_MIN), taskQty: openTasks.reduce((a, t) => a + t.qty, 0),
      oldestTask: openTasks.reduce((a, t) => Math.max(a, t.ageMinutes), 0),
      shortTasks: pTasksShort(putawayTasks, bins),
      docks, zones, fullBins: bins.filter((b) => b.overCapacity || b.availableCapacity <= 0).length, blockedBins: bins.filter((b) => b.status.toLowerCase() === "blocked").length,
      ownerLoad, unassigned: open.filter((j) => j.owner === "Unassigned"), queueHeld: open.filter((j) => NON_HUMAN.has(j.owner) && j.owner !== "Unassigned"),
      intake, intakeOwned: intake.filter((j) => !NON_HUMAN.has(j.owner)).length, qcOwned: qcJobs.filter((j) => !NON_HUMAN.has(j.owner)).length,
      tasksAssigned: openTasks.filter((t) => t.worker).length,
      cancelled: jobs.filter((j) => j.status === "cancelled").length, completed: jobs.filter((j) => j.status === "completed").length,
      events, asOf: times.length ? times[times.length - 1] : "—",
      pendingByStage: (s: Status) => jobs.filter((j) => j.status === s),
    };
  }, [jobs, putawayTasks, bins]);

  const catCounts: Record<RiskCat, number> = {
    all: m.items.length,
    critical: m.items.filter((i) => i.top.sev === "critical").length,
    high: m.items.filter((i) => i.top.sev === "high").length,
    medium: m.items.filter((i) => i.top.sev === "medium").length,
    aging: m.items.filter((i) => i.job.ageMinutes > AGING_MIN).length,
    blocked: m.items.filter((i) => i.reasons.some((r) => BLOCKING.has(r.kind))).length,
    capacity: m.items.filter((i) => i.reasons.some((r) => r.kind === "Bin capacity")).length,
  };
  const catUnits = (c: RiskCat) => m.items.filter((i) => matchCat(i, c)).reduce((a, i) => a + i.exposure, 0);
  const filteredItems = m.items.filter((i) => matchCat(i, cat));
  const shownItems = showAllActions ? filteredItems : filteredItems.slice(0, 6);

  const state: "critical" | "attention" | "healthy" = catCounts.critical > 0 ? "critical" : m.items.length > 0 ? "attention" : "healthy";
  const traceJob = selected ?? m.items[0]?.job ?? null;

  const opsRows = useMemo(() => {
    const rows = m.open.map((job) => {
      const top = m.riskOf.get(job.id);
      return { job, top, progress: job.expected ? (job.received / job.expected) * 100 : 0, recon: RECON.has(job.status), next: nextFor(job, top) };
    }).filter((r) => {
      const q = [r.job.id, r.job.receipt, r.job.supplier, r.job.po, r.job.dock ?? ""].join(" ").toLowerCase().includes(opsQuery.toLowerCase());
      const f = opsFilter === "all" || (opsFilter === "risk" && !!r.top) || PHASES.find((p) => p.id === opsFilter)?.stages.includes(r.job.status);
      return q && f;
    });
    const val = (r: typeof rows[number]): number | string => {
      switch (opsSort.key) {
        case "receipt": return r.job.receipt; case "supplier": return r.job.supplier; case "stage": return STAGE_DEFS.findIndex((s) => s.id === r.job.status);
        case "expected": return r.job.expected; case "received": return r.job.received; case "variance": return r.recon ? Math.abs(variancePct(r.job)) : -1;
        case "progress": return r.progress; case "age": return r.job.ageMinutes; case "owner": return r.job.owner; default: return r.top ? SEV_RANK[r.top.sev] : 0;
      }
    };
    return rows.sort((a, b) => { const x = val(a), y = val(b); const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number); return opsSort.dir === "asc" ? c : -c; });
  }, [m, opsQuery, opsFilter, opsSort]);
  const sortBy = (key: string) => setOpsSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });

  const stateStyle = { critical: "border-red-300 bg-red-50 text-red-800", attention: "border-amber-300 bg-amber-50 text-amber-800", healthy: "border-emerald-200 bg-emerald-50 text-emerald-800" }[state];
  const stateDot = { critical: "bg-red-600", attention: "bg-amber-500", healthy: "bg-emerald-500" }[state];

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden px-4 pb-6 pt-2.5 space-y-2">

      {/* A. Operational context header */}
      <section className="flex items-center justify-between gap-3 border border-border bg-card px-3 py-2 shadow-[0_1px_2px_rgba(18,40,32,.04)]">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <h2 className="font-slab text-[14px] font-bold leading-none tracking-[0.04em] text-[#17201f]">INBOUND CONTROL TOWER</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[9px] text-muted-foreground">
              <span>Warehouse <b className="font-medium text-[#2a3530]">{selected?.warehouse ?? (Array.from(new Set(jobs.map((job) => job.warehouse))).length === 1 ? jobs[0]?.warehouse : "All active warehouses")}</b></span>
              <span className="text-[#c4cdc8]">|</span>
              <span>Business date <b className="font-medium text-[#9aa5a0]">—</b></span>
              <span className="text-[#c4cdc8]">|</span>
              <span>Latest event <b className="font-medium text-[#2a3530]">{m.asOf}</b></span>
              <span className="text-[#c4cdc8]">|</span>
              {loading ? <span className="text-[#276157]">Refreshing…</span>
                : isStale ? <span className="rounded border border-amber-300 bg-amber-50 px-1 font-semibold text-amber-800">Stale · refreshed {staleMin}m ago</span>
                : <span>Refreshed {staleMin < 1 ? "just now" : `${staleMin}m ago`}</span>}
            </div>
          </div>
          <span className={`flex flex-shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-semibold ${stateStyle}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${stateDot}`} />
            {state === "healthy" ? "All operations within control range" : `${m.items.length} of ${m.open.length} batches need attention${catCounts.critical ? ` · ${catCounts.critical} critical` : ""}`}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button onClick={refresh} disabled={loading} className="rounded border border-border bg-white px-3 py-1 text-[11px] font-semibold text-[#35443f] hover:bg-[#f2f5f2] disabled:opacity-60">{loading ? "Refreshing…" : "↻ Refresh"}</button>
          <button onClick={() => onNavigate("Exceptions")} className="rounded border border-[#24564e] bg-[#24564e] px-3 py-1 text-[11px] font-bold text-white hover:bg-[#183f39]">View All Exceptions{catCounts.all > 0 && <span className="ml-1.5 rounded bg-white/20 px-1 font-mono text-[9px]">{catCounts.all}</span>}</button>
        </div>
      </section>

      <LayerLabel n="01" name="Now" hint="What is happening, and where is the flow" />

      {/* B. Command KPI rail */}
      <section className={`border border-border bg-card shadow-[0_1px_2px_rgba(18,40,32,.04)] transition-opacity ${loading ? "opacity-70" : ""}`}>
        <div className="grid grid-cols-8 divide-x divide-border">
          {([
            { label: "Active Batches", value: m.open.length, sub: `${m.completed} completed · ${m.cancelled} cancelled`, tone: "", go: () => go("Receiving", "all") },
            { label: "Expected Units", value: m.expected.toLocaleString(), sub: `across ${m.open.length} open jobs`, tone: "", go: () => go("Receiving", "all") },
            { label: "Received Units", value: m.received.toLocaleString(), sub: `${m.expected ? Math.round((m.received / m.expected) * 100) : 0}% of expected`, tone: "", go: () => go("Receiving", "all") },
            { label: "Remaining", value: m.remaining.toLocaleString(), sub: "gate + intake stages", tone: "", go: () => go("Receiving", "receiving") },
            { label: "Variance", value: m.over + m.under ? `±${m.over + m.under}` : "0", sub: `+${m.over} over · −${m.under} under`, tone: m.outTol ? "text-amber-700" : "", flag: m.outTol ? `${m.outTol} >1% tol.` : "", go: () => go("Receiving", "all") },
            { label: "QC Hold", value: m.qcUnits.toLocaleString(), sub: `${m.qcJobs.length} lot · ${m.qcDamage} damaged`, tone: m.qcDamage ? "text-amber-700" : "", flag: m.qcDamage ? "sign-off due" : "", go: () => onNavigate("QC") },
            { label: "Putaway Queue", value: m.taskQty.toLocaleString(), sub: `${m.pending.length} pending · ${m.active.length} active tasks`, tone: m.agingTasks.length ? "text-amber-700" : "", flag: m.agingTasks.length ? `${m.agingTasks.length} aging` : "", go: () => onNavigate("Putaway") },
            { label: "At Risk", value: m.atRiskItems.length, sub: `${m.atRiskItems.reduce((a, i) => a + i.exposure, 0).toLocaleString()} units exposed`, tone: catCounts.critical ? "text-red-700" : m.atRiskItems.length ? "text-amber-700" : "", flag: catCounts.critical ? `${catCounts.critical} critical` : "", flagRed: true, go: () => onNavigate("Exceptions") },
          ] as { label: string; value: string | number; sub: string; tone: string; flag?: string; flagRed?: boolean; go: () => void }[]).map((k) => (
            <button key={k.label} onClick={k.go} className="px-3 py-2 text-left transition-colors hover:bg-[#f4f6f3]">
              <p className="font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground">{k.label}</p>
              {loading ? <div className="mt-1.5 h-[20px] w-14 animate-pulse rounded bg-[#e4eae6]" /> : <p className={`mt-1 font-mono text-[20px] leading-none font-medium ${k.tone || "text-[#1b2e28]"}`}>{k.value}</p>}
              <p className="mt-1 truncate text-[10px] text-muted-foreground">{k.sub}</p>
              <p className={`mt-0.5 h-[11px] font-mono text-[8px] font-bold uppercase tracking-[0.08em] ${k.flagRed ? "text-red-700" : "text-amber-700"}`}>{k.flag}</p>
            </button>
          ))}
        </div>
        <div className="flex items-center divide-x divide-border border-t border-border bg-[#f7f9f6]">
          <span className="px-3 py-1 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">No data source yet</span>
          {["Receiving throughput", "QC throughput", "Putaway throughput", "SLA policy not configured", "Capacity utilization"].map((l) => (
            <span key={l} className="flex flex-1 items-center justify-between px-3 py-1 text-[10px] text-muted-foreground" title="Data unavailable — no operational source connected">
              {l}<span className="font-mono text-[11px] text-[#9aa5a0]">—</span>
            </span>
          ))}
        </div>
      </section>

      {/* C. Inbound flow control */}
      <CtPanel title="Inbound Flow Control" meta={<span className="font-mono text-[9px] text-muted-foreground">batches · units · pressure</span>}
        action={<div className="flex items-center gap-3 font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground">
          <span className="flex items-center gap-1"><i className="h-1.5 w-3 bg-[#7ab09f]" />In control</span>
          <span className="flex items-center gap-1"><i className="h-1.5 w-3 bg-amber-400" />Aging &gt;4h</span>
          <span className="flex items-center gap-1"><i className="h-1.5 w-3 bg-red-500" />Blocked</span>
          {m.cancelled > 0 && <button onClick={() => go("Receiving", "cancelled")} className="normal-case tracking-normal text-slate-500 hover:underline">{m.cancelled} cancelled ›</button>}
        </div>}>
        <div className="grid grid-cols-5 divide-x divide-border">
          {m.phases.map((p, idx) => {
            const maxU = Math.max(...m.phases.map((x) => x.units), 1);
            const w = Math.max((p.units / maxU) * 100, p.units ? 6 : 0);
            const inCtl = Math.max(p.units - p.blockedU - p.agingU, 0);
            const hot = p.blocked > 0;
            return (
              <div key={p.id} className="relative">
                {idx > 0 && <span className="absolute -left-[5px] top-3 z-10 grid h-2.5 w-2.5 place-items-center bg-card font-mono text-[8px] leading-none text-[#9aa5a0]">›</span>}
                <button onClick={() => { const t = p.id === "control" ? (p.blocked ? "Validation" : "QC") : p.id === "storage" ? "Putaway" : "Receiving"; go(t as InboundTab, p.id === "gate" ? "waiting_truck" : p.id === "intake" ? "receiving" : p.id === "complete" ? "completed" : undefined); }}
                  className={`block w-full px-3 pb-2 pt-2 text-left transition-colors hover:bg-[#f4f6f3] ${hot ? "shadow-[inset_0_2px_0_#dc2626]" : p.aging ? "shadow-[inset_0_2px_0_#f59e0b]" : "shadow-[inset_0_2px_0_#cfd9d3]"}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-[#2a3530]">{p.label}</span>
                    <span className="font-mono text-[8px] text-muted-foreground">{p.owner}</span>
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="font-mono text-[20px] leading-none font-medium text-[#1b2e28]">{p.count}</span>
                    <span className="text-[10px] text-muted-foreground">batch{p.count === 1 ? "" : "es"}</span>
                    <span className="ml-auto font-mono text-[11px] text-[#3a4540]">{p.units.toLocaleString()}<span className="ml-0.5 text-[9px] text-muted-foreground">{p.id === "gate" ? "planned" : "units"}</span></span>
                  </div>
                  <div className="mt-1.5 flex h-1.5 bg-[#eef1ee]" style={{ width: "100%" }}>
                    <div className="flex h-full" style={{ width: `${w}%` }}>
                      <i className="h-full bg-[#7ab09f]" style={{ width: `${p.units ? (inCtl / p.units) * 100 : 0}%` }} />
                      <i className="h-full bg-amber-400" style={{ width: `${p.units ? (p.agingU / p.units) * 100 : 0}%` }} />
                      <i className="h-full bg-red-500" style={{ width: `${p.units ? (p.blockedU / p.units) * 100 : 0}%` }} />
                    </div>
                  </div>
                  <div className="mt-1.5 flex h-[14px] items-center gap-2 font-mono text-[9px]">
                    {p.aging > 0 && <span className="font-semibold text-amber-700">{p.aging} aging</span>}
                    {p.blocked > 0 && <span className="font-semibold text-red-700">{p.blocked} blocked</span>}
                    {p.aging === 0 && p.blocked === 0 && <span className={p.count ? "text-emerald-700" : "text-[#9aa5a0]"}>{p.count ? "in control" : "empty"}</span>}
                  </div>
                </button>
                <div className="flex flex-wrap gap-1 border-t border-border bg-[#fafbf9] px-2 py-1.5">
                  {p.stages.map((s) => {
                    const c = jobs.filter((j) => j.status === s).length;
                    return (
                      <button key={s} onClick={() => goStage(s)} className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] transition hover:brightness-95 ${c ? statusStyle[s] : "border-border bg-white text-[#9aa5a0]"}`}>
                        {STAGE_DEFS.find((d) => d.id === s)?.label}<b className="font-mono font-medium">{c}</b>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </CtPanel>

      <LayerLabel n="02" name="Control" hint="Where the operation is under pressure, and what to do about it" />

      {/* D + E. Pressure board + priority action center */}
      <CtPanel title="Priority Actions" meta={<span className="rounded-full bg-[#e4eeea] px-1.5 py-0.5 font-mono text-[9px] text-[#3a5248]">{filteredItems.length}</span>}
        action={<span className="text-[10px] text-muted-foreground">Ranked by severity, then units exposed · execution stays in the owning module</span>}>
        <div className="grid grid-cols-7 divide-x divide-border border-b border-border bg-[#f7f9f6]">
          {([
            ["all", "All flagged", "bg-slate-400", ""], ["critical", "Critical", "bg-red-600", "text-red-700"], ["high", "High", "bg-amber-500", "text-amber-700"],
            ["medium", "Medium", "bg-slate-400", ""], ["aging", "Aging >4h", "bg-amber-500", "text-amber-700"], ["blocked", "Blocked", "bg-red-600", "text-red-700"], ["capacity", "Capacity", "bg-amber-500", "text-amber-700"],
          ] as [RiskCat, string, string, string][]).map(([k, label, dot, tone]) => {
            const c = catCounts[k]; const active = cat === k;
            return (
              <button key={k} onClick={() => { setCat(active && k !== "all" ? "all" : k); setShowAllActions(false); }} className={`px-3 py-1.5 text-left transition-colors ${active ? "bg-[#e3eeea] shadow-[inset_0_-2px_0_#24564e]" : "hover:bg-white"}`}>
                <div className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${c ? dot : "bg-[#cfd9d3]"}`} /><span className="font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground">{label}</span></div>
                <div className="mt-0.5 flex items-baseline gap-1.5"><span className={`font-mono text-[15px] leading-none font-medium ${c ? tone || "text-[#1b2e28]" : "text-[#9aa5a0]"}`}>{c}</span><span className="font-mono text-[9px] text-muted-foreground">{c ? `${catUnits(k).toLocaleString()} u` : ""}</span></div>
              </button>
            );
          })}
        </div>
        {filteredItems.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-emerald-800"><span className="h-2 w-2 rounded-full bg-emerald-500" />
            {m.items.length === 0 ? "No active exceptions. All active inbound operations are within the expected control range." : "No items in this category."}
          </div>
        ) : (
          <div className="overflow-x-auto scrollbar-hidden">
            <table className="w-full min-w-[960px] border-collapse text-left">
              <thead className="bg-[#f3f5f2]"><tr className="border-b border-border">
                {["Sev.", "Entity", "Supplier · PO", "Stage", "Units", "Age", "Owner", "Why it is here", "Next action", "Owner module"].map((h) => (
                  <th key={h} className={`whitespace-nowrap px-2 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.07em] text-muted-foreground ${h === "Units" ? "text-right" : ""}`}>{h}</th>))}
              </tr></thead>
              <tbody>
                {shownItems.map((it) => {
                  const isSel = selected?.id === it.job.id;
                  return (
                    <tr key={it.job.id} onClick={() => onSelectJob(it.job)} className={`cursor-pointer border-b border-[#e8ebe7] text-[11px] transition-colors last:border-0 ${isSel ? "bg-[#e8f0eb]" : it.top.sev === "critical" ? "bg-red-50/50 hover:bg-red-50" : "hover:bg-[#f3f6f2]"}`}>
                      <td className="px-2 py-1.5"><SevChip sev={it.top.sev} /></td>
                      <td className="whitespace-nowrap px-2 py-1.5"><span className="font-mono text-[9px] font-semibold text-[#1c5047]">{it.job.jobNumber ?? it.job.id}</span><p className="font-mono text-[9px] text-muted-foreground">{it.job.receipt}</p></td>
                      <td className="max-w-[150px] px-2 py-1.5"><p className="truncate font-semibold text-[#2a3530]">{it.job.supplier}</p><TraceLink onClick={() => onTrace("po", it.job.po)}>{it.job.po}</TraceLink></td>
                      <td className="px-2 py-1.5"><span className={`whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[8px] capitalize ${statusStyle[it.job.status]}`}>{prettify(it.job.status)}</span></td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[10px] font-medium text-[#2a3530]">{it.exposure.toLocaleString()}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 font-mono text-[9px] ${it.job.ageMinutes > AGING_MIN ? "font-semibold text-amber-700" : "text-[#5c6964]"}`}>{it.job.age}{it.job.ageMinutes > AGING_MIN && " ⚑"}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 ${it.job.owner === "Unassigned" ? "font-semibold text-red-700" : "text-[#3a4540]"}`}>{it.job.owner}</td>
                      <td className="min-w-[220px] px-2 py-1.5">
                        <p className="font-semibold leading-tight text-[#1b2e28]">{it.top.kind}{it.reasons.length > 1 && <span title={it.reasons.slice(1).map((r) => `${r.kind}: ${r.cause}`).join("\n")} className="ml-1.5 rounded bg-[#eef1ee] px-1 font-mono text-[8px] font-medium text-[#5a6660]">+{it.reasons.length - 1}</span>}</p>
                        <p className="text-[10px] leading-snug text-[#5a6660]">{it.top.cause}</p>
                      </td>
                      <td className="px-2 py-1.5">
                        <button onClick={(e) => { e.stopPropagation(); go(it.top.tab, it.top.stage, it.job); }} className={`whitespace-nowrap rounded border px-2 py-1 text-[10px] font-semibold transition ${it.top.sev === "critical" ? "border-[#24564e] bg-[#24564e] text-white hover:bg-[#183f39]" : "border-border bg-white text-[#35443f] hover:bg-[#f2f5f2]"}`}>{it.top.next} →</button>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[9px] text-muted-foreground">{it.top.module}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredItems.length > 6 && (
              <button onClick={() => setShowAllActions((v) => !v)} className="w-full border-t border-border bg-[#f7f9f6] py-1.5 text-[11px] font-semibold text-[#276157] hover:bg-[#eef3ef]">
                {showAllActions ? "Show top 6 only" : `Show all ${filteredItems.length} ↓`}
              </button>
            )}
          </div>
        )}
      </CtPanel>

      {/* F. Active inbound operations */}
      <CtPanel title="Active Inbound Operations" meta={<span className="rounded-full bg-[#e4eeea] px-1.5 py-0.5 font-mono text-[9px] text-[#3a5248]">{opsRows.length}</span>}
        action={
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1.5 rounded border border-border bg-[#f7f8f5] px-2 py-0.5 text-muted-foreground">
              <span className="text-[11px]">⌕</span>
              <input value={opsQuery} onChange={(e) => setOpsQuery(e.target.value)} placeholder="Receipt, supplier, PO, dock…" className="w-44 bg-transparent text-[11px] outline-none placeholder:text-[#9ba49f]" />
            </div>
            <select value={opsFilter} onChange={(e) => setOpsFilter(e.target.value as typeof opsFilter)} className="rounded border border-border bg-white px-2 py-0.5 text-[10px] text-[#35443f]">
              <option value="all">All phases</option><option value="risk">At risk only</option>
              {PHASES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <button onClick={() => go("Receiving", "all")} className="px-1 text-[11px] font-semibold text-[#276157] hover:underline">View all in Receiving →</button>
          </div>}>
        <div className="max-h-[330px] overflow-auto scrollbar-hidden">
          <table className="w-full min-w-[1040px] border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-[#f3f5f2]"><tr className="border-b border-border">
              {([["Receipt / Batch", "receipt"], ["Supplier", "supplier"], ["PO", null], ["Dock", null], ["Stage", "stage"], ["Expected", "expected"], ["Received", "received"], ["Variance", "variance"], ["Progress", "progress"], ["Age", "age"], ["Owner", "owner"], ["Risk", "risk"], ["Next action", null]] as [string, string | null][]).map(([h, k]) => (
                <th key={h} onClick={k ? () => sortBy(k) : undefined} className={`whitespace-nowrap px-2 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.07em] text-muted-foreground ${k ? "cursor-pointer select-none hover:text-foreground" : ""} ${["Expected", "Received", "Variance"].includes(h) ? "text-right" : ""}`}>
                  {h}{k && opsSort.key === k ? (opsSort.dir === "asc" ? " ↑" : " ↓") : ""}
                </th>))}
            </tr></thead>
            <tbody>
              {opsRows.length === 0 && <tr><td colSpan={13} className="px-4 py-6 text-center text-[12px] text-muted-foreground">{m.open.length === 0 ? "No open batches." : "No batches match the current filter."}</td></tr>}
              {opsRows.map(({ job, top, progress, recon, next }) => {
                const diff = difference(job); const vp = variancePct(job);
                return (
                  <tr key={job.id} onClick={() => onSelectJob(job)} className={`cursor-pointer border-b border-[#e8ebe7] text-[11px] transition-colors last:border-0 ${selected?.id === job.id ? "bg-[#e8f0eb]" : "hover:bg-[#f3f6f2]"}`}>
                    <td className="whitespace-nowrap px-2 py-1.5"><span className="font-mono text-[9px] font-semibold text-[#1c5047]">{job.receipt}</span><p className="font-mono text-[8px] text-muted-foreground">{job.jobNumber ?? job.id}</p></td>
                    <td className="max-w-[130px] truncate px-2 py-1.5 font-semibold text-[#2a3530]">{job.supplier}</td>
                    <td className="whitespace-nowrap px-2 py-1.5"><TraceLink onClick={() => onTrace("po", job.po)}>{job.po}</TraceLink></td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-[#4a5550]">{job.dock ?? "—"}</td>
                    <td className="px-2 py-1.5"><span className={`whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[8px] capitalize ${statusStyle[job.status]}`}>{prettify(job.status)}</span></td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] text-[#4a5550]">{job.expected.toLocaleString()}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] text-[#4a5550]">{job.received.toLocaleString()}</td>
                    <td className={`whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] font-medium ${!recon ? "text-[#b4beb9]" : Math.abs(vp) > 3 ? "text-red-700" : Math.abs(vp) > 1 ? "text-[#b15d2c]" : "text-muted-foreground"}`} title={recon ? undefined : "Variance is reconciled once counting completes"}>{recon && diff !== 0 ? `${diff > 0 ? "+" : ""}${diff} · ${vp.toFixed(1)}%` : recon ? "—" : "pending"}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5"><div className="h-1.5 w-16 bg-[#e8ece9]"><div className={`h-full ${progress > 100 ? "bg-[#b15d2c]" : "bg-[#5f9886]"}`} style={{ width: `${Math.min(progress, 100)}%` }} /></div><span className="w-7 font-mono text-[9px] text-muted-foreground">{Math.round(progress)}%</span></div>
                    </td>
                    <td className={`whitespace-nowrap px-2 py-1.5 font-mono text-[9px] ${job.ageMinutes > AGING_MIN ? "font-semibold text-amber-700" : "text-[#5c6964]"}`}>{job.age}{job.ageMinutes > AGING_MIN && " ⚑"}</td>
                    <td className={`whitespace-nowrap px-2 py-1.5 ${job.owner === "Unassigned" ? "font-semibold text-red-700" : "text-[#3a4540]"}`}>{job.owner}</td>
                    <td className="px-2 py-1.5">{top ? <SevChip sev={top.sev} /> : <span className="font-mono text-[9px] text-[#9aa5a0]">—</span>}</td>
                    <td className="px-2 py-1.5"><button onClick={(e) => { e.stopPropagation(); go(next.tab, next.stage, job); }} className="whitespace-nowrap text-[10px] font-semibold text-[#276157] hover:underline">{next.label} →</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CtPanel>

      <LayerLabel n="03" name="Plan" hint="Capacity headroom and what lands next" />

      {/* G. Capacity & plan */}
      <CtPanel title="Capacity & Plan" meta={<span className="font-mono text-[9px] text-muted-foreground">read-only · capacity models owned by Location / Workforce domains</span>}>
        <div className="grid grid-cols-5 divide-x divide-border">
          <CapCol title="Receiving" link="Open Receiving" onLink={() => go("Receiving", "receiving")}>
            <MetricRow label="Active sessions" value={m.intake.length} />
            <MetricRow label="Planned arrivals" value={`${m.pendingByStage("waiting_truck").length + m.pendingByStage("truck_registered").length}`} sub={`${(m.pendingByStage("waiting_truck").concat(m.pendingByStage("truck_registered")).reduce((a, j) => a + j.expected, 0)).toLocaleString()} u`} />
            <MetricRow label="Units still inbound" value={m.remaining.toLocaleString()} />
            <Unavail label="Receiving headroom" note="No receiving capacity model configured" />
          </CapCol>
          <CapCol title="Docks" link="Open Receiving" onLink={() => go("Receiving", "all")}>
            <MetricRow label="Occupied" value={Array.from(m.docks.values()).filter((v) => v === "occupied").length} />
            <MetricRow label="Waiting truck" value={Array.from(m.docks.values()).filter((v) => v === "waiting").length} />
            <MetricRow label="Blocked" value={Array.from(m.docks.values()).filter((v) => v === "blocked").length} tone={Array.from(m.docks.values()).includes("blocked") ? "red" : undefined} />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Array.from(m.docks.entries()).sort().map(([d, s]) => (
                <span key={d} title={`${d} · ${s}`} className={`rounded border px-1 py-0.5 font-mono text-[8px] ${s === "blocked" ? "border-red-300 bg-red-50 text-red-800" : s === "waiting" ? "border-slate-300 bg-slate-100 text-slate-600" : "border-[#b9d3c8] bg-[#e8f1ec] text-[#276157]"}`}>{d.replace("Dock ", "D")}</span>))}
            </div>
            <Unavail label="Free docks" note="Total dock count not configured" />
          </CapCol>
          <CapCol title="QC" link="Open QC" onLink={() => onNavigate("QC")}>
            <MetricRow label="Pending lots" value={m.qcJobs.length} />
            <MetricRow label="Pending quantity" value={m.qcUnits.toLocaleString()} />
            <MetricRow label="Damaged" value={m.qcDamage} tone={m.qcDamage ? "amber" : undefined} />
            <MetricRow label="Oldest waiting" value={m.qcJobs.length ? fmtAge(m.oldestQc) : "—"} />
            <Unavail label="QC lane capacity" note="No QC capacity source" />
          </CapCol>
          <CapCol title="Putaway" link="Open Putaway" onLink={() => onNavigate("Putaway")}>
            <MetricRow label="Queue quantity" value={m.taskQty.toLocaleString()} />
            <MetricRow label="Active tasks" value={m.active.length} />
            <MetricRow label="Blocked tasks" value={m.blockedT.length} />
            <MetricRow label="Aging >4h" value={m.agingTasks.length} tone={m.agingTasks.length ? "amber" : undefined} />
            <MetricRow label="Oldest task" value={m.openTasks.length ? fmtAge(m.oldestTask) : "—"} />
          </CapCol>
          <CapCol title="Location" link="Location · soon" onLink={() => onTrace("bin", "Location")}>
            <Unavail label="Bin utilization" note="No Location data source connected" />
            <Unavail label="Full / blocked bins" note="No Location data source connected" />
          </CapCol>
        </div>
      </CtPanel>

      {/* H + I + J */}
      <div className="grid grid-cols-3 gap-2">
        <CtPanel title="Validation & QC Health">
          <div className="p-3 pt-2">
            <GroupLabel>Validation · owner Validation</GroupLabel>
            <MetricRow label="Blocking failures" value={jobs.filter((j) => j.status === "validation_failed").length} tone={jobs.some((j) => j.status === "validation_failed") ? "red" : undefined} onClick={() => onNavigate("Validation")} />
            <MetricRow label="Identity unresolved" value={m.open.filter((j) => j.status === "identifying" && j.issue === "Validation").length} tone={m.open.some((j) => j.status === "identifying" && j.issue === "Validation") ? "amber" : undefined} onClick={() => onNavigate("Validation")} />
            <MetricRow label="Quantity variance >1%" value={m.outTol} tone={m.outTol ? "amber" : undefined} onClick={() => go("Receiving", "all")} />
            <MetricRow label="Unknown / ambiguous barcode" value="—" sub="Barcode Engine" unavailable />
            <GroupLabel className="mt-2">Quality control · owner QC</GroupLabel>
            <MetricRow label="Pending lots" value={m.qcJobs.length} onClick={() => onNavigate("QC")} />
            <MetricRow label="QC Hold units" value={m.qcUnits.toLocaleString()} onClick={() => onNavigate("QC")} />
            <MetricRow label="Damage units (open batches)" value={m.openDamage} tone={m.openDamage ? "amber" : undefined} onClick={() => onNavigate("QC")} />
            <MetricRow label="Oldest pending lot" value={m.qcJobs.length ? fmtAge(m.oldestQc) : "—"} onClick={() => onNavigate("QC")} />
            <MetricRow label="Pass / fail / partial" value="—" sub="No decision records" unavailable />
          </div>
        </CtPanel>

        <CtPanel title="Putaway & Location Health">
          <div className="p-3 pt-2">
            <div className="grid grid-cols-3 divide-x divide-border border border-border">
              {([["Pending", m.pending.length, ""], ["In progress", m.active.length, ""], ["Completed", m.done.length, ""]] as [string, number, string][]).map(([k, v]) => (
                <button key={k} onClick={() => onNavigate("Putaway")} className="px-2 py-1.5 text-left hover:bg-[#f4f6f3]"><p className="font-mono text-[8px] uppercase tracking-[0.07em] text-muted-foreground">{k}</p><p className="font-mono text-[15px] leading-none font-medium text-[#1b2e28]">{v}</p></button>))}
            </div>
            <MetricRow label="Aging >4h" value={m.agingTasks.length} tone={m.agingTasks.length ? "amber" : undefined} onClick={() => onNavigate("Putaway")} />
            <MetricRow label="Blocked tasks" value={m.blockedT.length} tone={m.blockedT.length ? "red" : undefined} onClick={() => onNavigate("Putaway")} />
            <MetricRow label="Quantity waiting" value={m.pending.reduce((a, t) => a + t.qty, 0).toLocaleString()} onClick={() => onNavigate("Putaway")} />
            <MetricRow label="Suggested bin short of capacity" value={m.shortTasks.length} tone={m.shortTasks.length ? "red" : undefined} onClick={() => onNavigate("Putaway")} />
            <GroupLabel className="mt-2">Suggested bins · fit vs task quantity</GroupLabel>
            {m.pending.length === 0 && <p className="py-1 text-[10px] text-muted-foreground">No pending putaway tasks.</p>}
            {m.pending.map((t) => {
              const b = bins.find((item) => item.code === t.suggestedBin); const res = validateBin(t.suggestedBin, t.qty, bins);
              const pct = b ? Math.round(b.utilizationPct) : 0;
              return (
                <button key={t.id} onClick={() => onTrace("bin", t.suggestedBin)} className="mb-1 block w-full text-left">
                  <div className="flex items-center justify-between text-[10px]"><span className="font-mono text-[9px] text-[#1c5047] hover:underline">{t.suggestedBin}</span>
                    <span className={`font-mono text-[9px] ${res.valid ? "text-muted-foreground" : "font-semibold text-red-700"}`}>{b ? `${b.availableCapacity} free` : "not in live catalog"} · needs {t.qty}</span></div>
                  <UtilBar pct={pct} over={!res.valid} />
                </button>);
            })}
            <p className="mt-1 text-[9px] text-muted-foreground">Live capacity read from Supabase. Final placement and capacity are revalidated transactionally by the backend.</p>
          </div>
        </CtPanel>

        <CtPanel title="Workforce & Coverage">
          <div className="p-3 pt-2">
            <div className="grid grid-cols-3 divide-x divide-border border border-border">
              {([["Active owners", m.ownerLoad.length, ""], ["Unassigned", m.unassigned.length, m.unassigned.length ? "text-red-700" : ""], ["Queue-held", m.queueHeld.length, ""]] as [string, number, string][]).map(([k, v, t]) => (
                <div key={k} className="px-2 py-1.5"><p className="font-mono text-[8px] uppercase tracking-[0.07em] text-muted-foreground">{k}</p><p className={`font-mono text-[15px] leading-none font-medium ${t || "text-[#1b2e28]"}`}>{v}</p></div>))}
            </div>
            <GroupLabel className="mt-2">Workload by owner · units on hand</GroupLabel>
            {m.ownerLoad.length === 0 && <p className="py-1 text-[10px] text-muted-foreground">No owned work in progress.</p>}
            {m.ownerLoad.map((o) => (
              <div key={o.owner} className="mb-1">
                <div className="flex items-center justify-between text-[10px]"><span className="text-[#3a4540]">{o.owner}</span>
                  <span className="font-mono text-[9px] text-muted-foreground">{o.batches} batch{o.batches > 1 ? "es" : ""} · {o.units.toLocaleString()} u{o.risk > 0 && <b className="ml-1 text-amber-700">!{o.risk}</b>}</span></div>
                <div className="h-1.5 bg-[#e8ece9]"><div className="h-full bg-[#5f9886]" style={{ width: `${(o.units / Math.max(...m.ownerLoad.map((x) => x.units), 1)) * 100}%` }} /></div>
              </div>))}
            <GroupLabel className="mt-2">Assignment coverage</GroupLabel>
            <CoverRow label="Receiving sessions owned" a={m.intakeOwned} b={m.intake.length} />
            <CoverRow label="QC lots owned" a={m.qcOwned} b={m.qcJobs.length} />
            <CoverRow label="Putaway tasks with worker" a={m.tasksAssigned} b={m.openTasks.length} />
            {m.unassigned.map((j) => (
              <button key={j.id} onClick={() => onSelectJob(j)} className="mt-1.5 flex w-full items-center justify-between rounded border border-red-200 bg-red-50 px-2 py-1 text-left text-[10px] text-red-800 hover:bg-red-100">
                <span><b className="font-mono text-[9px]">{j.id}</b> · {j.supplier} · {j.dock}</span><span className="font-semibold">Assign →</span>
              </button>))}
          </div>
        </CtPanel>
      </div>

      <LayerLabel n="04" name="Trace" hint="Where each state came from, and where to follow it" />

      {/* K + trace */}
      <div className="grid grid-cols-2 gap-2">
        <CtPanel title="Live Operational Activity" meta={<span className="rounded border border-border bg-[#f3f5f2] px-1 font-mono text-[8px] uppercase text-muted-foreground">State changes · not an audit log</span>}>
          {m.events.length === 0 ? <p className="px-4 py-6 text-[12px] text-muted-foreground">No recent activity.</p> : (
            <ul>
              {m.events.map((j) => (
                <li key={j.id} className="flex items-center gap-3 border-b border-[#e8ebe7] px-3 py-1.5 last:border-0 hover:bg-[#f7f9f6]">
                  <span className="w-10 flex-shrink-0 font-mono text-[10px] text-muted-foreground">{j.updated}</span>
                  <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${stageIndicatorColor[j.status]}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-[#1b2e28]">{EVENT_LABEL[j.status]}</p>
                    <p className="truncate text-[10px] text-muted-foreground"><span className="font-mono text-[9px] text-[#1c5047]">{j.id}</span> · {j.supplier} → <span className="capitalize">{prettify(j.status)}</span></p>
                  </div>
                  <button onClick={() => onSelectJob(j)} className="flex-shrink-0 text-[10px] font-semibold text-[#276157] hover:underline">Open</button>
                  <button onClick={() => onSelectJobTab(j, "Audit")} className="flex-shrink-0 text-[10px] font-semibold text-[#276157] hover:underline">Audit</button>
                </li>))}
            </ul>)}
        </CtPanel>

        <CtPanel title="Trace Chain" meta={traceJob ? <span className="font-mono text-[9px] text-[#1c5047]">{traceJob.jobNumber ?? traceJob.id}<span className="ml-1.5 text-muted-foreground">{selected ? "· selected" : "· top priority"}</span></span> : undefined}>
          {!traceJob ? <p className="px-4 py-6 text-[12px] text-muted-foreground">Select an operation to trace it through Supplier → PO → Batch → Lot → QC → Putaway → Bin → Audit.</p> : (
            <TraceChain job={traceJob} tasks={putawayTasks} onTrace={onTrace} onOpen={(t, s) => go(t, s, traceJob)} onInspector={(t) => onSelectJobTab(traceJob, t)} />
          )}
        </CtPanel>
      </div>
    </div>
  );
}

// ---- Control Tower: metrics derived from live jobs, tasks, and bins ----

type Sev = "critical" | "high" | "medium";
type RiskCat = "all" | "critical" | "high" | "medium" | "aging" | "blocked" | "capacity";
type Reason = { sev: Sev; kind: string; cause: string; next: string; tab: InboundTab; module: string; stage?: Status };
type RiskItem = { job: Job; reasons: Reason[]; top: Reason; exposure: number };

const SEV_RANK: Record<Sev, number> = { critical: 3, high: 2, medium: 1 };
const AGING_MIN = 240;
const BLOCKING = new Set(["Validation failure", "Unowned session", "Bin capacity"]);
const RECON = new Set<Status>(["validation_failed", "qc_in_progress", "confirmed", "putaway_pending", "putaway_in_progress"]);
const NON_HUMAN = new Set(["Unassigned", "System", "Gate System", "Dock 03"]);
const PHASES: { id: "gate" | "intake" | "control" | "storage" | "complete"; label: string; owner: string; stages: Status[] }[] = [
  { id: "gate", label: "Gate", owner: "Receiving", stages: ["waiting_truck", "truck_registered"] },
  { id: "intake", label: "Intake", owner: "Receiving", stages: ["receiving", "identifying", "counting"] },
  { id: "control", label: "Control", owner: "Validation · QC", stages: ["validation_failed", "qc_in_progress"] },
  { id: "storage", label: "Storage", owner: "Putaway", stages: ["confirmed", "putaway_pending", "putaway_in_progress"] },
  { id: "complete", label: "Complete", owner: "—", stages: ["completed"] },
];
const EVENT_LABEL: Record<Status, string> = {
  waiting_truck: "Truck awaited at dock", truck_registered: "Truck registered at gate", receiving: "Receiving in progress", identifying: "Identification in progress",
  counting: "Count in progress", qc_in_progress: "QC review in progress", confirmed: "Receipt confirmed", putaway_pending: "Queued for putaway",
  putaway_in_progress: "Putaway in progress", completed: "Receipt completed", validation_failed: "Validation failed", cancelled: "Receipt cancelled",
};

const isOpen = (j: Job) => j.status !== "completed" && j.status !== "cancelled";
const exposureOf = (j: Job) => (j.received > 0 ? j.received : j.expected);
const fmtAge = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
const pTasksShort = (tasks: PutawayTask[], bins: InboundOptions["bins"]) => tasks.filter((t) => t.status === "pending" && !validateBin(t.suggestedBin, t.qty, bins).valid);

function matchCat(i: RiskItem, c: RiskCat) {
  switch (c) {
    case "all": return true;
    case "critical": case "high": case "medium": return i.top.sev === c;
    case "aging": return i.job.ageMinutes > AGING_MIN;
    case "blocked": return i.reasons.some((r) => BLOCKING.has(r.kind));
    case "capacity": return i.reasons.some((r) => r.kind === "Bin capacity");
  }
}

function stageTarget(s: Status): { tab: InboundTab; stage?: Status } {
  if (s === "validation_failed") return { tab: "Validation" };
  if (s === "qc_in_progress") return { tab: "QC" };
  if (s === "putaway_pending" || s === "putaway_in_progress") return { tab: "Putaway" };
  return { tab: "Receiving", stage: s };
}

function nextFor(job: Job, top?: Reason): { label: string; tab: InboundTab; stage?: Status } {
  if (top) return { label: top.next, tab: top.tab, stage: top.stage };
  if (job.status === "waiting_truck") return { label: "Register truck", tab: "Receiving", stage: job.status };
  if (job.status === "truck_registered") return { label: "Start receiving", tab: "Receiving", stage: job.status };
  if (job.status === "qc_in_progress") return { label: "Open QC", tab: "QC" };
  if (job.status === "confirmed" || job.status === "putaway_pending" || job.status === "putaway_in_progress") return { label: "Open Putaway", tab: "Putaway" };
  return { label: "Open Receiving", tab: "Receiving", stage: job.status };
}

function assessJob(job: Job, tasks: PutawayTask[], bins: InboundOptions["bins"] = []): Reason[] {
  if (!isOpen(job)) return [];
  const r: Reason[] = [];
  const own = tasks.filter((t) => t.jobId === job.id);
  const aging = job.ageMinutes > AGING_MIN;
  if (job.status === "validation_failed") r.push({ sev: "critical", kind: "Validation failure", cause: "Barcode / identity conflict blocks receipt confirmation", next: "Open Validation", tab: "Validation", module: "Validation" });
  if (job.status === "identifying" && job.issue === "Validation") r.push({ sev: "high", kind: "Identity unresolved", cause: `Identification stalled on a validation flag · ${Math.max(job.expected - job.received, 0)} units short of PO`, next: "Open Validation", tab: "Validation", module: "Validation" });
  if (job.status === "qc_in_progress" && job.damage > 0) r.push({ sev: "high", kind: "QC pending", cause: `${job.damage} damaged units awaiting QC sign-off · ${job.received} units held`, next: "Open QC", tab: "QC", module: "QC" });
  const short = own.find((t) => t.status === "pending" && !validateBin(t.suggestedBin, t.qty, bins).valid && bins.length > 0);
  if (short) r.push({ sev: "high", kind: "Bin capacity", cause: `${short.suggestedBin} cannot take ${short.qty} units — ${validateBin(short.suggestedBin, short.qty, bins).reason.replace("Insufficient live capacity — ", "")}`, next: "Open Putaway", tab: "Putaway", module: "Putaway · Location" });
  if (job.status === "putaway_pending" && aging) r.push({ sev: own.some((t) => t.priority === "urgent") ? "high" : "medium", kind: "Putaway aging", cause: `Queued ${job.age} · ${own.length} task${own.length === 1 ? "" : "s"} not started${own.some((t) => t.priority === "urgent") ? " · urgent priority" : ""}`, next: "Open Putaway", tab: "Putaway", module: "Putaway" });
  if (job.status === "confirmed" && own.length === 0) r.push({ sev: aging ? "high" : "medium", kind: "Putaway not started", cause: `Confirmed with no putaway task created · open ${job.age}`, next: "Open Putaway", tab: "Putaway", module: "Putaway" });
  if (job.status === "receiving" && job.owner === "Unassigned") r.push({ sev: "high", kind: "Unowned session", cause: `Receiving at ${job.dock ?? "dock"} has no owner · ${Math.max(job.expected - job.received, 0).toLocaleString()} units outstanding`, next: "Assign owner", tab: "Receiving", stage: "receiving", module: "Receiving" });
  const vp = variancePct(job);
  if (RECON.has(job.status) && job.status !== "validation_failed" && Math.abs(vp) > 1) r.push({ sev: Math.abs(vp) > 3 ? "high" : "medium", kind: "Quantity variance", cause: `${difference(job) > 0 ? "+" : ""}${difference(job)} units (${vp > 0 ? "+" : ""}${vp.toFixed(1)}%) vs PO · tolerance 1.0%`, next: "Investigate", tab: "Receiving", module: "Receiving" });
  if (aging && !["putaway_pending", "confirmed"].includes(job.status)) r.push({ sev: "medium", kind: "Aging", cause: `No update for ${job.age}; exceeds the app’s provisional 4h attention threshold`, next: nextFor(job).label, tab: nextFor(job).tab, stage: nextFor(job).stage, module: "Receiving" });
  return r;
}

// ---- Control Tower: small presentational pieces ----

const SEV_STYLE: Record<Sev, string> = {
  critical: "border-red-700 bg-red-600 text-white",
  high: "border-amber-300 bg-amber-100 text-amber-800",
  medium: "border-slate-300 bg-slate-100 text-slate-600",
};
function SevChip({ sev }: { sev: Sev }) {
  return <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.06em] ${SEV_STYLE[sev]}`}>{sev}</span>;
}

function LayerLabel({ n, name, hint }: { n: string; name: string; hint: string }) {
  return (
    <div className="flex items-center gap-2 pt-1.5">
      <span className="font-mono text-[9px] font-semibold text-[#276157]">{n}</span>
      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[#2a3530]">{name}</span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
      <span className="h-px flex-1 bg-[#d9dfdb]" />
    </div>
  );
}

function CtPanel({ title, meta, action, children }: { title: string; meta?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border border-border bg-card shadow-[0_1px_2px_rgba(18,40,32,.04)]">
      <div className="flex min-h-8 items-center justify-between gap-3 border-b border-border px-3 py-1">
        <div className="flex items-center gap-2"><h2 className="whitespace-nowrap font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-[#2a3530]">{title}</h2>{meta}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

function TraceLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button onClick={(e) => { e.stopPropagation(); onClick(); }} title="Filter Receiving by this entity" className="whitespace-nowrap font-mono text-[9px] text-muted-foreground hover:text-[#1c5047] hover:underline">{children}</button>;
}

function GroupLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`mb-0.5 border-b border-border pb-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground ${className}`}>{children}</p>;
}

function MetricRow({ label, value, sub, tone, unavailable, onClick }: { label: string; value: React.ReactNode; sub?: string; tone?: "red" | "amber"; unavailable?: boolean; onClick?: () => void }) {
  const color = unavailable ? "text-[#9aa5a0]" : tone === "red" ? "text-red-700 font-semibold" : tone === "amber" ? "text-amber-700 font-semibold" : "text-[#1b2e28]";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} title={unavailable ? "Data unavailable" : undefined} className={`flex w-full items-center justify-between gap-2 border-b border-[#eef1ee] py-1 text-left text-[11px] last:border-0 ${onClick ? "hover:bg-[#f4f6f3]" : ""}`}>
      <span className="truncate text-[#4a5550]">{label}</span>
      <span className="flex flex-shrink-0 items-baseline gap-1.5">{sub && <span className="text-[9px] text-muted-foreground">{sub}</span>}<span className={`font-mono text-[11px] ${color}`}>{value}</span>{onClick && <span className="text-[10px] text-[#9aa5a0]">›</span>}</span>
    </Tag>
  );
}

function Unavail({ label, note }: { label: string; note: string }) {
  return (
    <div className="mt-1.5 border border-dashed border-[#cfd9d3] bg-[#f7f9f6] px-2 py-1">
      <div className="flex items-center justify-between"><span className="text-[10px] text-[#4a5550]">{label}</span><span className="font-mono text-[11px] text-[#9aa5a0]">—</span></div>
      <p className="text-[9px] text-muted-foreground">Data unavailable · {note}</p>
    </div>
  );
}

function CapCol({ title, link, onLink, source, children }: { title: string; link: string; onLink: () => void; source?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="mb-1 flex items-center justify-between border-b border-border pb-1">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#2a3530]">{title}</span>
        <button onClick={onLink} className="text-[10px] font-semibold text-[#276157] hover:underline">{link} ›</button>
      </div>
      {source && <p className="mb-1 font-mono text-[8px] uppercase tracking-[0.06em] text-muted-foreground">{source}</p>}
      {children}
    </div>
  );
}

function UtilBar({ pct, over }: { pct: number; over?: boolean }) {
  const color = over || pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-400" : "bg-[#5f9886]";
  return <div className="h-1.5 bg-[#e8ece9]"><div className={`h-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>;
}

function CoverRow({ label, a, b }: { label: string; a: number; b: number }) {
  const full = a === b;
  return (
    <div className="flex items-center justify-between border-b border-[#eef1ee] py-1 text-[11px] last:border-0">
      <span className="text-[#4a5550]">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${b === 0 ? "bg-[#cfd9d3]" : full ? "bg-emerald-500" : "bg-amber-500"}`} />
        <span className={`font-mono text-[11px] ${b > 0 && !full ? "font-semibold text-amber-700" : "text-[#1b2e28]"}`}>{b === 0 ? "—" : `${a} / ${b}`}</span>
      </span>
    </div>
  );
}

function TraceChain({ job, tasks, onTrace, onOpen, onInspector }: {
  job: Job; tasks: PutawayTask[]; onTrace: (kind: string, value: string) => void;
  onOpen: (tab: InboundTab, stage?: Status) => void; onInspector: (t: DrawerTab) => void;
}) {
  const own = tasks.filter((t) => t.jobId === job.id);
  const skus = Array.from(new Set(own.map((t) => t.sku)));
  const bins = Array.from(new Set(own.map((t) => t.actualBin !== "—" ? t.actualBin : t.suggestedBin).filter((bin) => bin && bin !== "—")));
  type Node = { label: string; value: string; owner: string; state: "linked" | "none" | "future"; onClick?: () => void };
  const nodes: Node[] = [
    { label: "Supplier", value: job.supplier, owner: "Receiving", state: "linked", onClick: () => onTrace("supplier", job.supplier) },
    { label: "PO", value: job.po, owner: "Receiving", state: "linked", onClick: () => onTrace("po", job.po) },
    { label: "Receiving batch", value: `${job.receipt} · ${job.jobNumber ?? job.id}`, owner: "Receiving", state: "linked", onClick: () => onInspector("Overview") },
    { label: "Receipt line · SKU", value: skus.length ? skus.join(", ") : "No putaway SKU linked", owner: "Receiving", state: skus.length ? "linked" : "none", onClick: () => onInspector("Receipt Lines") },
    { label: "Barcode", value: "See actual receipt-line barcode", owner: "Product catalog", state: "none", onClick: () => onInspector("Receipt Lines") },
    { label: "Lot", value: own.some((task) => !!task.lotId) ? `${own.filter((task) => !!task.lotId).length} linked lot(s)` : "No lot linked", owner: "Inventory", state: own.some((task) => !!task.lotId) ? "linked" : "none" },
    { label: "QC decision", value: job.status === "qc_in_progress" ? `Pending review${job.damage ? ` · ${job.damage} damaged` : ""}` : job.status === "completed" || job.status === "putaway_pending" || job.status === "putaway_in_progress" ? "QC/confirmation completed or downstream" : "No decision available", owner: "QC", state: job.status === "qc_in_progress" ? "linked" : "none", onClick: () => onInspector("Receipt Lines") },
    { label: "Putaway", value: own.length ? own.map((t) => t.id).join(", ") : "No task created", owner: "Putaway", state: own.length ? "linked" : "none", onClick: () => onOpen("Putaway") },
    { label: "Bin", value: bins.length ? bins.join(", ") : "—", owner: "Location · soon", state: bins.length ? "linked" : "none", onClick: bins.length ? () => onTrace("bin", bins[0]) : undefined },
    { label: "Movement", value: own.some((task) => task.status === "completed") ? "Putaway completed; inspect inventory ledger for postings" : "No completed putaway movement", owner: "Inventory ledger", state: own.some((task) => task.status === "completed") ? "linked" : "none" },
    { label: "Audit", value: "Audit trail for this batch", owner: "Audit", state: "linked", onClick: () => onInspector("Audit") },
  ];
  return (
    <ol className="px-3 py-2">
      {nodes.map((n, i) => (
        <li key={n.label} className="relative flex gap-2.5">
          <div className="relative flex w-3 flex-shrink-0 flex-col items-center">
            <span className={`z-10 mt-1.5 h-2 w-2 rounded-full border ${n.state === "linked" ? "border-[#24564e] bg-[#24564e]" : n.state === "none" ? "border-[#b4beb9] bg-white" : "border-dashed border-[#9aa5a0] bg-white"}`} />
            {i < nodes.length - 1 && <span className="absolute top-3.5 h-[calc(100%-4px)] w-px bg-[#d0d9d4]" />}
          </div>
          <button onClick={n.onClick} disabled={!n.onClick} className="grid w-full grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-2 py-[3px] text-left enabled:hover:bg-[#f4f6f3]">
            <span className="font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground">{n.label}</span>
            <span className={`truncate text-[11px] ${n.state === "linked" ? "font-mono text-[10px] font-medium text-[#1c5047]" : "text-[#7a8782]"} ${n.onClick ? "group-hover:underline" : ""}`}>{n.value}</span>
            <span className="font-mono text-[8px] text-[#9aa5a0]">{n.owner}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

// =============================================================================
// RECEIVING TAB
// =============================================================================

function ReceivingTab(props: {
  jobs: Job[]; visibleJobs: Job[]; kpis: any; intelSignals: any;
  stageCounts: Partial<Record<Status, number>>; stageAttention: Partial<Record<Status, number>>; stageAging: Partial<Record<Status, number>>;
  hoveredStage: string | null; setHoveredStage: (s: string | null) => void;
  activeStage: Status | "all"; setActiveStage: (s: Status | "all") => void;
  selected: Job | null; selectJob: (j: Job) => void;
  drawerTab: DrawerTab; setDrawerTab: (t: DrawerTab) => void; stageActions: ActionDef[];
  query: string; showFilters: boolean; setShowFilters: (b: boolean) => void;
  filterOwner: string; setFilterOwner: (s: string) => void;
  filterSupplier: string; setFilterSupplier: (s: string) => void;
  filterVariance: "all" | "ok" | "warn" | "alert"; setFilterVariance: (v: "all" | "ok" | "warn" | "alert") => void;
  filterIssue: "all" | "issue"; setFilterIssue: (v: "all" | "issue") => void;
  filterAge: "all" | "fresh" | "aging" | "critical"; setFilterAge: (v: "all" | "fresh" | "aging" | "critical") => void;
  owners: string[]; suppliers: string[]; activeFilterCount: number;
  sortKey: SortKey; sortDir: SortDir; handleSort: (k: SortKey) => void;
  selectedRows: Set<string>; toggleRow: (id: string, e: React.MouseEvent) => void; toggleAllRows: () => void;
  onCreate: () => void; clearAllFilters: () => void;
}) {
  const { visibleJobs, kpis, intelSignals, stageCounts, stageAttention, stageAging, hoveredStage, setHoveredStage, activeStage, setActiveStage, selected, selectJob, stageActions, showFilters, setShowFilters, filterOwner, setFilterOwner, filterSupplier, setFilterSupplier, filterVariance, setFilterVariance, filterIssue, setFilterIssue, filterAge, setFilterAge, owners, suppliers, activeFilterCount, sortKey, sortDir, handleSort, selectedRows, toggleRow, toggleAllRows, onCreate, clearAllFilters, setDrawerTab } = props;

  return (
    <div className="flex min-h-0 h-full flex-col overflow-hidden px-4 pb-3 pt-2.5 gap-2">

      {/* Workflow stage bar */}
      <section className="flex-shrink-0 border border-border bg-card shadow-[0_1px_2px_rgba(18,40,32,.04)]">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Workflow · Job State</span>
            {activeStage !== "all" && <span className="rounded bg-[#e6f0ea] px-1.5 py-0.5 font-mono text-[9px] text-[#276157]">Filtered: {prettify(activeStage)}</span>}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={onCreate} className="flex items-center gap-1.5 rounded border border-[#24564e] bg-[#24564e] px-3 py-1 text-[11px] font-bold text-white hover:bg-[#183f39] transition">
              + Create
            </button>
            <button onClick={() => setActiveStage("all")} className="text-[11px] font-semibold text-[#276157] hover:underline">Show all →</button>
          </div>
        </div>
        <div className="grid grid-cols-10 divide-x divide-border border-b border-border">
          {STAGE_DEFS.filter((s) => s.id !== "validation_failed" && s.id !== "cancelled").map((stageDef) => {
            const count = stageCounts[stageDef.id] ?? 0;
            const attn = stageAttention[stageDef.id] ?? 0;
            const aging = stageAging[stageDef.id] ?? 0;
            const active = activeStage === stageDef.id;
            return (
              <div key={stageDef.id} className="relative">
                <button onClick={() => setActiveStage(active ? "all" : stageDef.id)} onMouseEnter={() => setHoveredStage(stageDef.id)} onMouseLeave={() => setHoveredStage(null)}
                  className={`relative w-full min-h-[56px] px-2 py-2 text-left transition-colors ${active ? "bg-[#e3eeea] shadow-[inset_0_2px_0_#24564e]" : "hover:bg-[#f4f6f3]"}`}>
                  <div className="mb-1.5 flex items-start justify-between">
                    <span className={`h-1.5 w-1.5 rounded-full mt-0.5 flex-shrink-0 ${stageDef.id === "completed" ? "bg-emerald-500" : attn > 0 ? "bg-amber-500" : stageIndicatorColor[stageDef.id]}`} />
                    {attn > 0 && <span className="font-mono text-[9px] font-bold text-amber-700">!{attn}</span>}
                  </div>
                  <p className="text-[9px] font-semibold leading-[1.2] text-[#2a3530]">{stageDef.label}</p>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="font-mono text-[14px] leading-none font-medium text-[#1b2e28]">{count}</span>
                    {aging > 0 && <span className="text-[8px] text-amber-700 font-mono">·{aging}ag</span>}
                  </div>
                </button>
                {hoveredStage === stageDef.id && (
                  <div className="absolute top-full left-0 z-50 mt-1 w-52 rounded border border-border bg-white p-2 shadow-lg text-[10px] leading-snug text-[#3a4540]">
                    {count} {stageDef.label.toLowerCase()} · {stageDef.tooltip}
                    {attn > 0 && <span className="block mt-0.5 text-amber-700 font-semibold">{attn} need attention</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-0 divide-x divide-border bg-[#fdf7f5]">
          <div className="px-3 py-1"><span className="font-mono text-[8px] uppercase tracking-[0.1em] text-[#9b7060]">Exception States</span></div>
          {STAGE_DEFS.filter((s) => s.id === "validation_failed" || s.id === "cancelled").map((stageDef) => {
            const count = stageCounts[stageDef.id] ?? 0;
            const attn = stageAttention[stageDef.id] ?? 0;
            const active = activeStage === stageDef.id;
            const isBlocked = stageDef.id === "validation_failed";
            return (
              <div key={stageDef.id} className="relative">
                <button onClick={() => setActiveStage(active ? "all" : stageDef.id)} onMouseEnter={() => setHoveredStage(stageDef.id)} onMouseLeave={() => setHoveredStage(null)}
                  className={`flex items-center gap-3 px-4 py-1 transition-colors ${active ? "bg-red-50" : isBlocked ? "hover:bg-red-50" : "hover:bg-slate-50"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${isBlocked ? "bg-red-600" : "bg-slate-300"}`} />
                  <span className={`text-[11px] font-semibold ${isBlocked ? "text-red-800" : "text-slate-500"}`}>{stageDef.label}</span>
                  <span className={`font-mono text-[13px] font-medium ${isBlocked ? "text-red-700" : "text-slate-400"}`}>{count}</span>
                  {attn > 0 && isBlocked && <span className="font-mono text-[9px] font-bold text-red-700 bg-red-100 rounded px-1">!{attn} blocking</span>}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Action bar */}
      <section className="flex-shrink-0 flex items-center justify-between border border-border bg-card px-3 py-1.5 shadow-[0_1px_2px_rgba(18,40,32,.04)]">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Actions</span>
          {selected ? (
            <span className="border-l border-border pl-2 text-[12px]">
              <span className="font-mono text-[#1c5047] font-medium">{selected.jobNumber ?? selected.id}</span>
              <span className="text-muted-foreground"> · </span>
              <span className="capitalize text-[#3a4540]">{prettify(selected.status)}</span>
              {selected.issue && <span className="ml-2 rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 font-mono text-[9px] text-amber-800">{selected.issue}</span>}
            </span>
          ) : <span className="text-[11px] text-muted-foreground">Select a job to see available actions</span>}
          {selectedRows.size > 0 && <span className="border-l border-border pl-2 text-[11px] text-[#276157] font-medium">{selectedRows.size} selected</span>}
        </div>
        <div className="flex gap-1.5">
          {stageActions.map((action, i) => (
            <button key={action.label} onClick={action.fn} className={`rounded border px-3 py-1 text-[11px] font-semibold transition ${i === 0 ? "border-[#24564e] bg-[#24564e] text-white hover:bg-[#183f39]" : "border-border bg-white text-[#35443f] hover:bg-[#f2f5f2]"}`}>
              {action.label}
            </button>
          ))}
          <div className="w-px bg-border mx-0.5" />
          <button onClick={() => setDrawerTab("Timeline")} className="rounded border border-border bg-white px-3 py-1 text-[11px] font-semibold text-[#35443f] hover:bg-[#f2f5f2]">Timeline</button>
          <button onClick={() => setDrawerTab("Audit")} className="rounded border border-border bg-white px-3 py-1 text-[11px] font-semibold text-[#35443f] hover:bg-[#f2f5f2]">Audit</button>
        </div>
      </section>

      {/* KPI strip */}
      <section className="flex-shrink-0 grid grid-cols-8 divide-x divide-border overflow-hidden border border-border bg-card shadow-[0_1px_2px_rgba(18,40,32,.04)]">
        {([
          ["Open Jobs", String(kpis.openCount), "Live snapshot", "text-[#1f5c51]", "all"],
          ["Receiving", String(kpis.rcvCount), kpis.unassRcv > 0 ? `${kpis.unassRcv} unassigned` : "All assigned", "text-blue-700", "receiving"],
          ["Val. Issues", String(kpis.vfCount), `${kpis.vfCount} blocking`, kpis.vfCount > 0 ? "text-red-700" : "text-emerald-700", "validation_failed"],
          ["QC Issues", String(kpis.qcCount), `${kpis.totalDmg} units dmg`, kpis.qcCount > 0 ? "text-rose-700" : "text-emerald-700", "qc_in_progress"],
          ["Putaway Pend.", String(kpis.ppCount), kpis.ppAging > 0 ? `${kpis.ppAging} aging >4h` : "None aging", kpis.ppAging > 0 ? "text-orange-700" : "text-[#1f5c51]", "putaway_pending"],
          ["In Progress", String(kpis.pipCount), "Idle duration from last update", "text-indigo-700", "putaway_in_progress"],
          ["Completed", String(kpis.compCount), "Live snapshot", "text-emerald-700", "completed"],
          ["Variance", `${kpis.avgVar.toFixed(1)}%`, "App rule ±1.0%", kpis.avgVar > 1 ? "text-rose-700" : "text-emerald-700", "all"],
        ] as [string, string, string, string, Status | "all"][]).map(([label, value, detail, color, stage]) => (
          <button key={label} onClick={() => setActiveStage(stage)} className="px-2.5 py-1.5 text-left hover:bg-[#f4f6f3] transition-colors">
            <p className="font-mono text-[8px] uppercase tracking-[0.07em] text-muted-foreground truncate">{label}</p>
            <p className={`mt-0.5 font-mono text-[15px] leading-none font-medium ${color}`}>{value}</p>
            <p className="mt-0.5 text-[9px] text-muted-foreground truncate">{detail}</p>
          </button>
        ))}
      </section>

      {/* Grid + Intelligence */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_252px] gap-2">

        <section className="min-w-0 flex flex-col overflow-hidden border border-border bg-card shadow-[0_1px_2px_rgba(18,40,32,.04)]">
          <div className="flex h-8 flex-shrink-0 items-center justify-between border-b border-border px-3">
            <div className="flex items-center gap-2">
              <h2 className="text-[12px] font-bold text-[#1b2e28]">Receiving Jobs</h2>
              <span className="rounded-full bg-[#e4eeea] px-1.5 py-0.5 font-mono text-[9px] text-[#3a5248]">{visibleJobs.length}</span>
              {activeStage !== "all" && (
                <button onClick={() => setActiveStage("all")} className="flex items-center gap-1 rounded border border-[#c3d8ce] bg-[#edf5f0] px-1.5 py-0.5 text-[9px] font-medium text-[#276157]">
                  <span className="capitalize">{prettify(activeStage)}</span><span>×</span>
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedRows.size > 0 && <span className="text-[11px] font-medium text-[#276157]">{selectedRows.size} sel.</span>}
              <button onClick={() => setShowFilters(!showFilters)}
                className={`flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition ${showFilters ? "border-[#24564e] bg-[#e3eeea] text-[#24564e]" : "border-border text-muted-foreground hover:text-foreground"}`}>
                Filters{activeFilterCount > 0 && <span className="rounded-full bg-[#24564e] text-white px-1 font-mono text-[8px]">{activeFilterCount}</span>}
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="flex-shrink-0 flex flex-wrap items-center gap-1.5 border-b border-border bg-[#f7f9f6] px-3 py-1.5">
              <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">Filter:</span>
              {([
                ["supplier", filterSupplier, setFilterSupplier, ["", ...suppliers], ["All suppliers", ...suppliers]],
                ["owner", filterOwner, setFilterOwner, ["", ...owners], ["All owners", ...owners]],
              ] as [string, string, (v: string) => void, string[], string[]][]).map(([label, val, setter, vals, labels]) => (
                <select key={label} value={val} onChange={(e) => setter(e.target.value)} className="rounded border border-border bg-white px-2 py-0.5 text-[10px] text-[#35443f]">
                  {vals.map((v, i) => <option key={v} value={v}>{labels[i]}</option>)}
                </select>
              ))}
              <select value={filterVariance} onChange={(e) => setFilterVariance(e.target.value as typeof filterVariance)} className="rounded border border-border bg-white px-2 py-0.5 text-[10px] text-[#35443f]">
                <option value="all">All variance</option><option value="ok">OK (&lt;1%)</option><option value="warn">Warn (1-3%)</option><option value="alert">Alert (&gt;3%)</option>
              </select>
              <select value={filterIssue} onChange={(e) => setFilterIssue(e.target.value as typeof filterIssue)} className="rounded border border-border bg-white px-2 py-0.5 text-[10px] text-[#35443f]">
                <option value="all">All jobs</option><option value="issue">Issues only</option>
              </select>
              <select value={filterAge} onChange={(e) => setFilterAge(e.target.value as typeof filterAge)} className="rounded border border-border bg-white px-2 py-0.5 text-[10px] text-[#35443f]">
                <option value="all">All ages</option><option value="fresh">Fresh (&lt;1h)</option><option value="aging">Aging (1-4h)</option><option value="critical">Critical (&gt;4h)</option>
              </select>
              <button onClick={clearAllFilters} className="text-[10px] text-muted-foreground hover:text-foreground">Clear</button>
            </div>
          )}

          <div className="scrollbar-hidden min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-[#f3f5f2]">
                <tr className="border-b border-border">
                  <th className="w-7 px-2 py-1.5"><input type="checkbox" checked={selectedRows.size === visibleJobs.length && visibleJobs.length > 0} onChange={toggleAllRows} className="h-3 w-3 accent-[#24564e]" /></th>
                  {([ ["Job","id"],["Receipt",null],["Supplier","supplier"],["PO",null],["Status","status"],["Exp.","expected"],["Rcv.","received"],["Diff.","difference"],["Var.%","variance"],["Dmg.","damage"],["Owner","owner"],["Age","age"],["Upd.","updated"] ] as [string, SortKey | null][]).map(([h, k]) => (
                    <th key={h} onClick={k ? () => handleSort(k) : undefined} className={`whitespace-nowrap px-2 py-1.5 font-mono text-[8px] font-medium uppercase tracking-[0.07em] text-muted-foreground ${k ? "cursor-pointer select-none hover:text-foreground" : ""}`}>
                      {h}{k && sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleJobs.length === 0 && <tr><td colSpan={14} className="px-4 py-8 text-center text-[13px] text-muted-foreground">No jobs match current filters</td></tr>}
                {visibleJobs.map((job) => {
                  const diff = difference(job);
                  const vPct = variancePct(job);
                  const isSel = props.selected?.id === job.id;
                  const isChecked = selectedRows.has(job.id);
                  const isAging = job.ageMinutes > 240;
                  const isBlocked = job.status === "validation_failed" || job.status === "cancelled";
                  return (
                    <tr key={job.id} onClick={() => selectJob(job)} className={`cursor-pointer border-b border-[#e8ebe7] last:border-0 transition-colors text-[11px] ${isSel ? "bg-[#e8f0eb]" : isBlocked ? "hover:bg-red-50" : "hover:bg-[#f3f6f2]"}`}>
                      <td className="w-7 px-2 py-1.5" onClick={(e) => toggleRow(job.id, e)}><input type="checkbox" checked={isChecked} onChange={() => {}} className="h-3 w-3 accent-[#24564e]" /></td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <span className="font-mono text-[9px] font-semibold text-[#1c5047]">{job.jobNumber ?? job.id}</span>
                        {job.issue && <span className={`ml-1 inline-block rounded px-1 py-0.5 font-mono text-[8px] font-bold ${job.issue === "QC" ? "bg-rose-100 text-rose-700" : job.issue === "Validation" || job.issue === "Blocked" ? "bg-amber-100 text-amber-700" : "bg-orange-50 text-orange-600"}`}>{job.issue}</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[9px] text-[#5a6660]">{job.receipt}</td>
                      <td className="max-w-[100px] truncate px-2 py-1.5 font-semibold text-[#2a3530]">{job.supplier}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[9px] text-muted-foreground">{job.po}</td>
                      <td className="px-2 py-1.5"><span className={`whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[8px] capitalize ${statusStyle[job.status]}`}>{prettify(job.status)}</span></td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] text-[#4a5550]">{job.expected.toLocaleString()}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] text-[#4a5550]">{job.received.toLocaleString()}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] font-medium ${diff !== 0 ? "text-[#b15d2c]" : "text-muted-foreground"}`}>{diff > 0 ? "+" : ""}{diff || "—"}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] font-medium ${Math.abs(vPct) > 3 ? "text-red-700" : Math.abs(vPct) > 1 ? "text-[#b15d2c]" : "text-muted-foreground"}`}>{vPct !== 0 ? `${vPct > 0 ? "+" : ""}${vPct.toFixed(1)}%` : "—"}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 text-right font-mono text-[9px] font-medium ${job.damage ? "text-rose-700" : "text-muted-foreground"}`}>{job.damage || "—"}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[#3a4540]">{job.owner}</td>
                      <td className={`whitespace-nowrap px-2 py-1.5 font-mono text-[9px] ${isAging ? "font-semibold text-amber-700" : "text-[#5c6964]"}`}>{job.age}{isAging && " ⚑"}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[9px] text-muted-foreground">{job.updated}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Intelligence panel */}
        <aside className="flex flex-col overflow-hidden border border-border bg-card shadow-[0_1px_2px_rgba(18,40,32,.04)]">
          <div className="flex-shrink-0 border-b border-border px-3 py-2">
            <h2 className="text-[12px] font-bold text-[#1b2e28]">Intelligence</h2>
            <p className="text-[9px] text-muted-foreground">Priority signals · derived from job state</p>
          </div>
          <div className="scrollbar-hidden flex-1 overflow-y-auto p-2 space-y-2">
            {intelSignals.critical.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-red-600 flex-shrink-0" /><span className="font-mono text-[8px] uppercase tracking-[0.12em] text-red-700 font-semibold">Critical</span></div>
                <div className="space-y-1.5">{intelSignals.critical.map((sig: any, i: number) => <IntelCard key={i} {...sig} />)}</div>
              </div>
            )}
            {intelSignals.warning.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-amber-500 flex-shrink-0" /><span className="font-mono text-[8px] uppercase tracking-[0.12em] text-amber-700 font-semibold">Warning</span></div>
                <div className="space-y-1.5">{intelSignals.warning.map((sig: any, i: number) => <IntelCard key={i} {...sig} />)}</div>
              </div>
            )}
            {intelSignals.health.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0" /><span className="font-mono text-[8px] uppercase tracking-[0.12em] text-emerald-700 font-semibold">Health</span></div>
                <div className="space-y-1.5">{intelSignals.health.map((sig: any, i: number) => <IntelCard key={i} {...sig} />)}</div>
              </div>
            )}
            <div className="border-t border-border pt-2">
              <p className="font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground mb-1">Live job inactivity</p>
              <div className="flex items-end gap-0.5 h-6">
                {jobs.slice().sort((a, b) => b.ageMinutes - a.ageMinutes).slice(0, 12).map((job) => <span key={job.id} title={`${job.jobNumber ?? job.id} · no update for ${job.age}`} className={`flex-1 rounded-sm ${job.ageMinutes > 240 ? "bg-amber-400" : "bg-[#7ab09f]"}`} style={{ height: `${Math.max(3, Math.min(24, (job.ageMinutes / 240) * 24))}px` }} />)}
                {!jobs.length && <span className="text-[9px] text-muted-foreground">No jobs</span>}
              </div>
              <p className="mt-1 text-[9px] text-muted-foreground">Each bar = one live job · amber = no update &gt;4h. Bars visualize inactivity only; no SLA metric is configured.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// =============================================================================
// VALIDATION TAB
// =============================================================================

function ValidationTab({ jobs, onSelectJob }: { jobs: Job[]; onSelectJob: (j: Job) => void }) {
  const issues = jobs.filter((j) => j.status === "validation_failed" || (j.issue === "Validation" && j.status !== "completed"));
  return (
    <div className="h-full overflow-y-auto scrollbar-hidden p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-slab text-[15px] font-bold text-[#17201f]">Validation</h2>
          <p className="text-[11px] text-muted-foreground">Active validation issues blocking receipt confirmation</p>
        </div>
        {issues.length > 0 && <span className="rounded-full bg-red-600 text-white px-2.5 py-1 font-bold text-[11px]">{issues.length} issues</span>}
      </div>
      {issues.length === 0 ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-6 text-center">
          <p className="text-[13px] font-bold text-emerald-700">No validation issues</p>
          <p className="mt-1 text-[11px] text-emerald-600">All identities resolved</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] border-b border-border bg-[#f3f5f2] px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground gap-3">
            <span>Job</span><span>Supplier / PO</span><span>Issue</span><span>Status</span><span>Age</span><span>Owner</span>
          </div>
          {issues.map((job) => (
            <div key={job.id} onClick={() => onSelectJob(job)} className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center border-b border-border px-3 py-2.5 last:border-0 gap-3 cursor-pointer hover:bg-red-50 transition-colors">
              <span className="font-mono text-[9px] font-bold text-[#1c5047] whitespace-nowrap">{job.jobNumber ?? job.id}</span>
              <div>
                <p className="text-[12px] font-semibold text-[#2a3530]">{job.supplier}</p>
                <p className="font-mono text-[9px] text-muted-foreground">{job.po} · {job.receipt}</p>
              </div>
              <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[8px] font-bold text-red-700 whitespace-nowrap">
                {job.status === "validation_failed" ? "Val. Failed" : "Validation"}
              </span>
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] capitalize whitespace-nowrap ${statusStyle[job.status]}`}>{prettify(job.status)}</span>
              <span className={`font-mono text-[9px] whitespace-nowrap ${job.ageMinutes > 240 ? "text-amber-700 font-semibold" : "text-muted-foreground"}`}>{job.age}</span>
              <span className="text-[11px] text-[#3a4540] whitespace-nowrap">{job.owner}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 rounded border border-[#c8ddd5] bg-[#edf5f0] p-3 text-[11px] text-[#2a6457]">
        <p className="font-semibold mb-1">Validation failure resolution</p>
        <p>Select a failing job to open its control drawer. Use Audit tab to trace the conflicting barcode identity. Use Resolve action to re-open identification and resolve conflicts.</p>
      </div>
    </div>
  );
}

// =============================================================================
// QC TAB
// =============================================================================

function QCTab({ jobs, onSelectJob }: { jobs: Job[]; onSelectJob: (j: Job) => void }) {
  const qcJobs = jobs.filter((job) => job.status === "qc_in_progress" || job.status === "counting");
  return (
    <div className="h-full overflow-y-auto scrollbar-hidden p-4">
      <div className="mb-3 flex items-center justify-between">
        <div><h2 className="font-slab text-[15px] font-bold text-[#17201f]">QC Review</h2><p className="text-[11px] text-muted-foreground">Record a pass/fail decision for each received receipt line; failure requires an evidence image.</p></div>
        {qcJobs.filter((job) => job.status === "qc_in_progress" || job.damage > 0).length > 0 && <span className="rounded-full bg-rose-500 px-2.5 py-1 text-[11px] font-bold text-white">{qcJobs.filter((job) => job.status === "qc_in_progress" || job.damage > 0).length} review item(s)</span>}
      </div>
      {qcJobs.length === 0 ? <div className="rounded border border-border bg-white p-6 text-center"><p className="text-[13px] font-bold text-[#2a3530]">No jobs awaiting QC</p><p className="mt-1 text-[11px] text-muted-foreground">Jobs with received lines in Counting or QC Review will appear here. The list is loaded from the live dashboard.</p></div> : (
        <div className="overflow-hidden rounded border border-border">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-3 border-b border-border bg-[#f3f5f2] px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground"><span>Job</span><span>Supplier / Receipt</span><span>QC Damage</span><span>Variance</span><span>Age</span><span>Action</span></div>
          {qcJobs.map((job) => { const vp = variancePct(job); return (
            <button key={job.id} onClick={() => onSelectJob(job)} className="grid w-full grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-0 hover:bg-rose-50 transition-colors">
              <span className="font-mono text-[9px] font-bold text-[#1c5047] whitespace-nowrap">{job.jobNumber ?? job.id}</span>
              <div><p className="text-[12px] font-semibold text-[#2a3530]">{job.supplier}</p><p className="font-mono text-[9px] text-muted-foreground">{job.receipt}</p></div>
              <span className={`font-mono text-[11px] font-bold whitespace-nowrap ${job.damage > 0 ? "text-rose-700" : "text-muted-foreground"}`}>{job.damage > 0 ? `${job.damage} units` : "Not reported"}</span>
              <span className={`font-mono text-[9px] whitespace-nowrap ${Math.abs(vp) > 1 ? "font-semibold text-amber-700" : "text-muted-foreground"}`}>{vp !== 0 ? `${vp > 0 ? "+" : ""}${vp.toFixed(1)}%` : "0.0%"}</span>
              <span className={`font-mono text-[9px] whitespace-nowrap ${job.ageMinutes > 240 ? "font-semibold text-amber-700" : "text-muted-foreground"}`}>{job.age}</span>
              <span className="rounded border border-rose-200 bg-rose-50 px-1.5 py-1 font-mono text-[8px] font-semibold text-rose-700 whitespace-nowrap">Open lines →</span>
            </button>
          ); })}
        </div>
      )}
      <div className="mt-4 rounded border border-[#c8ddd5] bg-[#edf5f0] p-3 text-[11px] text-[#2a6457]"><p className="mb-1 font-semibold">Controlled QC workflow</p><p>Select a job to open its receipt lines, enter pass/fail quantities, and attach evidence for failures. The database verifies quantities, permissions, state transitions and audit records. Receipt confirmation stays disabled until required line checks are complete.</p></div>
    </div>
  );
}

// =============================================================================
// PUTAWAY TAB
// =============================================================================

function PutawayTab({ jobs, tasks, bins, onSelectJob, onUpdateTask, setNotice }: {
  jobs: Job[]; tasks: PutawayTask[]; bins: InboundOptions["bins"]; onSelectJob: (j: Job) => void;
  onUpdateTask: (id: string, update: Partial<PutawayTask>) => void; setNotice: (s: string) => void;
}) {
  const [binInputs, setBinInputs] = useState<Record<string, string>>({});
  const [binResults, setBinResults] = useState<Record<string, BinResult & { binCode: string }>>({});

  const activeTasks = tasks.filter((t) => t.status !== "completed");
  const pendingTasks = activeTasks.filter((t) => t.status === "pending");
  const inProgressTasks = activeTasks.filter((t) => t.status === "in_progress");
  const blockedTasks = tasks.filter((t) => t.status === "blocked");

  const getJobForTask = (task: PutawayTask) => jobs.find((j) => j.id === task.jobId);

  const handleStartTask = (task: PutawayTask) => {
    onUpdateTask(task.id, { status: "in_progress" });
  };

  const handleBinScan = (task: PutawayTask, binCode: string) => {
    const result = validateBin(binCode, task.qty, bins);
    setBinResults((prev) => ({ ...prev, [task.id]: { ...result, binCode } }));
  };

  const handleCompleteTask = (task: PutawayTask) => {
    const result = binResults[task.id];
    if (!result?.valid) { setNotice("Scan a valid bin before completing putaway task"); return; }
    onUpdateTask(task.id, { status: "completed", actualBin: result.binCode });
  };

  const priorityColor = (p: PutawayTask["priority"]) =>
    p === "urgent" ? "text-red-700 bg-red-50 border-red-200" : p === "high" ? "text-amber-700 bg-amber-50 border-amber-200" : "text-slate-600 bg-slate-50 border-slate-200";

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-slab text-[15px] font-bold text-[#17201f]">Putaway</h2>
          <p className="text-[11px] text-muted-foreground">{pendingTasks.length} pending · {inProgressTasks.length} in progress · bin validation required</p>
        </div>
        {pendingTasks.filter((t) => t.priority === "urgent").length > 0 && (
          <span className="rounded-full bg-red-600 text-white px-2.5 py-1 font-bold text-[11px]">{pendingTasks.filter((t) => t.priority === "urgent").length} urgent</span>
        )}
      </div>

      {inProgressTasks.length > 0 && (
        <section>
          <p className="mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">In Progress</p>
          <div className="space-y-2">
            {inProgressTasks.map((task) => {
              const job = getJobForTask(task);
              const result = binResults[task.id];
              const binInput = binInputs[task.id] ?? "";
              return (
                <div key={task.id} className="rounded border border-indigo-200 bg-indigo-50/30 p-3">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[9px] font-bold text-[#1c5047]">{task.jobNumber ?? task.jobId}</span>
                        <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold ${priorityColor(task.priority)}`}>{task.priority}</span>
                      </div>
                      <p className="mt-0.5 text-[12px] font-semibold text-[#2a3530]">{task.description}</p>
                      <p className="text-[10px] text-muted-foreground font-mono">{task.sku} · {task.qty} units · Suggested: {task.suggestedBin}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-[9px] text-muted-foreground">{task.worker}</p>
                      {job && <button onClick={() => onSelectJob(job)} className="text-[9px] text-[#276157] hover:underline">View job →</button>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <input value={binInput} onChange={(e) => setBinInputs((prev) => ({ ...prev, [task.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && handleBinScan(task, binInput)}
                      placeholder="Scan destination bin (e.g. BIN-A4-02)" className="flex-1 rounded border border-border bg-white px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[#24564e]" />
                    <button onClick={() => handleBinScan(task, binInput)} className="rounded border border-[#24564e] px-3 py-1.5 text-[11px] font-bold text-[#24564e] hover:bg-[#e3eeea]">Validate</button>
                    <button onClick={() => handleCompleteTask(task)} disabled={!result?.valid} className={`rounded border px-3 py-1.5 text-[11px] font-bold transition ${result?.valid ? "border-[#24564e] bg-[#24564e] text-white hover:bg-[#183f39]" : "border-border bg-[#f4f6f3] text-muted-foreground cursor-not-allowed"}`}>
                      Complete
                    </button>
                  </div>
                  {result && (
                    <p className={`mt-1.5 text-[10px] font-semibold ${result.valid ? "text-emerald-700" : "text-red-700"}`}>
                      {result.valid ? "✓ " : "✗ "}{result.reason}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {pendingTasks.length > 0 && (
        <section>
          <p className="mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Pending Tasks</p>
          <div className="overflow-hidden rounded border border-border">
            <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] border-b border-border bg-[#f3f5f2] px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground gap-3">
              <span>Priority</span><span>SKU / Job</span><span>Qty</span><span>Bin</span><span>Worker</span><span>Age</span><span>Action</span>
            </div>
            {pendingTasks.map((task) => {
              const job = getJobForTask(task);
              return (
                <div key={task.id} className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] items-center border-b border-border px-3 py-2 last:border-0 gap-3 hover:bg-[#f7f9f6]">
                  <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold capitalize ${priorityColor(task.priority)}`}>{task.priority}</span>
                  <div>
                    <p className="text-[11px] font-semibold text-[#2a3530]">{task.description}</p>
                    <p className="font-mono text-[9px] text-muted-foreground">{task.sku} · {task.jobNumber ?? task.jobId}</p>
                  </div>
                  <span className="font-mono text-[10px] text-[#4a5550] whitespace-nowrap">{task.qty}</span>
                  <span className="font-mono text-[9px] text-[#1c5047] whitespace-nowrap">{task.suggestedBin}</span>
                  <span className="text-[10px] text-[#3a4540] whitespace-nowrap">{task.worker ?? "—"}</span>
                  <span className={`font-mono text-[9px] whitespace-nowrap ${task.ageMinutes > 240 ? "text-amber-700 font-semibold" : "text-muted-foreground"}`}>{Math.floor(task.ageMinutes / 60)}h {task.ageMinutes % 60}m{task.ageMinutes > 240 ? " ⚑" : ""}</span>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => handleStartTask(task)} className="rounded border border-[#24564e] px-2 py-0.5 text-[9px] font-bold text-[#24564e] hover:bg-[#e3eeea]">Start</button>
                    {job && <button onClick={() => onSelectJob(job)} className="text-[9px] text-muted-foreground hover:text-foreground">→</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {blockedTasks.length > 0 && (
        <section>
          <p className="mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-red-700">Blocked Tasks · review required</p>
          <div className="overflow-hidden rounded border border-red-200 bg-red-50">
            {blockedTasks.map((task) => {
              const job = getJobForTask(task);
              return <div key={task.id} className="flex items-center justify-between gap-3 border-b border-red-100 px-3 py-2 last:border-0">
                <div className="min-w-0"><p className="text-[11px] font-semibold text-red-900">{task.sku} · {task.qty} units</p><p className="font-mono text-[9px] text-red-800">{task.jobNumber ?? task.jobId} · {task.suggestedBin}</p></div>
                <div className="flex items-center gap-2"><span className="text-[9px] font-semibold text-red-800">Blocked in database</span>{job && <button onClick={() => onSelectJob(job)} className="rounded border border-red-300 bg-white px-2 py-1 text-[9px] font-semibold text-red-800">View job</button>}</div>
              </div>;
            })}
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">Blocked tasks remain visible but cannot be resumed unless a supported backend action is available.</p>
        </section>
      )}

      {activeTasks.length === 0 && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-6 text-center">
          <p className="text-[13px] font-bold text-emerald-700">All putaway tasks complete</p>
          <p className="mt-1 text-[11px] text-emerald-600">No pending or in-progress tasks</p>
        </div>
      )}

      <div className="rounded border border-border bg-[#f4f6f3] p-3 text-[10px] text-muted-foreground">
        <span className="font-semibold text-[#2a3530]">Bin validation rules: </span>Bin must exist in catalog · not blocked · sufficient capacity. Wrong or unknown bins are rejected. Scan or type bin code, then validate before completing.
      </div>
    </div>
  );
}

// =============================================================================
// EXCEPTIONS TAB
// =============================================================================

function ExceptionsTab({ jobs, tasks, onSelectJob, onNavigate }: {
  jobs: Job[]; tasks: PutawayTask[]; onSelectJob: (j: Job) => void; onNavigate: (tab: InboundTab) => void;
}) {
  const exceptions = jobs.filter((j) => !!j.issue && j.status !== "completed");
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const total = exceptions.length + blockedTasks.length;

  const exceptionGroups: { label: string; jobs: Job[]; color: string; tab: InboundTab }[] = [
    { label: "Validation Failures", jobs: exceptions.filter((j) => j.issue === "Validation" || j.status === "validation_failed"), color: "red", tab: "Validation" },
    { label: "QC Issues", jobs: exceptions.filter((j) => j.issue === "QC"), color: "rose", tab: "QC" },
    { label: "Aging >4h (app rule)", jobs: exceptions.filter((j) => j.issue === "Aging"), color: "amber", tab: "Putaway" },
    { label: "Variance", jobs: exceptions.filter((j) => j.issue === "Variance"), color: "orange", tab: "Receiving" },
    { label: "Blocked / Unassigned", jobs: exceptions.filter((j) => j.issue === "Blocked"), color: "amber", tab: "Receiving" },
  ].filter((g) => g.jobs.length > 0);

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-slab text-[15px] font-bold text-[#17201f]">Exceptions</h2>
          <p className="text-[11px] text-muted-foreground">All active operational exceptions across inbound workflow</p>
        </div>
        {total > 0 && <span className="rounded-full bg-amber-500 text-white px-2.5 py-1 font-bold text-[11px]">{total} total</span>}
      </div>

      {total === 0 ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-6 text-center">
          <p className="text-[13px] font-bold text-emerald-700">No active exceptions</p>
          <p className="mt-1 text-[11px] text-emerald-600">All operations within normal parameters</p>
        </div>
      ) : (
        exceptionGroups.map((group) => {
          const bgMap: Record<string, string> = { red: "border-red-200 bg-red-50", rose: "border-rose-200 bg-rose-50", amber: "border-amber-200 bg-amber-50", orange: "border-orange-200 bg-orange-50" };
          const textMap: Record<string, string> = { red: "text-red-700", rose: "text-rose-700", amber: "text-amber-700", orange: "text-orange-700" };
          return (
            <section key={group.label}>
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group.label}</p>
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[8px] font-bold border ${bgMap[group.color]} ${textMap[group.color]}`}>{group.jobs.length}</span>
                </div>
                <button onClick={() => onNavigate(group.tab)} className="text-[10px] text-[#276157] hover:underline">View in {group.tab} →</button>
              </div>
              <div className="space-y-1">
                {group.jobs.map((job) => (
                  <div key={job.id} onClick={() => onSelectJob(job)} className={`flex items-center justify-between rounded border p-2 cursor-pointer ${bgMap[group.color]} hover:opacity-80 transition`}>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[9px] font-bold text-[#1c5047]">{job.jobNumber ?? job.id}</span>
                      <span className="text-[11px] font-semibold text-[#2a3530]">{job.supplier}</span>
                      <span className="font-mono text-[9px] text-muted-foreground">{job.receipt}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`font-mono text-[9px] ${job.ageMinutes > 240 ? "text-amber-700 font-semibold" : "text-muted-foreground"}`}>{job.age}</span>
                      <span className="text-[10px] text-muted-foreground">{job.owner}</span>
                      <span className="text-[10px] text-[#276157]">→</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

// =============================================================================
// WORKFORCE TAB
// =============================================================================

function WorkforceTab({ jobs, tasks }: { jobs: Job[]; tasks: PutawayTask[] }) {
  const workerSet = new Set(jobs.map((j) => j.owner).filter((o) => !["Unassigned", "System", "Gate System", "Dock 03"].includes(o)));
  const workers = Array.from(workerSet);

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-slab text-[15px] font-bold text-[#17201f]">Workforce</h2>
          <p className="text-[11px] text-muted-foreground">Active assignment summary · derived from job ownership data</p>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[9px] text-amber-800 font-semibold">Live snapshot · not shift-bounded</div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {workers.map((worker) => {
          const workerJobs = jobs.filter((j) => j.owner === worker && j.status !== "completed" && j.status !== "cancelled");
          const workerTasks = tasks.filter((t) => t.worker === worker && t.status !== "completed");
          const hasIssue = workerJobs.some((j) => !!j.issue);
          const initials = worker.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
          return (
            <div key={worker} className={`rounded border p-3 ${hasIssue ? "border-amber-200 bg-amber-50/40" : "border-border bg-card"}`}>
              <div className="flex items-center gap-2.5 mb-3">
                <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-[#d5e5db] text-[10px] font-bold text-[#1e4840]">{initials}</div>
                <div>
                  <p className="text-[12px] font-bold text-[#17201f]">{worker}</p>
                  <p className="text-[10px] text-muted-foreground">{workerJobs.length} active job{workerJobs.length !== 1 ? "s" : ""} · {workerTasks.length} putaway task{workerTasks.length !== 1 ? "s" : ""}</p>
                </div>
              </div>
              <div className="space-y-1.5">
                {workerJobs.slice(0, 3).map((job) => (
                  <div key={job.id} className="flex items-center justify-between text-[10px]">
                    <span className="font-mono text-[#1c5047] font-semibold">{job.jobNumber ?? job.id}</span>
                    <span className={`rounded border px-1 py-0.5 font-mono text-[8px] capitalize ${statusStyle[job.status]}`}>{prettify(job.status)}</span>
                    {job.issue && <span className="text-amber-700 font-semibold">⚑ {job.issue}</span>}
                  </div>
                ))}
                {workerJobs.length === 0 && <p className="text-[10px] text-muted-foreground italic">No active assignments</p>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded border border-border bg-card p-3">
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-2">Capacity Overview</p>
        <div className="grid grid-cols-4 gap-3">
          {([
            ["Workers on shift", String(workers.length), "text-[#1f5c51]"],
            ["Unassigned jobs", String(jobs.filter((j) => j.owner === "Unassigned").length), "text-amber-700"],
            ["Avg jobs / worker", jobs.length > 0 ? (jobs.filter((j) => !["completed", "cancelled"].includes(j.status)).length / Math.max(1, workers.length)).toFixed(1) : "0", "text-[#1f5c51]"],
            ["Putaway tasks open", String(tasks.filter((t) => t.status !== "completed").length), "text-indigo-700"],
          ] as [string, string, string][]).map(([label, value, color]) => (
            <div key={label} className="text-center">
              <p className="font-mono text-[8px] uppercase tracking-[0.07em] text-muted-foreground">{label}</p>
              <p className={`mt-1 font-mono text-[20px] font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// REPORTS TAB
// =============================================================================

function ReportsTab({ jobs, kpis }: { jobs: Job[]; kpis: any }) {
  const received = jobs.filter((j) => j.received > 0);
  const totalExpected = received.reduce((s, j) => s + j.expected, 0);
  const totalReceived = received.reduce((s, j) => s + j.received, 0);
  const totalDamage = jobs.reduce((s, j) => s + j.damage, 0);

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-slab text-[15px] font-bold text-[#17201f]">Reports</h2>
          <p className="text-[11px] text-muted-foreground">Live operational snapshot · no shift boundary/source filter connected</p>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[9px] text-amber-800 font-semibold">Live snapshot · not shift-bounded</div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 rounded border border-border bg-card p-4">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-3">Current snapshot</p>
          <div className="grid grid-cols-3 gap-4">
            {([
              ["Total Jobs", String(jobs.length), "text-[#1f5c51]"],
              ["Completed", String(kpis.compCount), "text-emerald-700"],
              ["Open / Active", String(kpis.openCount), "text-blue-700"],
              ["Cancelled", String(jobs.filter((j) => j.status === "cancelled").length), "text-slate-500"],
              ["With Exceptions", String(jobs.filter((j) => !!j.issue).length), "text-amber-700"],
              ["Val. Failures", String(kpis.vfCount), kpis.vfCount > 0 ? "text-red-700" : "text-emerald-700"],
            ] as [string, string, string][]).map(([label, value, color]) => (
              <div key={label}>
                <p className="font-mono text-[9px] text-muted-foreground uppercase tracking-[0.07em]">{label}</p>
                <p className={`font-mono text-[22px] font-bold mt-1 ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded border border-border bg-card p-4">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-3">Quantity Summary</p>
          {([
            ["Expected units", totalExpected.toLocaleString(), "text-[#1f5c51]"],
            ["Received units", totalReceived.toLocaleString(), "text-[#1b2e28]"],
            ["Net difference", `${totalReceived - totalExpected > 0 ? "+" : ""}${(totalReceived - totalExpected).toLocaleString()}`, totalReceived !== totalExpected ? "text-amber-700" : "text-emerald-700"],
            ["QC damage", String(totalDamage), totalDamage > 0 ? "text-rose-700" : "text-emerald-700"],
            ["Avg variance", `${kpis.avgVar.toFixed(2)}%`, kpis.avgVar > 1 ? "text-amber-700" : "text-emerald-700"],
          ] as [string, string, string][]).map(([label, value, color]) => (
            <div key={label} className="flex items-center justify-between text-[11px] mb-1.5">
              <span className="text-muted-foreground">{label}</span>
              <span className={`font-mono font-semibold ${color}`}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-border bg-card p-4">
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-3">Status Distribution</p>
        <div className="space-y-2">
          {STAGE_DEFS.map((stage) => {
            const count = jobs.filter((j) => j.status === stage.id).length;
            const pct = jobs.length > 0 ? (count / jobs.length) * 100 : 0;
            if (count === 0) return null;
            return (
              <div key={stage.id} className="flex items-center gap-3">
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${stageIndicatorColor[stage.id]}`} />
                <span className="w-32 text-[10px] text-[#2a3530]">{stage.label}</span>
                <div className="flex-1 h-1.5 overflow-hidden rounded-full bg-[#e4ebe7]">
                  <div className="h-full rounded-full bg-[#3e8a74]" style={{ width: `${pct}%` }} />
                </div>
                <span className="font-mono text-[9px] text-muted-foreground w-8 text-right">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// INTEL CARD
// =============================================================================

function IntelCard({ tone, signal, context, rootCause, nextAction, onClick }: {
  tone: "red" | "rose" | "amber" | "green"; signal: string; context: string; rootCause: string; nextAction: string; onClick: () => void;
}) {
  const styles: Record<string, { border: string; action: string }> = {
    red: { border: "border-l-red-600 bg-red-50 border-red-100", action: "text-red-700" },
    rose: { border: "border-l-rose-500 bg-rose-50 border-rose-100", action: "text-rose-700" },
    amber: { border: "border-l-amber-500 bg-amber-50 border-amber-100", action: "text-amber-800" },
    green: { border: "border-l-emerald-500 bg-emerald-50 border-emerald-100", action: "text-emerald-700" },
  };
  return (
    <div className={`rounded border border-l-[3px] p-2 ${styles[tone].border}`}>
      <p className="text-[11px] font-bold text-[#1b2e28]">{signal}</p>
      <p className="mt-0.5 font-mono text-[9px] text-[#5c6964]">{context}</p>
      <p className="mt-0.5 text-[10px] leading-snug text-[#5c6964]">{rootCause}</p>
      <button onClick={onClick} className={`mt-1.5 text-[10px] font-bold hover:underline ${styles[tone].action}`}>{nextAction} →</button>
    </div>
  );
}

// =============================================================================
// DRAWER B — CREATE RECEIVING
// =============================================================================

function CreateReceivingDrawer({ onClose, onCreate, setNotice, options, optionsError }: {
  onClose: () => void;
  onCreate: (created: { jobId: string; jobNumber: string; receiptId: string; receiptNumber: string }) => Promise<void>;
  setNotice: (s: string) => void;
  options: InboundOptions;
  optionsError: string;
}) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [supplierId, setSupplierId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [poId, setPoId] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driver, setDriver] = useState("");
  const [vehicleType, setVehicleType] = useState<VehicleType>("carrier");
  const [notes, setNotes] = useState("");
  const [validationError, setValidationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => newIdempotencyKey("create-receipt"));

  const supplier = options.suppliers.find((s) => s.id === supplierId);
  const warehouse = options.warehouses.find((w) => w.id === warehouseId);
  const availablePOs = options.purchaseOrders.filter((po) => !supplierId || po.supplierId === supplierId);
  const selectedPO = availablePOs.find((po) => po.id === poId);
  const [acknowledgeTestMasterData, setAcknowledgeTestMasterData] = useState(false);
  const testLikeMasterData = /temporary|test|qa|root cause/i.test(`${supplier?.name ?? ""} ${supplier?.code ?? ""} ${warehouse?.name ?? ""} ${warehouse?.code ?? ""}`);
  const step1Valid = !!supplierId && !!warehouseId && vehicleNumber.trim().length > 0 && driver.trim().length > 0;

  const handleConfirm = async () => {
    if (busy) return;
    if (!supplierId || !warehouseId) { setValidationError("Choose an active supplier and warehouse from the database."); setStep(1); return; }
    if (!vehicleNumber.trim() || !driver.trim()) { setValidationError("Vehicle number and driver name are required."); setStep(1); return; }
    if (poId && !selectedPO) { setValidationError("The selected purchase order is no longer available. Reload operational data and try again."); setStep(2); return; }
    setBusy(true);
    setValidationError("");
    try {
      const raw = await createReceipt({
        supplier_id: supplierId,
        warehouse_id: warehouseId,
        po_id: selectedPO?.id ?? null,
        truck_number: vehicleNumber.trim(),
        truck_type: vehicleType,
        driver_name: driver.trim(),
        receipt_type: selectedPO ? "PO" : "MANUAL",
        notes: notes.trim() || null,
      }, idempotencyKey);
      const created = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const receiptId = typeof created.receiptId === "string" ? created.receiptId : "";
      const receiptNumber = typeof created.receiptNumber === "string" ? created.receiptNumber : "";
      const jobId = typeof created.jobId === "string" ? created.jobId : "";
      const jobNumber = typeof created.jobNumber === "string" ? created.jobNumber : "";
      if (!receiptId || !receiptNumber || !jobId || !jobNumber) {
        throw new Error(`Create RPC returned an incomplete result (${Object.keys(created).join(", ") || "empty response"}). Do not retry with a new request key; reload the dashboard first.`);
      }
      await onCreate({ jobId, jobNumber, receiptId, receiptNumber });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setValidationError(msg);
      setNotice(`Create inbound failed · ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const stepLabels = ["Vehicle & Origin", "Receipt Source", "Catalog Readiness", "Review & Create"];
  const fieldClass = "w-full rounded border border-border bg-white px-3 py-2 text-[12px] text-[#26302f] outline-none focus:border-[#24564e] disabled:bg-[#f0f1ed] disabled:text-muted-foreground";
  return (
    <aside className="absolute right-0 top-0 z-30 flex h-screen w-[480px] flex-col border-l border-border bg-[#fafbf8] shadow-[-8px_0_24px_rgba(18,40,32,.16)]">
      <div className="flex-shrink-0 border-b border-border px-4 py-3">
        <div className="mb-2 flex items-start justify-between">
          <div>
            <p className="font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground">Receiving · live database</p>
            <h2 className="font-slab text-[17px] font-bold text-[#17201f]">Create Receiving Session</h2>
          </div>
          <button onClick={onClose} disabled={busy} className="grid h-7 w-7 flex-shrink-0 place-items-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">×</button>
        </div>
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4].map((n) => <div key={n} className="flex items-center gap-1"><div className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[9px] font-bold ${step >= n ? "bg-[#24564e] text-white" : "bg-[#e4ebe7] text-[#68716d]"}`}>{n}</div>{n < 4 && <div className={`h-px w-6 ${step > n ? "bg-[#24564e]" : "bg-[#c8d5d0]"}`} />}</div>)}
          <span className="ml-1 text-[10px] font-semibold text-[#2a3530]">{stepLabels[step - 1]}</span>
        </div>
      </div>

      <div className="scrollbar-hidden flex-1 overflow-y-auto p-4">
        {optionsError && <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2.5 text-[10px] text-red-800">Could not load actual supplier/warehouse options: {optionsError}</div>}
        {step === 1 && <div className="space-y-4">
          <p className="text-[11px] text-muted-foreground">These values are loaded from the current Supabase project. The receipt will not be created if the selected master records are inactive.</p>
          <Field label="Supplier *" error="">
            <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPoId(""); setAcknowledgeTestMasterData(false); }} className={fieldClass} disabled={busy || options.suppliers.length === 0}>
              <option value="">Select active supplier</option>{options.suppliers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}
            </select>
            {options.suppliers.length === 0 && <p className="mt-1 text-[10px] text-amber-700">No active supplier returned by the database. Supplier master data must be fixed before creating a receipt.</p>}
          </Field>
          <Field label="Warehouse *" error="">
            <select value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setAcknowledgeTestMasterData(false); }} className={fieldClass} disabled={busy || options.warehouses.length === 0}>
              <option value="">Select active warehouse</option>{options.warehouses.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
            </select>
            {options.warehouses.length === 0 && <p className="mt-1 text-[10px] text-amber-700">No active warehouse returned by the database.</p>}
          </Field>
          <Field label="Vehicle Number *" error=""><input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="e.g. TRK-102" className={fieldClass} autoComplete="off" /></Field>
          <Field label="Driver Name *" error=""><input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="Driver full name" className={fieldClass} autoComplete="off" /></Field>
          <Field label="Vehicle Type *" error="">
            <div className="grid grid-cols-3 gap-2">{(["supplier", "company", "carrier"] as VehicleType[]).map((type) => <button type="button" key={type} onClick={() => setVehicleType(type)} className={`rounded border px-3 py-2 text-[11px] font-semibold capitalize transition ${vehicleType === type ? "border-[#24564e] bg-[#e3eeea] text-[#1b4740]" : "border-border text-muted-foreground hover:border-[#24564e]"}`}>{type}</button>)}</div>
          </Field>
          <Field label="Notes" error=""><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Optional gate/receiving notes" className={fieldClass} /></Field>
        </div>}

        {step === 2 && <div className="space-y-4">
          <div className="rounded border border-[#c8ddd5] bg-[#edf5f0] p-3">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-[#2a6457]">Database receipt source</p>
            <p className="mt-1 text-[12px] font-semibold text-[#2a6457]">{supplier?.name ?? "Choose a supplier first"}</p>
            <p className="text-[10px] text-[#3a7868]">{warehouse?.code ?? "Choose a warehouse first"}</p>
          </div>
          <Field label="Open Purchase Order (optional)" error="">
            <select value={poId} onChange={(e) => setPoId(e.target.value)} className={fieldClass} disabled={busy || !availablePOs.length}>
              <option value="">Manual receipt · no PO linked</option>
              {availablePOs.map((po) => <option key={po.id} value={po.id}>{po.poNumber} · {po.supplier} · {po.status}</option>)}
            </select>
            {!options.purchaseOrders.length && <p className="mt-1 text-[10px] text-amber-700">The live database currently returned 0 open purchase orders. This session will be created as a Manual Receipt; it will not invent or link a fake PO.</p>}
            {options.purchaseOrders.length > 0 && !availablePOs.length && <p className="mt-1 text-[10px] text-amber-700">No open PO belongs to the selected supplier. Choose Manual Receipt or change the supplier.</p>}
          </Field>
          {selectedPO && <div className="rounded border border-border bg-white p-3 text-[11px]"><p className="font-semibold">{selectedPO.poNumber}</p><p className="mt-1 text-muted-foreground">Supplier: {selectedPO.supplier} · Status: {selectedPO.status}</p><p className="mt-1 text-muted-foreground">PO lines and remaining quantities will be validated by the database when items are scanned.</p></div>}
          <p className="text-[10px] leading-relaxed text-muted-foreground">Selecting an open PO sends its real database ID to the creation RPC. Without a PO, the backend creates an explicitly typed Manual Receipt.</p>
        </div>}

        {step === 3 && <div className="space-y-4">
          <div className="rounded border border-border bg-white p-3">
            <div className="flex items-center justify-between"><p className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Active SKU Catalog</p><span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${options.skus.length ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{options.skus.length} active</span></div>
            {options.skus.length ? <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">{options.skus.slice(0, 20).map((sku) => <div key={sku.id} className="flex items-center justify-between border-b border-border py-1.5 last:border-0"><span className="font-mono text-[10px] text-[#1c5047]">{sku.skuCode}</span><span className="text-[9px] text-muted-foreground">{sku.barcodes.length} barcode(s)</span></div>)}</div> : <p className="mt-2 text-[11px] leading-relaxed text-amber-800">The database currently returns no active SKUs for receiving. The existing SKU hierarchy contains Draft master data. You can still create the real inbound job now, but you must onboard/activate an SKU before a receipt line can be recorded. No sample SKU or barcode will be substituted.</p>}
          </div>
          <div className="rounded border border-[#c8ddd5] bg-[#edf5f0] p-3 text-[10px] leading-relaxed text-[#2a6457]">Creating this session creates the truck log, receipt, inbound job and audit event through the protected database RPC. Receipt lines, scans, QC, stock and Putaway are separate controlled steps after creation.</div>
        </div>}

        {step === 4 && <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">Review the actual values that will be submitted to Supabase.</p>
          <div className="overflow-hidden rounded border border-border bg-white">
            {([ ["Supplier", supplier ? `${supplier.name} · ${supplier.code}` : "Not selected"], ["Warehouse", warehouse ? `${warehouse.code} · ${warehouse.name}` : "Not selected"], ["Receipt Type", selectedPO ? "PO Receipt" : "Manual Receipt"], ["Purchase Order", selectedPO?.poNumber ?? "No PO"], ["Vehicle", vehicleNumber.trim() || "Not entered"], ["Driver", driver.trim() || "Not entered"], ["Vehicle Type", vehicleType], ["SKU Catalog", `${options.skus.length} active SKU(s)`] ] as [string, string][]).map(([key, value]) => <div key={key} className="grid grid-cols-[110px_1fr] gap-2 border-b border-border px-3 py-2 last:border-0"><span className="font-mono text-[9px] uppercase text-muted-foreground">{key}</span><span className="break-words text-[11px] font-semibold text-[#26302f]">{value}</span></div>)}
          </div>
          {validationError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-2.5 text-[10px] text-red-800">{validationError}</div>}
          {testLikeMasterData && <div className="rounded border border-amber-300 bg-amber-50 p-3 text-[10px] leading-relaxed text-amber-900"><p className="font-bold">Test/temporary master data detected</p><p className="mt-1">The selected supplier or warehouse is named like test data (for example, Temporary Supplier, Test Warehouse, or Root Cause WH). This is the live Supabase catalog, but it is not yet proof of production-ready master data. Do not create a real operational receipt here unless you intend to create a test record.</p><label className="mt-2 flex items-start gap-2 font-semibold"><input type="checkbox" checked={acknowledgeTestMasterData} onChange={(e) => setAcknowledgeTestMasterData(e.target.checked)} disabled={busy} className="mt-0.5"/><span>I understand these selected records appear to be test/temporary master data and I am intentionally creating a test receipt.</span></label></div>}
          <p className="text-[10px] leading-relaxed text-muted-foreground">The create request uses one stable idempotency key. If the request times out, do not start another create session with new data until the dashboard is refreshed and the result is reconciled.</p>
        </div>}
      </div>

      <div className="flex-shrink-0 border-t border-border px-4 py-3 flex items-center justify-between gap-2">
        {step > 1 ? <button onClick={() => { setValidationError(""); setStep((n) => (n - 1) as 1 | 2 | 3 | 4); }} disabled={busy} className="rounded border border-border px-4 py-2 text-[12px] font-semibold text-muted-foreground hover:bg-[#f2f5f2] disabled:opacity-50">← Back</button> : <button onClick={onClose} disabled={busy} className="rounded border border-border px-4 py-2 text-[12px] font-semibold text-muted-foreground hover:bg-[#f2f5f2] disabled:opacity-50">Cancel</button>}
        {step < 4 ? <button onClick={() => {
          if (step === 1 && !step1Valid) { setValidationError("Choose supplier and warehouse, and enter vehicle number and driver."); return; }
          if (step === 2 && !supplierId) { setValidationError("Select a valid supplier before continuing."); return; }
          setValidationError(""); setStep((n) => (n + 1) as 1 | 2 | 3 | 4);
        }} disabled={busy} className="rounded border border-[#24564e] bg-[#24564e] px-4 py-2 text-[12px] font-bold text-white hover:bg-[#183f39] disabled:opacity-50">Next →</button> : <button onClick={() => { void handleConfirm(); }} disabled={busy || !supplierId || !warehouseId || !vehicleNumber.trim() || !driver.trim() || (testLikeMasterData && !acknowledgeTestMasterData)} className="rounded border border-[#24564e] bg-[#24564e] px-4 py-2 text-[12px] font-bold text-white hover:bg-[#183f39] disabled:opacity-50">{busy ? "Creating in database…" : testLikeMasterData ? "Create Test Inbound Job" : "Create Inbound Job"}</button>}
      </div>
    </aside>
  );
}

function Field({ label, error, children }: { label: string; error: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-[10px] text-red-600">{error}</p>}
    </div>
  );
}

// =============================================================================
// JOB DRAWER (Drawer A)
// =============================================================================

function JobDrawer({ job, tab, onTab, onClose, onAction, putawayTasks, detail, activity, audit, options, optionsError, onAddedLine }: {
  detail: DetailState | null; job: Job; tab: DrawerTab; onTab: (t: DrawerTab) => void; onClose: () => void; onAction: () => void; putawayTasks: PutawayTask[];
  activity: HistoryState | null; audit: HistoryState | null; options: InboundOptions; optionsError: string; onAddedLine: () => Promise<void>;
}) {
  const tabs: DrawerTab[] = ["Overview", "Receipt Lines", "Timeline", "Audit", "Relationships", "Documents", "Notes", "Metrics"];
  const diff = difference(job);
  const vPct = variancePct(job);

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-screen w-[440px] flex-col border-l border-border bg-[#fafbf8] shadow-[-6px_0_20px_rgba(18,40,32,.10)]">
      <div className="flex-shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1 pr-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[11px] font-bold text-[#1c5047]">{job.jobNumber ?? job.id}</span>
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] capitalize ${statusStyle[job.status]}`}>{prettify(job.status)}</span>
              {job.issue && <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${job.issue === "QC" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>{job.issue}</span>}
            </div>
            <h2 className="font-slab text-[17px] font-bold leading-tight text-[#17201f] truncate">{job.supplier}</h2>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{job.po}</span><span>·</span><span>{job.warehouse}</span>
              {job.dock && <><span>·</span><span>{job.dock}</span></>}
              {job.vehicleNumber && <><span>·</span><span className="font-mono">{job.vehicleNumber}</span></>}
            </div>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 flex-shrink-0 place-items-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground">×</button>
        </div>
        <div className="mt-2.5 grid grid-cols-4 divide-x divide-border rounded border border-border bg-[#f4f6f3]">
          {([["Exp.", job.expected.toLocaleString()], ["Rcv.", job.received.toLocaleString()], ["Diff.", diff !== 0 ? `${diff > 0 ? "+" : ""}${diff}` : "—"], ["Var.", vPct !== 0 ? `${vPct > 0 ? "+" : ""}${vPct.toFixed(1)}%` : "—"]] as [string, string][]).map(([k, v]) => (
            <div key={k} className="px-2 py-1.5">
              <p className="font-mono text-[8px] uppercase tracking-[0.07em] text-muted-foreground">{k}</p>
              <p className={`font-mono text-[13px] font-semibold leading-none mt-0.5 ${k === "Diff." && diff !== 0 ? "text-amber-700" : k === "Var." && Math.abs(vPct) > 1 ? "text-amber-700" : "text-[#1b2e28]"}`}>{v}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="scrollbar-hidden flex-shrink-0 flex gap-0 overflow-x-auto border-b border-border px-2">
        {tabs.map((item) => (
          <button key={item} onClick={() => onTab(item)} className={`whitespace-nowrap border-b-2 px-2.5 py-2 text-[10px] font-semibold transition-colors ${tab === item ? "border-[#276157] text-[#1f5c51]" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {item}
          </button>
        ))}
      </div>
      <div className="scrollbar-hidden flex-1 overflow-y-auto p-4">
        {detail && detail.id === job.id && (detail.loading
          ? <p className="mb-3 rounded border border-border bg-[#f4f6f3] px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">Loading receipt detail…</p>
          : detail.error && <p role="alert" className="mb-3 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800">Receipt detail unavailable · <span className="font-mono">{detail.error}</span></p>)}
        {tab === "Overview" && <DrawerOverview job={job} putawayTasks={putawayTasks} bins={options.bins} />}
        {tab === "Receipt Lines" && (detail && detail.id === job.id && detail.lines
          ? <DrawerReceiptLines job={job} lines={detail.lines} options={options} optionsError={optionsError} onAddedLine={onAddedLine} />
          : <DrawerEmpty title={detail?.loading ? "Loading receipt lines…" : "Receipt lines unavailable"} text={!job.receiptId ? "This job has no linked receipt. Check the job/receipt relationship in the database; do not create a second job as a workaround." : detail?.error ? "The receipt detail RPC failed." : detail?.loading ? "Fetching the receipt detail from Supabase." : "The response did not include a valid receipt-lines array."} />)}
        {tab === "Timeline" && <DrawerTimeline job={job} state={activity} />}
        {tab === "Audit" && <DrawerAudit job={job} state={audit} />}
        {tab === "Relationships" && <DrawerRelationships job={job} putawayTasks={putawayTasks} lines={detail?.id === job.id ? detail.lines : null} />}
        {tab === "Documents" && <DrawerDocuments key={job.receiptId ?? job.id} job={job} />}
        {tab === "Notes" && <DrawerNotes key={job.receiptId ?? job.id} job={job} />}
        {tab === "Metrics" && <DrawerMetrics job={job} />}
      </div>
    </aside>
  );
}

function DSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <p className="mb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      {children}
    </section>
  );
}

function DrawerOverview({ job, putawayTasks, bins }: { job: Job; putawayTasks: PutawayTask[]; bins: InboundOptions["bins"] }) {
  const reasons = assessJob(job, putawayTasks, bins).sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
  const top = reasons[0];
  const diff = difference(job);
  const vPct = variancePct(job);
  const isAging = job.ageMinutes > 240;
  return (
    <>
      {job.issue && (
        <div className={`mb-4 rounded border p-3 ${job.issue === "QC" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`h-1.5 w-1.5 rounded-full ${job.issue === "QC" ? "bg-rose-600" : "bg-amber-600"}`} />
            <p className={`text-[11px] font-bold ${job.issue === "QC" ? "text-rose-900" : "text-amber-900"}`}>Exception: {job.issue} review required</p>
          </div>
          <p className={`text-[11px] leading-snug ${job.issue === "QC" ? "text-rose-800" : "text-amber-800"}`}>
            {job.issue === "QC" ? `${job.damage} damage units logged. QC sign-off required before receipt confirmation.` :
              job.issue === "Validation" ? "Barcode conflicts detected. Confirmation blocked until identifiers are resolved." :
              job.issue === "Blocked" ? "Receiving session has no assigned owner. Dock resource needed." :
              job.issue === "Variance" ? `Received vs expected variance at ${Math.abs(vPct).toFixed(1)}% — above the app’s provisional 1.0% review threshold.` :
              "No update for longer than the app’s provisional 4h attention threshold. Review the job; an SLA policy is not configured."}
          </p>
        </div>
      )}
      {isOpen(job) && (
        <DSection label="Control Tower assessment">
          <div className="rounded border border-border bg-white">
            <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
              {top ? <SevChip sev={top.sev} /> : <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase text-emerald-800">In control</span>}
              <span className="font-mono text-[10px] text-muted-foreground">{exposureOf(job).toLocaleString()} units exposed · {job.age}</span>
            </div>
            <div className="space-y-1 px-2.5 py-2 text-[11px]">
              {reasons.length === 0 && <p className="text-[#4a5550]">No risk signals. Next: {nextFor(job).label}.</p>}
              {reasons.map((r) => <p key={r.kind} className="leading-snug"><b className="text-[#1b2e28]">{r.kind}</b> <span className="text-[#5a6660]">· {r.cause}</span></p>)}
              {top && <p className="pt-1 font-mono text-[10px] text-[#276157]">Next: {top.next} → {top.module}</p>}
            </div>
            <p className="border-t border-border px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground">Trace: Supplier → PO → Batch → Lot → QC → Putaway → Bin → Audit</p>
          </div>
        </DSection>
      )}
      <DSection label="Operational readout">
        <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded border border-border">
          {([["Expected qty.", job.expected.toLocaleString()], ["Received qty.", job.received.toLocaleString()], ["Difference", diff !== 0 ? `${diff > 0 ? "+" : ""}${diff}` : "None"], ["Variance", vPct !== 0 ? `${vPct > 0 ? "+" : ""}${vPct.toFixed(1)}%` : "0.0%"], ["QC damage", job.damage ? `${job.damage} units` : "None"], ["Job age", `${job.age}${isAging ? " ⚑" : ""}`]] as [string, string][]).map(([k, v]) => (
            <div key={k} className="p-2.5">
              <p className="text-[10px] text-muted-foreground">{k}</p>
              <p className={`mt-0.5 font-mono text-[13px] font-semibold ${(k === "Difference" && diff !== 0) || (k === "Variance" && Math.abs(vPct) > 1) ? "text-amber-700" : k === "QC damage" && job.damage ? "text-rose-700" : k === "Job age" && isAging ? "text-amber-700" : "text-[#1b2e28]"}`}>{v}</p>
            </div>
          ))}
        </div>
      </DSection>
      <DSection label="Job context">
        <div className="rounded border border-border divide-y divide-border text-[12px]">
          {([["Purchase order", job.po], ["Warehouse", job.warehouse], ["Dock / Location", job.dock ?? "—"], ["Owner", job.owner], ["Receipt", job.receipt], ["Vehicle", job.vehicleNumber ?? "—"], ["Driver", job.driver ?? "—"], ["Vehicle type", job.vehicleType ? job.vehicleType.charAt(0).toUpperCase() + job.vehicleType.slice(1) : "—"], ["Last updated", job.updated]] as [string, string][]).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between px-2.5 py-1.5">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-mono text-[11px] font-medium text-[#2a3530]">{v}</span>
            </div>
          ))}
        </div>
      </DSection>
      <p className="rounded border border-border bg-[#f4f6f3] p-2.5 text-[10px] leading-relaxed text-muted-foreground">Operational state changes are enabled only through the validated actions in Receipt Lines, QC Review, and Putaway. No local-only status update is performed.</p>
    </>
  );
}

function DrawerReceiptLines({ job, lines, options, optionsError, onAddedLine }: {
  job: Job; lines: LiveLine[]; options: InboundOptions; optionsError: string; onAddedLine: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [confirmBinId, setConfirmBinId] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [confirmSuccess, setConfirmSuccess] = useState("");
  const [confirmKey, setConfirmKey] = useState(() => newIdempotencyKey("confirm-receipt"));
  const tExp = lines.reduce((s, l) => s + l.expected, 0);
  const tRcv = lines.reduce((s, l) => s + l.received, 0);
  const warehouse = options.warehouses.find((w) => w.code === job.warehouse);
  const receivingBins = warehouse ? options.bins.filter((bin) => bin.warehouseId === warehouse.id) : [];
  const linesNeedQC = lines.filter((line) => line.received > 0);
  const allRequiredQCRecorded = linesNeedQC.length > 0 && linesNeedQC.every((line) => line.qcChecked && line.qcPass + line.qcFail === line.received);
  const canAddLine = !!job.receiptId && ["receiving", "identifying", "counting"].includes(job.status);
  const canConfirm = !!job.receiptId && job.status === "qc_in_progress" && lines.length > 0 && allRequiredQCRecorded && !!confirmBinId && !confirmBusy;

  useEffect(() => {
    if (!confirmBinId && receivingBins.length) setConfirmBinId(receivingBins[0].id);
    if (confirmBinId && !receivingBins.some((bin) => bin.id === confirmBinId)) setConfirmBinId("");
  }, [confirmBinId, receivingBins]);

  const handleConfirm = async () => {
    if (!job.receiptId) return setConfirmError("This job has no linked receipt ID.");
    if (!allRequiredQCRecorded) return setConfirmError("Every received line must have a valid QC decision before confirmation.");
    if (!confirmBinId) return setConfirmError("Select a live receiving bin for the same warehouse.");
    setConfirmBusy(true); setConfirmError(""); setConfirmSuccess("");
    try {
      const result = await confirmReceipt(job.receiptId, confirmBinId, confirmKey) as Record<string, unknown>;
      setConfirmSuccess(`Receipt confirmed. ${String(result?.putawayTasksCreated ?? result?.putawayTaskCount ?? "Putaway tasks")}`);
      setConfirmKey(newIdempotencyKey("confirm-receipt"));
      await onAddedLine();
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : String(e));
    } finally { setConfirmBusy(false); }
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{lines.length} line(s) · {job.receipt}</p>
        <div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
          <span>Exp: <span className="font-semibold text-[#1b2e28]">{tExp}</span></span>
          <span>Rcv: <span className={`font-semibold ${tRcv !== tExp ? "text-amber-700" : "text-[#1b2e28]"}`}>{tRcv}</span></span>
        </div>
      </div>
      <div className="mb-3 flex items-center justify-between gap-2 rounded border border-border bg-white p-2.5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-[#26302f]">Receiving line entry</p>
          <p className="text-[9px] text-muted-foreground">Uses active database SKUs and the protected receipt-line RPC.</p>
        </div>
        <button onClick={() => setAdding((v) => !v)} disabled={!canAddLine} className="flex-shrink-0 rounded border border-[#24564e] bg-[#24564e] px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-[#183f39] disabled:cursor-not-allowed disabled:opacity-40">{adding ? "Close" : "+ Add line"}</button>
      </div>
      {!canAddLine && job.receiptId && <p className="mb-3 rounded border border-border bg-[#f4f6f3] p-2 text-[10px] text-muted-foreground">Line entry is available only while the job is Receiving, Identifying, or Counting. Current state: {prettify(job.status)}.</p>}
      {adding && canAddLine && <AddReceiptLineForm job={job} options={options} optionsError={optionsError} onAddedLine={onAddedLine} />}
      {!job.receiptId && <p className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-[10px] text-amber-800">No linked receipt ID is available for this job. Line entry is blocked rather than writing against a guessed receipt.</p>}
      {lines.length === 0 ? <div className="rounded border border-dashed border-border bg-white px-3 py-6 text-center"><p className="text-[12px] font-semibold text-[#26302f]">No receipt lines yet</p><p className="mt-1 text-[10px] text-muted-foreground">Add an active SKU line after the Product catalog is ready. The job itself was not given sample items.</p></div> : <div className="overflow-hidden rounded border border-border">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] border-b border-border bg-[#f3f5f2] px-2 py-1.5 font-mono text-[8px] uppercase tracking-[0.07em] text-muted-foreground">
          <span>SKU / Description</span><span className="px-2">UOM</span><span className="w-14 px-2 text-right">Exp.</span><span className="w-14 px-2 text-right">Rcv.</span><span className="w-10 px-2 text-right">Diff.</span>
        </div>
        {lines.map((line) => {
          const diff = line.received - line.expected;
          return <div key={line.id ?? `${line.sku}-${line.expected}-${line.received}`} className={`grid grid-cols-[1fr_auto_auto_auto_auto] items-center border-b border-border px-2 py-2 last:border-0 hover:bg-[#f7f9f6] ${line.status === "variance" ? "bg-amber-50/30" : ""}`}>
            <div className="min-w-0"><p className="truncate font-mono text-[9px] font-semibold text-[#1c5047]">{line.sku}</p><p className="truncate text-[10px] text-[#3a4540]">{line.description}</p>{line.barcode && <p className="font-mono text-[8px] text-muted-foreground">{line.barcode}</p>}<p className={`mt-0.5 text-[9px] font-semibold ${line.qcChecked ? "text-emerald-700" : line.received > 0 ? "text-amber-700" : "text-muted-foreground"}`}>{line.received === 0 ? "No received quantity · QC not required" : line.qcChecked ? `QC recorded · Pass ${line.qcPass} / Fail ${line.qcFail}` : "QC decision required"}</p></div>
            <span className="px-2 font-mono text-[9px] text-muted-foreground">{line.uom}</span>
            <span className="w-14 px-2 text-right font-mono text-[10px] text-[#4a5550]">{line.expected}</span>
            <span className="w-14 px-2 text-right font-mono text-[10px] font-medium text-[#1b2e28]">{line.received}</span>
            <span className={`w-10 px-2 text-right font-mono text-[10px] font-bold ${diff !== 0 ? "text-amber-700" : "text-muted-foreground"}`}>{diff > 0 ? "+" : ""}{diff !== 0 ? diff : "—"}</span>
            {job.receiptId && line.id && line.received > 0 && !line.qcChecked && ["identifying", "counting", "qc_in_progress"].includes(job.status) && <div className="col-span-5 mt-2"><ReceiptLineQCForm job={job} line={line} onDone={onAddedLine} /></div>}
          </div>;
        })}
      </div>}
      {lines.length > 0 && <div className="mt-3 rounded border border-border bg-[#f4f6f3] p-2.5"><div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Lines with variance</span><span className="font-mono font-semibold text-amber-700">{lines.filter((l) => l.status === "variance").length} of {lines.length}</span></div><div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#e4ebe7]"><div className="h-full rounded-full bg-[#3e8a74]" style={{ width: `${lines.length ? (lines.filter((l) => l.status === "ok").length / lines.length) * 100 : 0}%` }} /></div></div>}

      {job.status === "qc_in_progress" && <div className="mt-4 rounded border border-[#c8ddd5] bg-[#edf5f0] p-3 space-y-2">
        <p className="text-[11px] font-bold text-[#214f44]">Confirm receipt and create Putaway tasks</p>
        <p className="text-[9px] leading-relaxed text-[#527067]">Confirmation is a protected database transaction. It checks line totals, QC checks, shortage reasons, workflow transitions, same-warehouse bin and capacity before posting QC-hold inventory and creating Putaway tasks.</p>
        <label className="block text-[9px] font-semibold text-[#35443f]">Receiving / QC-hold bin<select value={confirmBinId} onChange={(e) => setConfirmBinId(e.target.value)} className="mt-1 w-full rounded border border-border bg-white px-2 py-1.5 text-[10px]" disabled={confirmBusy || receivingBins.length === 0}><option value="">Choose live bin</option>{receivingBins.map((bin) => <option key={bin.id} value={bin.id} disabled={bin.overCapacity || bin.availableCapacity < tRcv}>{bin.code} · available {bin.availableCapacity} · {bin.status}{bin.overCapacity || bin.availableCapacity < tRcv ? " · Insufficient capacity" : ""}</option>)}</select></label>
        {!receivingBins.length && <p className="text-[10px] text-amber-800">No eligible bin from the live database matches this job's warehouse. Correct the warehouse/bin master data before confirming.</p>}
        {!allRequiredQCRecorded && <p className="text-[10px] text-amber-800">QC is still incomplete for received lines. Record a QC decision for every received line before confirming.</p>}
        {confirmError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-[9px] text-red-800">{confirmError}</p>}{confirmSuccess && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[9px] text-emerald-800">{confirmSuccess}</p>}
        <button onClick={() => { void handleConfirm(); }} disabled={!canConfirm} className="w-full rounded border border-[#24564e] bg-[#24564e] px-3 py-2 text-[10px] font-bold text-white hover:bg-[#183f39] disabled:cursor-not-allowed disabled:opacity-50">{confirmBusy ? "Confirming in database…" : "Confirm Receipt"}</button>
      </div>}
    </>
  );
}

function ReceiptLineQCForm({ job, line, onDone }: { job: Job; line: LiveLine; onDone: () => Promise<void> }) {
  const [qtyPass, setQtyPass] = useState(String(line.received));
  const [qtyFail, setQtyFail] = useState("0");
  const [failReason, setFailReason] = useState("");
  const [evidence, setEvidence] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("record-qc"));
  const field = "w-full rounded border border-border bg-white px-2 py-1.5 text-[10px] outline-none focus:border-[#24564e] disabled:opacity-60";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError("");
    const pass = Number(qtyPass), fail = Number(qtyFail);
    if (!line.id || !job.receiptId) return setError("The database line ID or receipt ID is missing. QC is blocked.");
    if (!Number.isInteger(pass) || !Number.isInteger(fail) || pass < 0 || fail < 0 || pass + fail !== line.received) return setError(`Pass + fail must equal received quantity (${line.received}).`);
    if (fail > 0 && failReason.trim().length < 5) return setError("Explain the QC failure with at least 5 characters.");
    if (fail > 0 && !evidence) return setError("An evidence image is required when any units fail QC.");
    if (evidence && !["image/jpeg", "image/png", "image/webp"].includes(evidence.type)) return setError("Choose a JPEG, PNG, or WebP image.");
    if (evidence && evidence.size > 5 * 1024 * 1024) return setError("Evidence image must be no larger than 5 MB.");
    setBusy(true);
    let uploadedPath: string | null = null;
    try {
      const paths: string[] = [];
      if (fail > 0 && evidence) { uploadedPath = await uploadQcEvidence(job.receiptId, line.id, evidence); paths.push(uploadedPath); }
      await recordQC({ receiptLineId: line.id, qtyPass: pass, qtyFail: fail, failReason: failReason.trim() || null, evidencePaths: paths, idempotencyKey: key });
      setKey(newIdempotencyKey("record-qc"));
      await onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (uploadedPath) {
        try { await removeQcEvidence([uploadedPath]); }
        catch (cleanupError) { setError(`${msg} Evidence upload cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); return; }
      }
      setError(msg);
    } finally { setBusy(false); }
  };
  return <form onSubmit={(e) => { void submit(e); }} className="rounded border border-[#d8c7cd] bg-[#fff8fa] p-2.5 space-y-2">
    <div><p className="text-[10px] font-bold text-[#743746]">QC decision · {line.sku}</p><p className="text-[9px] text-[#875c68]">Pass + fail must equal {line.received} units. Failed units require a reason and evidence image.</p></div>
    <div className="grid grid-cols-2 gap-2"><label className="block text-[9px] font-semibold text-[#35443f]">Pass quantity<input className={`mt-1 ${field}`} type="number" min="0" max={line.received} step="1" value={qtyPass} onChange={(e) => setQtyPass(e.target.value)} disabled={busy}/></label><label className="block text-[9px] font-semibold text-[#35443f]">Fail quantity<input className={`mt-1 ${field}`} type="number" min="0" max={line.received} step="1" value={qtyFail} onChange={(e) => setQtyFail(e.target.value)} disabled={busy}/></label></div>
    <label className="block text-[9px] font-semibold text-[#35443f]">Failure reason{Number(qtyFail) > 0 ? " *" : ""}<input className={`mt-1 ${field}`} value={failReason} onChange={(e) => setFailReason(e.target.value)} placeholder="Damage, defect, wrong material…" disabled={busy || Number(qtyFail) === 0} /></label>
    <label className="block text-[9px] font-semibold text-[#35443f]">Evidence image{Number(qtyFail) > 0 ? " *" : ""}<input className={`mt-1 ${field}`} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setEvidence(e.target.files?.[0] ?? null)} disabled={busy || Number(qtyFail) === 0} /></label>
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-[9px] text-red-800">QC could not be saved: {error}</p>}
    <button disabled={busy} className="w-full rounded border border-[#793b4b] bg-[#793b4b] px-3 py-1.5 text-[10px] font-bold text-white hover:bg-[#5c2d3a] disabled:opacity-50">{busy ? "Uploading evidence / saving QC…" : "Save QC decision"}</button>
  </form>;
}

function AddReceiptLineForm({ job, options, optionsError, onAddedLine }: {
  job: Job; options: InboundOptions; optionsError: string; onAddedLine: () => Promise<void>;
}) {
  const [skuId, setSkuId] = useState("");
  const [expectedQty, setExpectedQty] = useState("1");
  const [actualQty, setActualQty] = useState("0");
  const [barcodeValue, setBarcodeValue] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [shortageReason, setShortageReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showSkuOnboarding, setShowSkuOnboarding] = useState(false);
  const [lineKey, setLineKey] = useState(() => newIdempotencyKey("add-receipt-line"));
  const [skuKey, setSkuKey] = useState(() => newIdempotencyKey("create-product-sku"));
  const sku = options.skus.find((item) => item.id === skuId) ?? options.skus[0];
  useEffect(() => {
    if (!skuId && options.skus.length) setSkuId(options.skus[0].id);
  }, [skuId, options.skus]);

  const submitLine = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setSuccess("");
    const expected = Number(expectedQty), actual = Number(actualQty);
    if (!job.receiptId) return setError("This job has no receipt ID. Line entry is blocked.");
    if (!sku) return setError("No active SKU exists. Create/activate a SKU before recording a receipt line.");
    if (!Number.isInteger(expected) || expected <= 0 || !Number.isInteger(actual) || actual < 0) return setError("Expected quantity must be a positive integer; actual quantity must be a non-negative integer.");
    if (!barcodeValue.trim() && manualReason.trim().length < 5) return setError("Enter a barcode that resolves to this SKU, or explain manual identification with at least 5 characters.");
    if (actual < expected && shortageReason.trim().length < 5) return setError("A shortage reason (at least 5 characters) is required when actual quantity is below expected.");
    setBusy(true);
    try {
      await addReceiptLine({ receiptId: job.receiptId, skuId: sku.id, expectedQty: expected, actualQty: actual,
        barcodeValue: barcodeValue.trim() || null, manualReason: manualReason.trim() || null,
        shortageReason: shortageReason.trim() || null, idempotencyKey: lineKey });
      setSuccess("Receipt line saved to the database.");
      await onAddedLine();
      setLineKey(newIdempotencyKey("add-receipt-line"));
      setActualQty("0"); setBarcodeValue(""); setManualReason(""); setShortageReason("");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2));
    } finally { setBusy(false); }
  };

  const field = "w-full rounded border border-border bg-white px-2 py-1.5 text-[10px] outline-none focus:border-[#24564e] disabled:opacity-60";
  return <div className="mb-3 rounded border border-[#b9d4c9] bg-[#f2f8f4] p-3 space-y-3">
    <div className="flex items-start justify-between gap-2"><div><p className="text-[11px] font-bold text-[#214f44]">Add receipt line</p><p className="text-[9px] text-[#527067]">The backend validates SKU status, barcode, permissions and quantity rules.</p></div>
      {!options.skus.length && <button type="button" onClick={() => setShowSkuOnboarding((v) => !v)} className="rounded border border-[#24564e] bg-white px-2 py-1 text-[9px] font-semibold text-[#24564e]">{showSkuOnboarding ? "Hide SKU form" : "Create SKU"}</button>}</div>
    {optionsError && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-[9px] text-amber-800">Product/options read failed: {optionsError}</p>}
    {options.skus.length > 0 ? <form onSubmit={submitLine} className="space-y-2">
      <label className="block text-[9px] font-semibold text-[#35443f]">Active SKU<select value={skuId || sku?.id || ""} onChange={(e) => { setSkuId(e.target.value); setBarcodeValue(""); }} className={`mt-1 ${field}`} disabled={busy}><option value="">Select SKU</option>{options.skus.map((item) => <option value={item.id} key={item.id}>{item.skuCode} · {item.status}</option>)}</select></label>
      <div className="grid grid-cols-2 gap-2"><label className="block text-[9px] font-semibold text-[#35443f]">Expected Qty<input type="number" min="1" step="1" value={expectedQty} onChange={(e) => setExpectedQty(e.target.value)} className={`mt-1 ${field}`} disabled={busy}/></label><label className="block text-[9px] font-semibold text-[#35443f]">Actual Qty<input type="number" min="0" step="1" value={actualQty} onChange={(e) => setActualQty(e.target.value)} className={`mt-1 ${field}`} disabled={busy}/></label></div>
      <label className="block text-[9px] font-semibold text-[#35443f]">Barcode (must resolve to the selected SKU)<input value={barcodeValue} onChange={(e) => setBarcodeValue(e.target.value)} placeholder={sku?.barcodes.find((b) => b.primary)?.value ?? "Scan/enter barcode"} className={`mt-1 font-mono ${field}`} disabled={busy}/></label>
      <label className="block text-[9px] font-semibold text-[#35443f]">Manual identification reason (required without barcode)<input value={manualReason} onChange={(e) => setManualReason(e.target.value)} placeholder="Reason for manual SKU identification" className={`mt-1 ${field}`} disabled={busy || !!barcodeValue.trim()}/></label>
      <label className="block text-[9px] font-semibold text-[#35443f]">{"Shortage reason (required if actual < expected)"}<input value={shortageReason} onChange={(e) => setShortageReason(e.target.value)} placeholder="Explain the quantity difference" className={`mt-1 ${field}`} disabled={busy || Number(actualQty) >= Number(expectedQty)}/></label>
      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-[9px] text-red-800">{error}</p>}{success && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[9px] text-emerald-800">{success}</p>}
      <button disabled={busy || !skuId} className="w-full rounded border border-[#24564e] bg-[#24564e] px-3 py-2 text-[10px] font-bold text-white hover:bg-[#183f39] disabled:opacity-50">{busy ? "Saving line…" : "Save line to database"}</button>
    </form> : <div className="rounded border border-amber-200 bg-amber-50 p-2.5 text-[10px] leading-relaxed text-amber-900">The current database catalog contains <b>0 active SKUs</b>. Receipt-line entry cannot work until a real SKU and its product hierarchy/barcode are activated. No demo item is offered here.</div>}
    {showSkuOnboarding && <CreateSkuForm options={options} onCreated={async () => { await onAddedLine(); setShowSkuOnboarding(false); setSkuKey(newIdempotencyKey("create-product-sku")); }} skuKey={skuKey} setSkuKey={setSkuKey} />}
  </div>;
}

type CreateSkuFields = {
  brandCode: string; brandName: string; categoryCode: string; categoryName: string; styleCode: string; styleName: string;
  collectionCode: string; collectionName: string; seasonCode: string; seasonName: string; seasonYear: string;
  colorCode: string; colorName: string; colorHex: string; sizeCode: string; sizeName: string; sizeSortOrder: string;
  skuCode: string; barcodeValue: string; barcodeType: "INTERNAL" | "EAN" | "SUPPLIER"; barcodeSupplierId: string;
};
const EMPTY_SKU_FIELDS: CreateSkuFields = {
  brandCode: "", brandName: "", categoryCode: "", categoryName: "", styleCode: "", styleName: "",
  collectionCode: "", collectionName: "", seasonCode: "", seasonName: "", seasonYear: String(new Date().getFullYear()),
  colorCode: "", colorName: "", colorHex: "", sizeCode: "", sizeName: "", sizeSortOrder: "100",
  skuCode: "", barcodeValue: "", barcodeType: "INTERNAL", barcodeSupplierId: "",
};
function CreateSkuForm({ options, onCreated, skuKey, setSkuKey }: {
  options: InboundOptions; onCreated: () => Promise<void>; skuKey: string; setSkuKey: (value: string) => void;
}) {
  const [form, setForm] = useState<CreateSkuFields>(EMPTY_SKU_FIELDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const setField = <K extends keyof CreateSkuFields>(key: K, value: CreateSkuFields[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const field = "w-full min-w-0 rounded border border-border bg-white px-2 py-1.5 text-[10px] outline-none focus:border-[#24564e]";
  const pairs: { key: keyof CreateSkuFields; label: string; placeholder?: string }[] = [
    {key:"brandCode",label:"Brand Code"},{key:"brandName",label:"Brand Name"},{key:"categoryCode",label:"Category Code"},{key:"categoryName",label:"Category Name"},
    {key:"styleCode",label:"Style Code"},{key:"styleName",label:"Style Name"},{key:"collectionCode",label:"Collection Code"},{key:"collectionName",label:"Collection Name"},
    {key:"seasonCode",label:"Season Code"},{key:"seasonName",label:"Season Name"},{key:"seasonYear",label:"Season Year"},{key:"colorCode",label:"Color Code"},
    {key:"colorName",label:"Color Name"},{key:"colorHex",label:"Color Hex (optional)"},{key:"sizeCode",label:"Size Code"},{key:"sizeName",label:"Size Name"},
    {key:"sizeSortOrder",label:"Size Sort Order"},{key:"skuCode",label:"SKU Code"},{key:"barcodeValue",label:"Barcode Value"},
  ];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setSuccess("");
    try {
      const payload: Record<string, unknown> = { ...form, seasonYear: Number(form.seasonYear), sizeSortOrder: Number(form.sizeSortOrder), barcodeSupplierId: form.barcodeSupplierId || null };
      await createProductSku(payload, skuKey);
      await onCreated();
      setForm(EMPTY_SKU_FIELDS);
      setSuccess("SKU created/activated and the live catalog was refreshed.");
    } catch (e2) { setError(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  };
  return <form onSubmit={submit} className="mt-3 space-y-2 border-t border-[#c8ddd5] pt-3">
    <div><p className="text-[10px] font-bold text-[#214f44]">Register product SKU</p><p className="text-[9px] text-[#527067]">Required product masters are validated and activated by the `mita_create_product_sku` RPC. Use real catalog data, not placeholders.</p></div>
    <div className="grid grid-cols-2 gap-2">{pairs.map(({key,label}) => <label key={key} className="block text-[8px] font-semibold text-[#35443f]">{label}<input required={!(["colorHex"] as (keyof CreateSkuFields)[]).includes(key)} type={key === "seasonYear" || key === "sizeSortOrder" ? "number" : "text"} min={key === "seasonYear" ? "1990" : key === "sizeSortOrder" ? "0" : undefined} value={form[key]} onChange={(e) => setField(key, e.target.value as CreateSkuFields[typeof key])} className={`mt-1 ${field}`} disabled={busy}/></label>)}</div>
    <div className="grid grid-cols-2 gap-2"><label className="block text-[8px] font-semibold text-[#35443f]">Barcode Type<select value={form.barcodeType} onChange={(e) => setField("barcodeType", e.target.value as CreateSkuFields["barcodeType"])} className={`mt-1 ${field}`} disabled={busy}><option value="INTERNAL">Internal</option><option value="EAN">EAN-13</option><option value="SUPPLIER">Supplier</option></select></label>
      <label className="block text-[8px] font-semibold text-[#35443f]">Barcode Supplier<select required={form.barcodeType === "SUPPLIER"} value={form.barcodeSupplierId} onChange={(e) => setField("barcodeSupplierId", e.target.value)} className={`mt-1 ${field}`} disabled={busy || form.barcodeType !== "SUPPLIER"}><option value="">Select supplier</option>{options.suppliers.map((s) => <option value={s.id} key={s.id}>{s.name}</option>)}</select></label></div>
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-[9px] text-red-800">{error}</p>}{success && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[9px] text-emerald-800">{success}</p>}
    <button disabled={busy} className="w-full rounded border border-[#24564e] bg-white px-3 py-2 text-[10px] font-bold text-[#24564e] hover:bg-[#e8f0eb] disabled:opacity-50">{busy ? "Saving product master…" : "Create/Activate SKU"}</button>
  </form>;
}

function prettyHistoryTime(value?: string) {
  if (!value) return "Time unknown";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
function historyJson(value: unknown) {
  if (value === undefined || value === null || value === "") return "—";
  try { return typeof value === "string" ? value : JSON.stringify(value); }
  catch { return String(value); }
}
function DrawerTimeline({ job, state }: { job: Job; state: HistoryState | null }) {
  const targetId = job.receiptId ?? job.id;
  if (!state || state.receiptId !== targetId || state.loading) return <p className="rounded border border-border bg-white p-3 text-[10px] text-muted-foreground">Loading event history from Supabase…</p>;
  if (state.error) return <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-[10px] text-red-800">Timeline read failed: {state.error}</p>;
  if (!state.events.length) return <DrawerEmpty title="No stored activity events" text="The database returned an empty timeline for this receipt. No sample events are fabricated." />;
  return <>{!job.receiptId && <p className="mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-[10px] text-amber-900">No linked receipt exists for this legacy job. Showing the job-level trace returned by the database; receipt-only events may be unavailable.</p>}<DSection label={`Chronological trace · ${state.events.length} events`}><div className="relative ml-2 border-l border-[#bdd0c8] pl-4">{state.events.map((event, i) => <div key={event.eventId ?? event.id ?? `${event.entityId}-${event.createdAt}-${i}`} className="relative pb-4"><span className={`absolute -left-[21px] top-1 h-2 w-2 rounded-full border-2 border-white ${i === 0 ? "bg-[#24564e]" : "bg-[#7aaa99]"}`} /><div className="flex items-start justify-between gap-2"><p className="text-[11px] font-semibold text-[#2a3530]">{event.eventType ?? "Operational event"}</p><span className="flex-shrink-0 font-mono text-[9px] text-muted-foreground">{prettyHistoryTime(event.createdAt)}</span></div><p className="mt-0.5 text-[10px] text-muted-foreground">{event.actor ?? event.actorRole ?? event.actorId ?? "Actor not resolved"} · {event.entityType ?? "entity"}{event.reason ? ` · ${event.reason}` : ""}</p></div>)}</div></DSection></>;
}
function DrawerAudit({ job, state }: { job: Job; state: HistoryState | null }) {
  const targetId = job.receiptId ?? job.id;
  if (!state || state.receiptId !== targetId || state.loading) return <p className="rounded border border-border bg-white p-3 text-[10px] text-muted-foreground">Loading audit records from Supabase…</p>;
  if (state.error) return <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-[10px] text-red-800">Audit read failed: {state.error}</p>;
  if (!state.events.length) return <DrawerEmpty title="No stored audit events" text="The database returned no audit events for this receipt. No synthetic change history is displayed." />;
  return <>{!job.receiptId && <p className="mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-[10px] text-amber-900">This legacy job has no linked receipt. Audit records below come from the permission-checked job trace and may not include receipt-only records.</p>}<div className="mb-3 rounded border border-[#c8ddd5] bg-[#edf5f0] p-2.5 text-[10px] leading-snug text-[#2a6457]">These records are read from `audit.audit_events` through permission-checked Supabase RPCs. The UI does not manufacture before/after values.</div><div className="overflow-hidden rounded border border-border"><div className="grid grid-cols-[1fr_auto] border-b border-border bg-[#f3f5f2] px-2 py-1.5 font-mono text-[9px] uppercase text-muted-foreground"><span>Event / Actor</span><span>Time</span></div>{state.events.map((event, i) => <div key={event.eventId ?? event.id ?? `${event.entityId}-${event.createdAt}-${i}`} className="border-b border-border px-2 py-2.5 last:border-0"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-mono text-[10px] font-semibold text-[#2d665d]">{event.eventType ?? "Event"}</p><p className="mt-0.5 text-[9px] text-muted-foreground">{event.actor ?? event.actorRole ?? event.actorId ?? "Actor not resolved"} · {event.entityType ?? "entity"} · {event.entityId ?? "—"}</p></div><span className="flex-shrink-0 font-mono text-[9px] text-muted-foreground">{prettyHistoryTime(event.createdAt)}</span></div>{event.reason && <p className="mt-1 text-[10px] text-[#3a4540]">Reason: {event.reason}</p>}<div className="mt-1 grid grid-cols-1 gap-1"><p className="break-all text-[9px] text-muted-foreground">Before: {historyJson(event.beforeData ?? event.before)}</p><p className="break-all text-[9px] text-muted-foreground">After: {historyJson(event.afterData ?? event.after)}</p></div></div>)}</div></>;
}

function DrawerRelationships({ job, putawayTasks, lines }: { job: Job; putawayTasks: PutawayTask[]; lines: LiveLine[] | null }) {
  const jobTasks = putawayTasks.filter((task) => task.jobId === job.id);
  const qcRecorded = lines?.filter((line) => line.qcChecked).length ?? 0;
  const lineCount = lines?.length;
  const completedTasks = jobTasks.filter((task) => task.status === "completed").length;
  const objects = [
    { type: "Job", value: job.jobNumber ?? job.id, desc: "Inbound job from the live dashboard", available: true },
    { type: "Receipt", value: job.receiptId ? job.receipt : "No linked receipt", desc: job.receiptId ? `Receipt UUID ${job.receiptId}` : "Receipt relationship is missing in the database", available: !!job.receiptId },
    { type: "Receipt Lines", value: lineCount === undefined ? "Not loaded" : `${lineCount} database line(s)`, desc: lineCount === undefined ? "Open this tab again after receipt details load" : `${qcRecorded} line(s) have stored QC decisions`, available: lineCount !== undefined },
    { type: "Supplier", value: job.supplier, desc: "Supplier label returned by the inbound dashboard RPC", available: job.supplier !== "Unknown supplier" },
    { type: "Purchase Order", value: job.po || "No PO", desc: "A manual receipt may legitimately have no PO", available: job.po !== "No PO" },
    { type: "QC", value: job.status === "qc_in_progress" ? "QC in progress" : job.damage > 0 ? `${job.damage} damage unit(s) reported` : "No active QC status", desc: "Detailed decisions are shown per receipt line", available: !!job.receiptId },
    { type: "Putaway Tasks", value: `${jobTasks.length} database task(s)`, desc: `${completedTasks} completed · ${jobTasks.length - completedTasks} remaining`, available: jobTasks.length > 0 },
    { type: "Inventory", value: completedTasks > 0 ? "Some Putaway tasks completed" : "No completed Putaway task", desc: "Inspect stock/ledger in the database for final posting state", available: completedTasks > 0 },
  ];
  return (
    <>
      {jobTasks.length > 0 && <DSection label="Putaway context"><div className="mb-1.5 flex items-center justify-between text-[10px]"><span className="text-muted-foreground">{jobTasks.length} task(s) · {jobTasks.filter((task) => task.status === "in_progress").length} active</span><span className={`font-mono font-semibold ${job.ageMinutes > 240 ? "text-amber-700" : "text-emerald-700"}`}>{job.ageMinutes > 240 ? "Idle >4h" : "Recent update"}</span></div><div className="overflow-hidden rounded border border-border"><div className="grid grid-cols-[auto_1fr_auto_auto] border-b border-border bg-[#f3f5f2] px-2 py-1.5 font-mono text-[8px] uppercase tracking-[0.07em] text-muted-foreground"><span className="pr-2">Bin</span><span>SKU</span><span className="px-2 text-right">Qty</span><span className="pl-2">State</span></div>{jobTasks.map((task) => <div key={task.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center border-b border-border px-2 py-2 last:border-0 hover:bg-[#f7f9f6]"><span className="pr-2 font-mono text-[9px] font-bold text-[#1c5047]">{task.actualBin !== "—" ? task.actualBin : task.suggestedBin}</span><span className="font-mono text-[9px] text-[#5a6660]">{task.sku}</span><span className="px-2 text-right font-mono text-[10px] text-[#4a5550]">{task.qty}</span><span className={`pl-2 font-mono text-[9px] font-semibold ${task.status === "in_progress" ? "text-indigo-700" : task.status === "completed" ? "text-emerald-700" : "text-orange-700"}`}>{task.status === "in_progress" ? "Active" : task.status === "completed" ? "Done" : task.status}</span></div>)}</div></DSection>}
      <DSection label="Linked operational objects"><div className="space-y-1.5">{objects.map((obj) => <div key={obj.type} className={`flex items-center justify-between rounded border p-2.5 ${obj.available ? "border-border bg-white" : "border-[#eaeee9] bg-[#f8f9f7] opacity-80"}`}><div><p className="font-mono text-[9px] uppercase tracking-[0.07em] text-muted-foreground">{obj.type}</p><p className="mt-0.5 break-all text-[12px] font-semibold text-[#2a3530]">{obj.value}</p><p className="text-[10px] text-muted-foreground">{obj.desc}</p></div><span className={`text-[13px] ${obj.available ? "text-[#2f6d61]" : "text-[#c0c9c4]"}`}>{obj.available ? "✓" : "—"}</span></div>)}</div></DSection>
    </>
  );
}

function DrawerMetrics({ job }: { job: Job }) {
  const rcvPct = job.expected ? Math.min(100, Math.round((job.received / job.expected) * 100)) : 0;
  const vPct = variancePct(job);
  const isAging = job.ageMinutes > 240;
  return (
    <>
      <DSection label="Quantity integrity">
        <div className="rounded border border-border p-3">
          <div className="flex justify-between text-[12px] mb-2"><span className="text-muted-foreground">Received vs expected</span><span className="font-mono font-semibold">{rcvPct}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[#e4ebe7]"><div className="h-full rounded-full bg-[#3e8a74]" style={{ width: `${rcvPct}%` }} /></div>
          <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
            <span>Variance: {Math.abs(vPct).toFixed(1)}%</span>
            <span className={Math.abs(vPct) > 1 ? "text-amber-700 font-semibold" : "text-emerald-700"}>{Math.abs(vPct) > 1 ? "Above threshold" : "Within threshold"} (app review rule ±1.0%; not configured in DB)</span>
          </div>
        </div>
      </DSection>
      <DSection label="Time health">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-border p-3">
            <p className="text-[10px] text-muted-foreground">Idle since update</p>
            <p className={`mt-1 font-mono text-[16px] font-semibold ${isAging ? "text-amber-700" : "text-[#1b2e28]"}`}>{job.age}</p>
            <p className={`mt-0.5 text-[10px] ${isAging ? "text-amber-700" : "text-muted-foreground"}`}>{isAging ? "⚑ Idle >4h" : "Recent update"}</p>
          </div>
          <div className="rounded border border-border p-3">
            <p className="text-[10px] text-muted-foreground">Inactivity condition</p>
            <p className={`mt-1 text-[13px] font-bold ${isAging ? "text-amber-700" : "text-emerald-700"}`}>{isAging ? "Aging >4h" : "Idle ≤4h"}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">App attention threshold: 4h (not an SLA)</p>
          </div>
        </div>
      </DSection>
      <DSection label="QC summary">
        <div className="rounded border border-border p-3">
          {job.damage > 0 ? (
            <>
              <div className="flex justify-between text-[12px] mb-1"><span className="text-muted-foreground">Damage units</span><span className="font-mono font-semibold text-rose-700">{job.damage}</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[#e4ebe7]"><div className="h-full rounded-full bg-rose-500" style={{ width: `${Math.min(100, (job.damage / job.received) * 100 * 10)}%` }} /></div>
              <p className="mt-1.5 text-[10px] text-muted-foreground">{((job.damage / job.received) * 100).toFixed(2)}% damage rate · pending sign-off</p>
            </>
          ) : <p className="text-[12px] font-semibold text-emerald-700">No QC damage recorded</p>}
        </div>
      </DSection>
    </>
  );
}

function DrawerNotes({ job }: { job: Job }) {
  const [notes, setNotes] = useState<{ id: string; receiptId?: string; note: string; createdAt: string; actor: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (!job.receiptId) { setNotes([]); setLoading(false); return; }
    setLoading(true); setError("");
    try { setNotes(await getReceiptNotes(job.receiptId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [job.receiptId]);
  useEffect(() => { void load(); }, [load]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setNotice("");
    const value = draft.trim();
    if (!job.receiptId) return setError("This job has no linked receipt. A note cannot be saved without a receipt ID.");
    if (!value || value.length > 4000) return setError("The note must contain between 1 and 4000 characters.");
    setSaving(true);
    try {
      await addReceiptNote(job.receiptId, value, newIdempotencyKey("add-receipt-note"));
      setDraft(""); await load();
      setNotice("Note saved to the database and recorded in audit history.");
    } catch (e2) { setError(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setSaving(false); }
  };
  return <div className="space-y-3">
    {!job.receiptId && <DrawerEmpty title="No linked receipt" text="This legacy job has no linked receipt, so a receipt note cannot be attached safely." />}
    {job.receiptId && <form onSubmit={(e) => { void submit(e); }} className="space-y-2 rounded border border-[#c8ddd5] bg-[#edf5f0] p-3">
      <div><p className="text-[11px] font-bold text-[#214f44]">Add receipt note</p><p className="text-[9px] text-[#527067]">Saved through a permission-checked RPC and included in the audit trail.</p></div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} rows={3} placeholder="Record a receiving observation, variance context, or handoff note…" disabled={saving} className="w-full resize-y rounded border border-border bg-white p-2 text-[11px] outline-none focus:border-[#24564e] disabled:opacity-60" />
      <div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-muted-foreground">{draft.length}/4000</span><button disabled={saving || !draft.trim()} className="rounded border border-[#24564e] bg-[#24564e] px-3 py-1.5 text-[10px] font-bold text-white disabled:opacity-50">{saving ? "Saving…" : "Save note"}</button></div>
    </form>}
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2.5 text-[10px] text-red-800">Notes error: {error}</p>}
    {notice && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 p-2.5 text-[10px] text-emerald-800">{notice}</p>}
    {loading ? <p className="rounded border border-border bg-white p-3 text-[10px] text-muted-foreground">Loading stored notes…</p>
      : notes.length === 0 ? <DrawerEmpty title="No stored notes" text="The notes RPC returned no saved notes for this receipt yet." />
      : <div className="space-y-2">{notes.map((n) => <article key={n.id} className="rounded border border-border bg-white p-3"><div className="flex items-start justify-between gap-2"><span className="font-mono text-[9px] font-semibold text-[#2d665d]">{n.actor || "Unknown actor"}</span><time className="flex-shrink-0 text-[9px] text-muted-foreground">{n.createdAt && !Number.isNaN(Date.parse(n.createdAt)) ? new Date(n.createdAt).toLocaleString() : "Time unavailable"}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[#2a3530]">{n.note}</p></article>)}</div>}
  </div>;
}

function DrawerDocuments({ job }: { job: Job }) {
  const [documents, setDocuments] = useState<{ id: string; objectPath: string; fileName: string; contentType: string; sizeBytes: number; note?: string | null; createdAt: string; uploadedBy: string }[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (!job.receiptId) { setDocuments([]); setLoading(false); return; }
    setLoading(true); setError("");
    try { setDocuments(await getReceiptDocuments(job.receiptId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [job.receiptId]);
  useEffect(() => { void load(); }, [load]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setNotice("");
    if (!job.receiptId) return setError("This job has no linked receipt.");
    if (!file) return setError("Choose a PDF or supported image first.");
    if (file.size > 10 * 1024 * 1024) return setError("The maximum document size is 10 MB.");
    setBusy(true);
    try {
      await uploadReceiptDocument(job.receiptId, file, note, newIdempotencyKey("receipt-document"));
      setFile(null); setNote("");
      const input = document.getElementById("mita-receipt-document-file") as HTMLInputElement | null;
      if (input) input.value = "";
      await load(); setNotice("Document uploaded to private storage, registered against the receipt, and audited.");
    } catch (e2) { setError(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  };
  const openDocument = async (doc: (typeof documents)[number]) => {
    setError(""); setNotice(""); setOpeningId(doc.id);
    try {
      const blob = await downloadReceiptDocument(doc.objectPath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = doc.fileName || "receipt-document"; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice("Downloaded "+doc.fileName+".");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setOpeningId(""); }
  };
  const sizeLabel = (n: number) => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024))+" KB" : (n / (1024 * 1024)).toFixed(1)+" MB";
  return <div className="space-y-3">
    {!job.receiptId && <DrawerEmpty title="No linked receipt" text="This job has no linked receipt ID. A document cannot be attached safely until the relationship is resolved." />}
    {job.receiptId && <form onSubmit={(e) => { void submit(e); }} className="space-y-2 rounded border border-[#c8ddd5] bg-[#edf5f0] p-3">
      <div><p className="text-[11px] font-bold text-[#214f44]">Upload receipt document</p><p className="text-[9px] text-[#527067]">Private storage · PDF, JPEG, PNG, WebP · max 10 MB.</p></div>
      <input id="mita-receipt-document-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} className="block w-full text-[10px] text-[#35443f] file:mr-2 file:rounded file:border file:border-border file:bg-white file:px-2 file:py-1.5 file:text-[10px]" />
      {file && <p className="break-all font-mono text-[9px] text-muted-foreground">{file.name} · {sizeLabel(file.size)}</p>}
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Optional document note" disabled={busy} className="w-full rounded border border-border bg-white px-2 py-1.5 text-[10px] outline-none focus:border-[#24564e] disabled:opacity-60" />
      <div className="flex justify-end"><button disabled={busy || !file} className="rounded border border-[#24564e] bg-[#24564e] px-3 py-1.5 text-[10px] font-bold text-white disabled:opacity-50">{busy ? "Uploading / registering…" : "Upload document"}</button></div>
    </form>}
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2.5 text-[10px] text-red-800">Documents error: {error}</p>}
    {notice && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 p-2.5 text-[10px] text-emerald-800">{notice}</p>}
    {loading ? <p className="rounded border border-border bg-white p-3 text-[10px] text-muted-foreground">Loading registered documents…</p>
      : documents.length === 0 ? <DrawerEmpty title="No linked documents" text="The documents RPC returned no registered files for this receipt yet." />
      : <div className="space-y-2">{documents.map((doc) => <article key={doc.id} className="flex items-start gap-3 rounded border border-border bg-white p-3"><div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded border border-border bg-[#f4f6f3] font-mono text-[9px] font-bold text-[#2d665d]">{doc.contentType === "application/pdf" ? "PDF" : "IMG"}</div><div className="min-w-0 flex-1"><p className="break-all text-[11px] font-semibold text-[#2a3530]">{doc.fileName}</p><p className="mt-0.5 text-[9px] text-muted-foreground">{sizeLabel(doc.sizeBytes)} · {doc.uploadedBy || "Unknown uploader"}</p>{doc.note && <p className="mt-1 break-words text-[10px] text-muted-foreground">{doc.note}</p>}<p className="mt-1 text-[9px] text-muted-foreground">{doc.createdAt && !Number.isNaN(Date.parse(doc.createdAt)) ? new Date(doc.createdAt).toLocaleString() : "Time unavailable"}</p><button type="button" onClick={() => { void openDocument(doc); }} disabled={!!openingId} className="mt-2 rounded border border-border bg-white px-2.5 py-1 text-[10px] font-semibold text-[#24564e] hover:bg-[#f2f5f2] disabled:opacity-50">{openingId === doc.id ? "Preparing download…" : "Download file"}</button></div></article>)}</div>}
  </div>;
}

function DrawerEmpty({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded border border-dashed border-border p-8 text-center">
      <p className="text-[13px] font-bold text-[#2a3530]">{title}</p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{text}</p>
    </div>
  );
}