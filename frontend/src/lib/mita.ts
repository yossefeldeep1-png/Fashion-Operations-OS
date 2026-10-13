import { supabase } from "./supabase";

export type LiveStatus =
  | "waiting_truck" | "truck_registered" | "receiving" | "identifying" | "counting" | "qc_in_progress"
  | "confirmed" | "putaway_pending" | "putaway_in_progress" | "completed" | "validation_failed" | "cancelled";

export type LiveJob = {
  id: string; // stable inbound_jobs.id (UUID)
  jobNumber: string;
  receiptId: string | null;
  receipt: string;
  supplier: string;
  po: string;
  warehouse: string;
  status: LiveStatus;
  expected: number;
  received: number;
  damage: number;
  ageMinutes: number;
  age: string;
  owner: string;
  updated: string;
  createdAt?: string;
  issue?: "Validation" | "QC" | "Variance" | "Aging" | "Blocked" | "Cancelled";
  dock?: string;
};

export type LiveLine = {
  id?: string;
  skuId?: string;
  sku: string;
  description: string;
  uom: string;
  expected: number;
  received: number;
  barcode?: string | null;
  qcChecked: boolean;
  qcPass: number;
  qcFail: number;
  status: "ok" | "variance";
};

export type LivePutawayTask = {
  id: string;
  jobId: string;
  jobNumber: string;
  receiptId: string | null;
  receipt: string;
  skuId: string;
  sku: string;
  description: string;
  qty: number;
  suggestedBinId: string | null;
  suggestedBin: string;
  actualBinId: string | null;
  actualBin: string;
  worker: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  priority: "normal" | "high" | "urgent";
  ageMinutes: number;
  warehouse: string;
};

export type OperationalReadiness = {
  activeSuppliers: number;
  activeWarehouses: number;
  openPurchaseOrders: number;
  activeSkus: number;
  draftSkus: number;
  inconsistentSkuHierarchy: number;
  overCapacityBins: number;
  stockLedgerVariances: number;
  unlinkedJobs: number;
  completedReceiptsWithUnfinishedLines: number;
  openQcLines: number;
  auditEvents: number;
  lastAuditEventAt?: string | null;
};

export type InboundOptions = {
  suppliers: { id: string; code: string; name: string }[];
  warehouses: { id: string; code: string; name: string }[];
  purchaseOrders: { id: string; poNumber: string; supplierId: string; supplier: string; status: string; expectedDate?: string | null }[];
  skus: { id: string; skuCode: string; status: string; barcodes: { id: string; value: string; type: string; primary: boolean; status?: string }[] }[];
  bins: { id: string; code: string; warehouseId: string; status: string; capacity: number; onHand: number; availableCapacity: number; utilizationPct: number; overCapacity: boolean }[];
};

const STATUSES = new Set<LiveStatus>([
  "waiting_truck", "truck_registered", "receiving", "identifying", "counting", "qc_in_progress",
  "confirmed", "putaway_pending", "putaway_in_progress", "completed", "validation_failed", "cancelled",
]);
const ISSUES = new Set(["Validation", "QC", "Variance", "Aging", "Blocked", "Cancelled"]);

export class ShapeError extends Error {
  constructor(message: string, public detail: string) { super(message); }
}

export async function rpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}${error.code ? ` (${error.code})` : ""}`);
  return data;
}

async function rpcTry(name: string, candidates: Record<string, unknown>[]): Promise<unknown> {
  let last: unknown;
  for (const args of candidates) {
    const { data, error } = await supabase.rpc(name, args);
    if (!error) return data;
    last = error;
    if (error.code !== "PGRST202" && error.code !== "PGRST203") break;
  }
  const e = last as { message?: string; code?: string } | undefined;
  throw new Error(`${name}: ${e?.message ?? "RPC call failed"}${e?.code ? ` (${e.code})` : ""}`);
}

const newIdempotencyKey = (action: string) => {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `mita-ui:${action}:${id}`;
};

export { newIdempotencyKey };
export const getMyAccess = () => rpc("mita_get_my_access");
export const getInboundDashboard = (limit = 100) => rpcTry("mita_get_inbound_dashboard", [{ p_limit: limit }]);
export const getOperationalReadiness = () => rpc("mita_get_operational_readiness");
export const getReceiptDetail = (receiptId: string) => rpcTry("mita_get_receipt_detail", [{ p_receipt_id: receiptId }]);
export const getInboundOptions = (warehouseId?: string | null) => rpcTry("mita_get_inbound_options", [{ p_warehouse_id: warehouseId ?? null }]);
export const getPutawayTasks = (limit = 200, status: string | null = null) => rpcTry("mita_get_putaway_tasks", [{ p_limit: limit, p_status: status }]);
export const getReceiptActivity = (receiptId: string) => rpcTry("mita_get_receipt_activity", [{ p_receipt_id: receiptId }]);
export const getInboundJobTrace = (jobId: string) => rpcTry("mita_get_inbound_job_trace", [{ p_job_id: jobId }]);
export const getReceiptAudit = (receiptId: string, limit = 100) => rpcTry("mita_get_receipt_audit", [{ p_receipt_id: receiptId, p_limit: limit }]);
export const startReceiving = (receiptId: string) => rpcTry("mita_start_receiving", [{ p_receipt_id: receiptId }]);
export const startPutaway = (taskId: string) => rpcTry("mita_start_putaway", [{ p_task_id: taskId }]);
export const scanPutawayBin = (taskId: string, binId: string) => rpcTry("mita_scan_putaway_bin", [{ p_task_id: taskId, p_bin_id: binId }]);
export const completePutaway = (taskId: string, idempotencyKey = newIdempotencyKey("complete-putaway")) =>
  rpcTry("mita_complete_putaway", [{ p_task_id: taskId, p_idempotency_key: idempotencyKey }]);

export const confirmReceipt = (receiptId: string, receivingBinId: string, idempotencyKey = newIdempotencyKey("confirm-receipt")) =>
  rpcTry("mita_confirm_receipt", [{ p_receipt_id: receiptId, p_receiving_bin_id: receivingBinId, p_idempotency_key: idempotencyKey }]);

export type RecordQCInput = {
  receiptLineId: string; qtyPass: number; qtyFail: number; failReason?: string | null; evidencePaths?: string[]; idempotencyKey?: string;
};
export const recordQC = (input: RecordQCInput) => rpcTry("mita_record_qc", [{
  p_receipt_line_id: input.receiptLineId,
  p_qty_pass: input.qtyPass,
  p_qty_fail: input.qtyFail,
  p_fail_reason: input.failReason ?? null,
  p_evidence_paths: input.evidencePaths ?? [],
  p_idempotency_key: input.idempotencyKey ?? newIdempotencyKey("record-qc"),
}]);

export async function uploadQcEvidence(receiptId: string, receiptLineId: string, file: File): Promise<string> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error("Sign in is required before uploading QC evidence.");
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const ext = extensions[file.type];
  if (!ext) throw new Error("QC evidence must be a JPEG, PNG, or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("QC evidence image exceeds the 5 MB limit.");
  const nonce = newIdempotencyKey("qc-evidence").replace(/[^a-zA-Z0-9-]/g, "-");
  const objectPath = `${user.id}/${receiptId}/${receiptLineId}/${nonce}.${ext}`;
  const { error } = await supabase.storage.from("mita-qc-evidence").upload(objectPath, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(`QC evidence upload failed: ${error.message}`);
  return objectPath;
}

export async function removeQcEvidence(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { error } = await supabase.storage.from("mita-qc-evidence").remove(paths);
  if (error) throw new Error(`Could not clean up temporary QC evidence: ${error.message}`);
}

export const createReceipt = (payload: Record<string, unknown>, idempotencyKey = newIdempotencyKey("create-receipt")) =>
  rpcTry("mita_create_receipt", [{ p_payload: payload, p_idempotency_key: idempotencyKey }]);

export const createProductSku = (payload: Record<string, unknown>, idempotencyKey = newIdempotencyKey("create-product-sku")) =>
  rpcTry("mita_create_product_sku", [{ p_payload: payload, p_idempotency_key: idempotencyKey }]);

export type AddReceiptLineInput = {
  receiptId: string;
  skuId: string;
  expectedQty: number;
  actualQty: number;
  barcodeValue?: string | null;
  manualReason?: string | null;
  shortageReason?: string | null;
  idempotencyKey?: string;
};

export const addReceiptLine = (input: AddReceiptLineInput) => {
  const idempotencyKey = input.idempotencyKey ?? newIdempotencyKey("add-receipt-line");
  return rpcTry("mita_add_receipt_line", [{
    p_receipt_id: input.receiptId, p_sku_id: input.skuId, p_expected_qty: input.expectedQty,
    p_actual_qty: input.actualQty, p_barcode_value: input.barcodeValue ?? null,
    p_manual_reason: input.manualReason ?? null, p_shortage_reason: input.shortageReason ?? null,
    p_idempotency_key: idempotencyKey,
  }, {
    p_receipt_id: input.receiptId, p_sku_id: input.skuId, p_expected_qty: input.expectedQty,
    p_actual_qty: input.actualQty, p_barcode_value: input.barcodeValue ?? null,
    p_manual_reason: input.manualReason ?? null, p_idempotency_key: idempotencyKey,
  }]);
};

type ReceiptNote = { id: string; receiptId: string; note: string; createdAt: string; actor: string };
type ReceiptDocument = { id: string; receiptId: string; objectPath: string; fileName: string; contentType: string; sizeBytes: number; note?: string | null; createdAt: string; uploadedBy: string };
function objectRows<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") { const v = (raw as Record<string, unknown>)[key]; if (Array.isArray(v)) return v as T[]; }
  return [];
}
export async function getReceiptNotes(receiptId: string, limit = 100): Promise<ReceiptNote[]> {
  return objectRows<ReceiptNote>(await rpcTry("mita_get_receipt_notes", [{ p_receipt_id: receiptId, p_limit: limit }]), "notes");
}
export const addReceiptNote = (receiptId: string, note: string, idempotencyKey = newIdempotencyKey("add-receipt-note")) =>
  rpcTry("mita_add_receipt_note", [{ p_receipt_id: receiptId, p_note: note, p_idempotency_key: idempotencyKey }]);
export async function getReceiptDocuments(receiptId: string, limit = 100): Promise<ReceiptDocument[]> {
  return objectRows<ReceiptDocument>(await rpcTry("mita_get_receipt_documents", [{ p_receipt_id: receiptId, p_limit: limit }]), "documents");
}
const DOCUMENT_TYPES: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
function safeFilePart(value: string): string { return value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "document"; }
export async function uploadReceiptDocument(receiptId: string, file: File, note = "", idempotencyKey = newIdempotencyKey("receipt-document")): Promise<ReceiptDocument> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error("Authentication check failed: " + userError.message);
  if (!user) throw new Error("Sign in is required before uploading a receipt document.");
  const ext = DOCUMENT_TYPES[file.type];
  if (!ext) throw new Error("Documents must be PDF, JPEG, PNG, or WebP.");
  if (file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error("The document must be smaller than 10 MB.");
  const filename = String(Date.now()) + "-" + safeFilePart(file.name.replace(/\.[^.]+$/, "")) + "." + ext;
  const objectPath = receiptId + "/" + user.id + "/" + filename;
  const { error: uploadError } = await supabase.storage.from("mita-receipt-documents").upload(objectPath, file, { contentType: file.type, upsert: false });
  if (uploadError) throw new Error("Document upload failed: " + uploadError.message);
  try {
    const raw = await rpcTry("mita_register_receipt_document", [{
      p_receipt_id: receiptId, p_object_path: objectPath, p_file_name: file.name.slice(0, 255),
      p_content_type: file.type, p_size_bytes: file.size, p_note: note.trim() || null,
      p_idempotency_key: idempotencyKey,
    }]);
    return raw as ReceiptDocument;
  } catch (error) {
    try {
      const match = (await getReceiptDocuments(receiptId)).find((doc) => doc.objectPath === objectPath);
      if (match) return match;
      await supabase.storage.from("mita-receipt-documents").remove([objectPath]);
    } catch { /* keep the object if commit status cannot be established */ }
    throw error;
  }
}
export async function downloadReceiptDocument(objectPath: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from("mita-receipt-documents").download(objectPath);
  if (error) throw new Error("Document download failed: " + error.message);
  if (!data) throw new Error("The private document store returned no file data.");
  return data;
}

export async function getInboundOptionsTyped(warehouseId?: string | null): Promise<InboundOptions> {
  const raw = await getInboundOptions(warehouseId);
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = <T,>(v: unknown): T[] => Array.isArray(v) ? v as T[] : [];
  return {
    suppliers: list(o.suppliers),
    warehouses: list(o.warehouses),
    purchaseOrders: list(o.purchaseOrders),
    skus: list(o.skus),
    bins: list(o.bins),
  };
}

export function hasAccess(raw: unknown): boolean {
  if (raw == null || raw === false) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if ("active" in o && o.active !== true) return false;
    if ("authenticated" in o && o.authenticated !== true) return false;
    if ("canReadInbound" in o) return o.canReadInbound === true;
    for (const k of ["allowed", "has_access", "can_read", "can_view", "can_view_inbound"]) if (k in o) return o[k] === true;
    return Object.keys(o).length > 0;
  }
  return raw === true;
}

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const numeric = (v: unknown, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback);
const fmtAge = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`);

function findRows(raw: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return null;
}
const keysOf = (v: unknown) => (v && typeof v === "object" ? Object.keys(v as object).join(", ") || "(empty object)" : typeof v);

export function mapDashboard(raw: unknown): LiveJob[] {
  const rows = findRows(raw, ["jobs", "receipts", "rows", "items", "data"]);
  if (!rows) throw new ShapeError("Dashboard response is not a list of inbound jobs", `Top-level keys: ${keysOf(raw)}`);
  return rows.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = pick(o, "id", "job_id", "jobId");
    const jobNumber = pick(o, "jobNumber", "job_number", "job_number_display");
    const receiptIdRaw = pick(o, "receiptId", "receipt_id");
    const receipt = pick(o, "receipt", "receipt_number", "receipt_no");
    const supplier = pick(o, "supplier", "supplier_name");
    const po = pick(o, "po", "po_number");
    const warehouse = pick(o, "warehouse", "warehouse_code");
    const statusRaw = pick(o, "status");
    const expected = pick(o, "expected", "expected_qty", "expected_units");
    const received = pick(o, "received", "received_qty", "received_units");
    const damage = pick(o, "damage", "damage_qty");
    const ageMinutes = pick(o, "age_minutes", "ageMinutes");
    const owner = pick(o, "owner", "owner_name", "assigned_to");
    const updated = pick(o, "updated", "updated_at", "updatedAt");
    const createdAt = pick(o, "createdAt", "created_at");
    if (typeof id !== "string" || typeof statusRaw !== "string") {
      throw new ShapeError("Dashboard row is missing its stable ID or status", `Row ${i} keys: ${keysOf(o)}`);
    }
    const status = statusRaw.toLowerCase() === "draft" ? "waiting_truck" : statusRaw.toLowerCase();
    if (!STATUSES.has(status)) throw new ShapeError("Unknown inbound job status", `Row ${i}: ${statusRaw}`);
    const min = Math.max(0, numeric(ageMinutes));
    const updatedText = typeof updated === "string" ? updated : (typeof createdAt === "string" ? createdAt : "—");
    const jobNo = typeof jobNumber === "string" && jobNumber ? jobNumber : id;
    const rawIssue = pick(o, "issue");
    const explicitIssue = typeof rawIssue === "string" && ISSUES.has(rawIssue) ? rawIssue as LiveJob["issue"] : undefined;
    const isTerminal = status === "completed" || status === "cancelled";
    const receivedQty = numeric(received);
    const expectedQty = numeric(expected);
    const damageQty = numeric(damage);
    const ownerText = typeof owner === "string" ? owner : "Unassigned";
    const derivedIssue: LiveJob["issue"] = explicitIssue
      ?? (status === "validation_failed" ? "Validation"
      : status === "qc_in_progress" && damageQty > 0 ? "QC"
      : !isTerminal && status === "receiving" && ownerText === "Unassigned" ? "Blocked"
      : !isTerminal && expectedQty > 0 && receivedQty > 0 && Math.abs((receivedQty - expectedQty) / expectedQty * 100) > 1 ? "Variance"
      : !isTerminal && ["confirmed", "putaway_pending", "putaway_in_progress"].includes(status) && min > 240 ? "Aging"
      : undefined);
    return {
      id,
      jobNumber: jobNo,
      receiptId: typeof receiptIdRaw === "string" ? receiptIdRaw : null,
      receipt: typeof receipt === "string" && receipt ? receipt : "No receipt linked",
      supplier: typeof supplier === "string" && supplier ? supplier : "Unknown supplier",
      po: typeof po === "string" && po ? po : "No PO",
      warehouse: typeof warehouse === "string" && warehouse ? warehouse : "Unknown warehouse",
      status: status as LiveStatus,
      expected: numeric(expected),
      received: numeric(received),
      damage: numeric(damage),
      ageMinutes: min,
      age: fmtAge(min),
      owner: typeof owner === "string" && owner ? owner : "Unassigned",
      updated: /^\d{4}-\d\d-\d\dT/.test(updatedText) ? updatedText.slice(11, 16) : updatedText,
      createdAt: typeof createdAt === "string" ? createdAt : undefined,
      issue: derivedIssue,
      dock: typeof pick(o, "dock") === "string" ? String(pick(o, "dock")) : undefined,
    };
  });
}

export function mapReceiptLines(raw: unknown): LiveLine[] | null {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rows = findRows(raw, ["lines", "receipt_lines", "receiptLines", "items"])
    ?? (root.receipt && typeof root.receipt === "object" ? findRows(root.receipt, ["lines", "receipt_lines"]) : null);
  if (!rows) return null;
  return rows.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const sku = pick(o, "sku", "sku_code", "skuCode");
    const skuId = pick(o, "skuId", "sku_id");
    const expected = pick(o, "expected", "expected_qty", "expectedQty");
    const received = pick(o, "received", "received_qty", "actualQty", "actual_qty");
    if (typeof sku !== "string" || expected === undefined || received === undefined) {
      throw new ShapeError("Receipt line does not match the UI contract", `Line ${i} keys: ${keysOf(o)}`);
    }
    const e = numeric(expected), a = numeric(received);
    const qcRaw = pick(o, "qc");
    const qc = qcRaw && typeof qcRaw === "object" ? qcRaw as Record<string, unknown> : null;
    const qcChecked = !!qc && pick(qc, "id", "qcId", "qc_id") !== undefined;
    return {
      id: typeof o.id === "string" ? o.id : undefined,
      skuId: typeof skuId === "string" ? skuId : undefined,
      sku,
      description: String(pick(o, "description", "sku_name", "skuName") ?? sku),
      uom: String(pick(o, "uom", "unitOfMeasure") ?? "—"),
      expected: e,
      received: a,
      barcode: typeof pick(o, "barcode", "barcodeValue", "barcode_value") === "string" ? String(pick(o, "barcode", "barcodeValue", "barcode_value")) : null,
      qcChecked,
      qcPass: numeric(pick(qc ?? {}, "passQty", "qtyPass", "qty_pass")),
      qcFail: numeric(pick(qc ?? {}, "failQty", "qtyFail", "qty_fail")),
      status: e === a ? "ok" : "variance",
    };
  });
}

export function mapPutawayTasks(raw: unknown): LivePutawayTask[] {
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rows = findRows(raw, ["tasks", "rows", "items", "data"]) ?? [];
  return rows.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const statusRaw = String(pick(o, "status") ?? "pending").toLowerCase().replace(/[_\s-]/g, "");
    const status: LivePutawayTask["status"] = statusRaw === "inprogress" ? "in_progress" : statusRaw === "completed" ? "completed" : statusRaw === "blocked" ? "blocked" : "pending";
    const created = pick(o, "createdAt", "created_at");
    const ageMinutes = typeof created === "string" ? Math.max(0, Math.floor((Date.now() - Date.parse(created)) / 60000)) : 0;
    const priorityValue = numeric(pick(o, "priority"), 0);
    return {
      id: String(pick(o, "id") ?? ""),
      jobId: String(pick(o, "jobId", "job_id") ?? ""),
      jobNumber: String(pick(o, "jobNumber", "job_number") ?? pick(o, "jobId", "job_id") ?? "Unknown job"),
      receiptId: typeof pick(o, "receiptId", "receipt_id") === "string" ? String(pick(o, "receiptId", "receipt_id")) : null,
      receipt: String(pick(o, "receipt") ?? "No receipt"),
      skuId: String(pick(o, "skuId", "sku_id") ?? ""),
      sku: String(pick(o, "sku", "skuCode", "sku_code") ?? "Unknown SKU"),
      description: String(pick(o, "description", "skuName") ?? pick(o, "sku", "skuCode", "sku_code") ?? "Unknown SKU"),
      qty: numeric(pick(o, "qty", "quantity")),
      suggestedBinId: typeof pick(o, "suggestedBinId", "suggested_bin_id") === "string" ? String(pick(o, "suggestedBinId", "suggested_bin_id")) : null,
      suggestedBin: String(pick(o, "suggestedBin", "suggested_bin") ?? "—"),
      actualBinId: typeof pick(o, "actualBinId", "actual_bin_id") === "string" ? String(pick(o, "actualBinId", "actual_bin_id")) : null,
      actualBin: String(pick(o, "actualBin", "actual_bin") ?? "—"),
      worker: String(pick(o, "assignedTo", "assigned_to", "worker") ?? "Unassigned"),
      status,
      priority: priorityValue >= 2 ? "urgent" : priorityValue === 1 ? "high" : "normal",
      ageMinutes,
      warehouse: String(pick(o, "warehouse", "warehouse_code") ?? "—"),
    };
  });
}