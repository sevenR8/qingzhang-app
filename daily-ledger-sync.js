(function attachDailyLedgerSync(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.QingZhangDailyLedgerSync = api;
})(typeof window !== 'undefined' ? window : globalThis, function createDailyLedgerSync() {
  const amount = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const sum = items => (items || []).reduce((total, item) => total + amount(item.amount), 0);

  function dateForMonthDay(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  }

  function expectedPeriod(month, startDay = 5) {
    const [year, monthNumber] = String(month).split('-').map(Number);
    const next = new Date(Date.UTC(year, monthNumber, 1));
    return {
      startsOn: dateForMonthDay(year, monthNumber, startDay),
      endsOn: dateForMonthDay(next.getUTCFullYear(), next.getUTCMonth() + 1, startDay - 1),
    };
  }

  function scheduledDateInPeriod(startsOn, endsOn, scheduledDay, scheduledMonth = null) {
    const [startYear, startMonth] = startsOn.split('-').map(Number);
    const [endYear] = endsOn.split('-').map(Number);
    const day = Number(scheduledDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    if (scheduledMonth !== null && scheduledMonth !== undefined) {
      for (const year of new Set([startYear, endYear])) {
        const candidate = dateForMonthDay(year, Number(scheduledMonth), day);
        if (candidate >= startsOn && candidate <= endsOn) return candidate;
      }
      return null;
    }
    let candidate = dateForMonthDay(startYear, startMonth, day);
    if (candidate < startsOn) {
      const next = new Date(Date.UTC(startYear, startMonth, 1));
      candidate = dateForMonthDay(next.getUTCFullYear(), next.getUTCMonth() + 1, day);
    }
    return candidate <= endsOn ? candidate : null;
  }

  function activeRulesForPeriod(rules, startsOn, endsOn) {
    return (rules || []).filter(rule => {
      const scheduledOn = scheduledDateInPeriod(
        startsOn,
        endsOn,
        rule.scheduled_day,
        rule.recurrence_type === 'yearly' ? rule.scheduled_month : null,
      );
      if (!scheduledOn) return false;
      if (rule.active_from && scheduledOn < rule.active_from) return false;
      if (rule.retired_at && scheduledOn > rule.retired_at) return false;
      return true;
    });
  }

  function summarize({ period, entries = [], otherIncomeEntries = [], advanceRepayments = [], fixedRules = [], current = false }) {
    const nonFixed = entries.filter(entry => !entry.is_fixed);
    const cashSpent = sum(nonFixed.filter(entry => entry.payment_method === 'cash'));
    const creditCardExpenseTotal = sum(nonFixed.filter(entry => entry.payment_method === 'credit_card'));
    const advanceRepaymentTotal = sum(advanceRepayments);
    const applicableRules = current
      ? activeRulesForPeriod(fixedRules, period.starts_on, period.ends_on)
      : [];
    const fixedExpenseTotal = current
      ? sum(applicableRules)
      : sum(entries.filter(entry => entry.is_fixed));
    const salaryAmount = amount(period.salary_amount);
    const otherIncomeTotal = sum(otherIncomeEntries);
    const cardPaymentReady = period.previous_card_bill_amount !== null
      || period.previous_card_bill_zero_confirmed === true;
    return {
      available: true,
      periodStartsOn: period.starts_on,
      periodEndsOn: period.ends_on,
      salaryAmount,
      otherIncomeTotal,
      incomeTotal: salaryAmount + otherIncomeTotal,
      fixedExpenseTotal,
      cashExpenseTotal: Math.max(0, cashSpent - advanceRepaymentTotal),
      creditCardExpenseTotal,
      cardPaymentReady,
      cardPaymentDue: cardPaymentReady ? amount(period.previous_card_bill_amount) : null,
    };
  }

  function localDateISO() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function taipeiPeriodBounds(startsOn, endsOn) {
    const endExclusive = new Date(`${endsOn}T00:00:00Z`);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    return {
      start: `${startsOn}T00:00:00+08:00`,
      endExclusive: `${endExclusive.toISOString().slice(0, 10)}T00:00:00+08:00`,
    };
  }

  async function fetchSummary({ supabase, userId, month, startDay = 5, today = localDateISO() }) {
    if (!supabase || !userId || !month) throw new Error('同步資料不足');
    const ledgerResult = await supabase.from('ledgers')
      .select('id')
      .eq('personal_owner_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (ledgerResult.error) throw ledgerResult.error;
    if (!ledgerResult.data?.id) return { available: false, reason: 'ledger-not-found' };
    const ledgerId = ledgerResult.data.id;
    const expected = expectedPeriod(month, startDay);
    const isCurrent = today >= expected.startsOn && today <= expected.endsOn;
    if (isCurrent) {
      const ensured = await supabase.rpc('ensure_current_accounting_period', { p_ledger_id: ledgerId });
      if (ensured.error) console.warn('Unable to ensure current Daily Ledger period', ensured.error);
    }
    const periodResult = await supabase.from('accounting_periods')
      .select('starts_on,ends_on,salary_amount,previous_card_bill_amount,previous_card_bill_zero_confirmed')
      .eq('ledger_id', ledgerId)
      .eq('starts_on', expected.startsOn)
      .maybeSingle();
    if (periodResult.error) throw periodResult.error;
    if (!periodResult.data) return { available: false, ledgerId, reason: 'period-not-found' };
    const period = periodResult.data;
    const bounds = taipeiPeriodBounds(period.starts_on, period.ends_on);
    const entriesQuery = supabase.from('expense_entries')
      .select('amount,payment_method,is_fixed,occurred_at')
      .eq('ledger_id', ledgerId)
      .gte('occurred_at', bounds.start)
      .lt('occurred_at', bounds.endExclusive);
    const incomeQuery = supabase.from('other_income_entries')
      .select('amount,received_at')
      .eq('ledger_id', ledgerId)
      .gte('received_at', bounds.start)
      .lt('received_at', bounds.endExclusive);
    const repaymentsQuery = supabase.from('advance_repayments')
      .select('amount,received_at')
      .eq('ledger_id', ledgerId)
      .gte('received_at', bounds.start)
      .lt('received_at', bounds.endExclusive);
    const rulesQuery = isCurrent
      ? supabase.from('fixed_expense_rules')
        .select('amount,payment_method,scheduled_day,recurrence_type,scheduled_month,active_from,retired_at')
        .eq('ledger_id', ledgerId)
        .lte('active_from', period.ends_on)
        .or(`retired_at.is.null,retired_at.gte.${period.starts_on}`)
      : Promise.resolve({ data: [], error: null });
    const [entriesResult, incomeResult, repaymentsResult, rulesResult] = await Promise.all([
      entriesQuery, incomeQuery, repaymentsQuery, rulesQuery,
    ]);
    for (const result of [entriesResult, incomeResult, repaymentsResult, rulesResult]) {
      if (result.error) throw result.error;
    }
    return {
      ...summarize({
        period,
        entries: entriesResult.data,
        otherIncomeEntries: incomeResult.data,
        advanceRepayments: repaymentsResult.data,
        fixedRules: rulesResult.data,
        current: isCurrent,
      }),
      ledgerId,
      syncedAt: new Date().toISOString(),
    };
  }

  return { expectedPeriod, scheduledDateInPeriod, activeRulesForPeriod, summarize, taipeiPeriodBounds, fetchSummary };
});
