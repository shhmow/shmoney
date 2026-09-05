# Taxes tab: design notes

Companion to `taxes-mock.html`. The mock is a static prototype with fake data; everything below is what the real feature would need.

## Data model sketch

New tables (D1) or settings blobs:

**tax_profile** (one row per tax year)
- `year` (2026)
- `filing_status` (single | mfj | hoh)
- `resident_state` (MA)
- `claimed_as_dependent` (bool, affects standard deduction)

**tax_source_config** (one row per income category)
- `category_id` -> existing income category (SpaceX, PayPal, Bully The Board, Purdue)
- `treatment` (w2 | se | none)
- `work_state` (CA, IN, MA, ...)
- `fed_withheld_ytd`, `state_withheld_ytd` (user entered; gross paycheck data is not in Plaid, only net deposits, so withholding cannot be derived automatically)

**tax_payment** (derived, not stored)
- Pulled live from transactions in the Taxes category, classified by payee: IRS -> federal credit, MA DOR -> MA credit. Needs a payee-to-jurisdiction mapping (could be a small rules table or just string match on merchant name).

Static reference data (ship in code, update yearly):
- Federal brackets and standard deduction per filing status (2026: single SD $16,100; brackets 10% to $12,400, 12% to $50,400, 22% to $105,700, 24% to $201,775, 32% to $256,225, 35% to $640,600, 37% above).
- State rules: IN flat 2.95% (plus county rates if we want accuracy; Tippecanoe county adds about 1.28%), MA flat 5% with $4,400 personal exemption, CA progressive brackets, TX/FL/WA no income tax.
- SE tax constants: 15.3% on 92.35% of net SE income; half deductible above the line. Social Security wage base irrelevant at these income levels.
- Quarterly deadlines: Apr 15, Jun 15, Sep 15, Jan 15.

## Calculation approach

1. Sum category YTD by treatment: wages (w2), SE gross (se), excluded (none).
2. SE tax = SE gross x 0.9235 x 0.153. Half is an above-the-line deduction.
3. AGI = wages + SE gross - half SE tax. (Assumes zero business expenses; a Schedule C expense input would lower this.)
4. Federal taxable = AGI - standard deduction; run through brackets.
5. States: apportion each source to its work state, subtract that state's deduction/exemption, apply rate. The mock does NOT model the resident-state credit mechanism (MA taxes worldwide income minus a credit for tax paid to other states); real feature should, or at least label the gap.
6. Credits = W2 withholding (user entered) + payments detected in the Taxes category (IRS $3,615 on 2026-05-08, MA DOR $1,026 on 2026-04-29).
7. Net = total liability - credits. Positive = still owed, negative = refund.
8. Quarterly: liability not covered by withholding, divided by 4; remaining shortfall spread over remaining quarters. Withholding is treated as paid evenly through the year (that is how the IRS treats it too).

### Projection question
The mock treats YTD totals as full-year income. Since the SpaceX internship is over but PayPal income may keep coming, a better version projects each source separately (flat, run-rate, or user override per source). This changes the numbers a lot and is probably the first real improvement.

## Real data vs user input

From real app data:
- Gross per source (category income totals)
- Payments already made (Taxes category transactions)

User input required:
- Treatment per category, work state per category
- Filing status, resident state, dependent status
- Federal and state withholding YTD (paystubs; Plaid only sees net deposits)
- Business expenses for SE income (currently assumed zero)

## Open questions for the user

1. SpaceX work state: CA or TX? TX would zero out the largest state exposure. (Mock defaults to CA.)
2. Where was the PayPal work actually performed? MA, IN, or split? Sourcing rules for remote contract work are murky; state assignment is the biggest swing on the state side.
3. Will parents claim him as a dependent? If yes the standard deduction is limited to earned income + $450 (capped at the normal SD). Since nearly all his income is earned, the effect is small but nonzero, and it changes education credits eligibility (which the mock ignores entirely).
4. Any business expenses against the PayPal/BTB income (equipment, software, travel)? Schedule C deductions cut both income tax and SE tax.
5. What was the IRS $3,615 payment for exactly: 2025 balance due, or a 2026 estimated payment? The mock assumes 2026 Q2 estimate. If it was a 2025 payment it should not count as a 2026 credit.
6. Does he need county tax for Indiana (about 1.28% Tippecanoe on top of 2.95%)?
7. Education credits, 1098-T scholarships in excess of tuition, kiddie tax on unearned income: out of scope for v1?

## Known simplifications in the mock

- No resident-state credit for taxes paid to other states.
- CA brackets are approximate and labeled "simplified".
- No CA SDI, no MA PFML, no county tax.
- YTD = annual (no projection).
- Zero SE expenses.
- Safe harbor rules (90% current year / 100% prior year) not modeled in the quarterly suggestions.
