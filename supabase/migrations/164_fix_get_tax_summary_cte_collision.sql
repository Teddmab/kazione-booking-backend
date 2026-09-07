-- get_tax_summary (redefined in 096) names its own CTE "expenses", which
-- shadows the real expenses table for every later CTE in the same WITH
-- clause — expense_breakdown's "FROM expenses e" was binding to the
-- one-column CTE instead of the table, failing with "column e.date does
-- not exist" any time this function actually ran. Renaming the CTE is the
-- only change; the query logic is otherwise identical to 096's version.
CREATE OR REPLACE FUNCTION get_tax_summary(p_business_id uuid, p_year int, p_quarter int DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start  date;
  v_end    date;
  v_result jsonb;
BEGIN
  IF p_quarter IS NOT NULL THEN
    v_start := make_date(p_year, (p_quarter - 1) * 3 + 1, 1);
    v_end   := (v_start + interval '3 months' - interval '1 day')::date;
  ELSE
    v_start := make_date(p_year, 1, 1);
    v_end   := make_date(p_year, 12, 31);
  END IF;

  WITH income AS (
    SELECT COALESCE(SUM(p.amount), 0)     AS gross,
           COALESCE(SUM(p.tax_amount), 0) AS tax_collected
      FROM payments p
     WHERE p.business_id = p_business_id
       AND p.status = 'paid'
       AND p.is_test = false
       AND p.paid_at::date BETWEEN v_start AND v_end
  ),
  expense_totals AS (
    SELECT COALESCE(SUM(e.amount), 0) AS total
      FROM expenses e
     WHERE e.business_id = p_business_id
       AND e.date BETWEEN v_start AND v_end
  ),
  period_breakdown AS (
    SELECT to_char(date_trunc('month', p.paid_at), 'YYYY-MM') AS period,
           COALESCE(SUM(p.amount), 0)     AS income,
           COALESCE(SUM(p.tax_amount), 0) AS tax
      FROM payments p
     WHERE p.business_id = p_business_id
       AND p.status = 'paid'
       AND p.is_test = false
       AND p.paid_at::date BETWEEN v_start AND v_end
     GROUP BY 1
     ORDER BY 1
  ),
  expense_breakdown AS (
    SELECT to_char(date_trunc('month', e.date), 'YYYY-MM') AS period,
           COALESCE(SUM(e.amount), 0) AS expenses
      FROM expenses e
     WHERE e.business_id = p_business_id
       AND e.date BETWEEN v_start AND v_end
     GROUP BY 1
  )
  SELECT jsonb_build_object(
    'year',           p_year,
    'quarter',        p_quarter,
    'start_date',     v_start,
    'end_date',       v_end,
    'gross_income',   (SELECT gross FROM income),
    'tax_collected',  (SELECT tax_collected FROM income),
    'total_expenses', (SELECT total FROM expense_totals),
    'net_profit',     (SELECT gross FROM income) - (SELECT total FROM expense_totals),
    'period_breakdown', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'period',   pb.period,
         'income',   pb.income,
         'tax',      pb.tax,
         'expenses', COALESCE(eb.expenses, 0),
         'profit',   pb.income - COALESCE(eb.expenses, 0)
       ) ORDER BY pb.period)
         FROM period_breakdown pb
         LEFT JOIN expense_breakdown eb ON eb.period = pb.period
      ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
