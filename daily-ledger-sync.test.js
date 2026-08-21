const assert = require('node:assert/strict');
const sync = require('./daily-ledger-sync.js');

assert.deepEqual(sync.expectedPeriod('2026-08', 5), {
  startsOn: '2026-08-05',
  endsOn: '2026-09-04',
});
assert.deepEqual(sync.taipeiPeriodBounds('2026-08-05', '2026-09-04'), {
  start: '2026-08-05T00:00:00+08:00',
  endExclusive: '2026-09-05T00:00:00+08:00',
});

assert.equal(sync.scheduledDateInPeriod('2026-08-05', '2026-09-04', 1), '2026-09-01');
assert.equal(sync.scheduledDateInPeriod('2026-08-05', '2026-09-04', 25), '2026-08-25');
assert.equal(sync.scheduledDateInPeriod('2026-08-05', '2026-09-04', 4, 9), '2026-09-04');

const current = sync.summarize({
  current: true,
  period: {
    starts_on: '2026-08-05',
    ends_on: '2026-09-04',
    salary_amount: 100000,
    previous_card_bill_amount: 6300,
    previous_card_bill_zero_confirmed: false,
  },
  entries: [
    { amount: 7000, payment_method: 'cash', is_fixed: false },
    { amount: 6000, payment_method: 'credit_card', is_fixed: false },
    { amount: 999, payment_method: 'cash', is_fixed: true },
  ],
  otherIncomeEntries: [{ amount: 43000 }],
  advanceRepayments: [{ amount: 1000 }],
  fixedRules: [
    { amount: 9000, scheduled_day: 1, recurrence_type: 'monthly', active_from: '2026-01-01', retired_at: null },
    { amount: 400, scheduled_day: 10, recurrence_type: 'monthly', active_from: '2026-10-01', retired_at: null },
  ],
});
assert.equal(current.incomeTotal, 143000);
assert.equal(current.fixedExpenseTotal, 9000);
assert.equal(current.cashExpenseTotal, 6000);
assert.equal(current.creditCardExpenseTotal, 6000);
assert.equal(current.cardPaymentDue, 6300);

const historical = sync.summarize({
  current: false,
  period: {
    starts_on: '2026-07-05',
    ends_on: '2026-08-04',
    salary_amount: 0,
    previous_card_bill_amount: null,
    previous_card_bill_zero_confirmed: false,
  },
  entries: [{ amount: 1234, payment_method: 'cash', is_fixed: true }],
  fixedRules: [{ amount: 9999, scheduled_day: 1 }],
});
assert.equal(historical.fixedExpenseTotal, 1234);
assert.equal(historical.cardPaymentReady, false);
assert.equal(historical.cardPaymentDue, null);

console.log('daily-ledger-sync tests passed');
