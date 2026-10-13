-- This correction has already been applied to the connected Supabase project.
-- The previous body lower()'d the integer first bind (p_limit) in a status filter.
-- Keep this file as a review/history artifact. Do NOT manually re-run against that DB.
CREATE OR REPLACE FUNCTION public.mita_get_putaway_tasks(p_limit integer DEFAULT 200, p_status text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor uuid;
  v_tasks jsonb;
  v_summary jsonb;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
BEGIN
  v_actor := public.mita_require_permission('inbound.read');
  SELECT jsonb_build_object(
    'total', count(*),
    'pending', count(*) FILTER (WHERE lower(t.status) = 'pending'),
    'inProgress', count(*) FILTER (WHERE lower(t.status) = 'inprogress'),
    'completed', count(*) FILTER (WHERE lower(t.status) = 'completed'),
    'blocked', count(*) FILTER (WHERE lower(t.status) = 'blocked')
  ) INTO v_summary
  FROM inbound.putaway_tasks t
  WHERE (p_status IS NULL OR lower(t.status) = lower(p_status));

  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q."createdAt" DESC), '[]'::jsonb)
  INTO v_tasks
  FROM (
    SELECT t.id, t.job_id AS "jobId", j.job_number AS "jobNumber",
      r.id AS "receiptId", r.receipt_number AS receipt, s.name AS supplier,
      sk.id AS "skuId", sk.sku_code AS sku, t.qty, lower(t.status) AS status,
      t.suggested_bin_id AS "suggestedBinId", sb.full_code AS "suggestedBin",
      t.actual_bin_id AS "actualBinId", ab.full_code AS "actualBin",
      t.assigned_to AS "assignedTo", t.lot_id AS "lotId", t.receipt_line_id AS "receiptLineId",
      t.priority, t.created_at AS "createdAt", t.updated_at AS "updatedAt", w.code AS warehouse,
      CASE WHEN sb.id IS NULL THEN false
        WHEN sb.status = 'Blocked' OR sb.is_active IS NOT TRUE THEN false ELSE true END AS "suggestedBinValid"
    FROM inbound.putaway_tasks t
    JOIN inbound.inbound_jobs j ON j.id = t.job_id
    LEFT JOIN inbound.inbound_receipts r ON r.id = j.receipt_id
    LEFT JOIN purchasing.suppliers s ON s.id = COALESCE(r.supplier_id, j.supplier_id)
    JOIN product.skus sk ON sk.id = t.sku_id
    LEFT JOIN location.bins sb ON sb.id = t.suggested_bin_id
    LEFT JOIN location.bins ab ON ab.id = t.actual_bin_id
    LEFT JOIN location.warehouses w ON w.id = COALESCE(r.warehouse_id, j.warehouse_id)
    WHERE (p_status IS NULL OR lower(t.status) = lower(p_status))
    ORDER BY t.created_at DESC LIMIT v_limit
  ) q;
  RETURN jsonb_build_object('generatedAt', now(), 'summary', COALESCE(v_summary, '{}'), 'tasks', COALESCE(v_tasks, '[]'));
END;
$function$;
