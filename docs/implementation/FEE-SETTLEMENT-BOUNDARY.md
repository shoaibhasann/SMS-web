# Fee settlement boundary

The current application records office-confirmed payments and payouts. It does not initiate a transfer or verify a bank/provider transaction. A future online provider must confirm a settlement on the server before it reaches the accounting journal.

## Current module boundaries

- `lib/finance/money.ts` owns decimal-string INR and integer-paise calculations. `payment-methods.ts` owns the supported manual office methods. Existing fee-batch money exports remain compatible.
- `lib/finance/advance-credit.ts` owns typed account, receipt, allocation, correction, refund and payout RPC boundaries. Components do not write financial tables or calculate an authoritative balance.
- `components/finance/advance-credit-workspace.tsx` resolves office access and school/student context. `advance-credit-account.tsx` handles the scoped forms and recovery state. `family-advance-credit.tsx` renders the separate read-only family statement.
- Private database account locks and immutable journal entries own credit entitlement. Checked office RPCs bind the active actor, school, pupil, amount, reviewed versions and idempotency ID. Public wrappers do not grant raw journal access.

## Accounting rules

An advance receipt records actual money received and increases credit held for one pupil. Applying credit to a fee is a noncash allocation: it reduces available advance and the fee's outstanding balance without issuing a second money receipt. Returning a reviewed allocation to credit reopens that fee balance without recording a payout.

For one pupil, held credit is `received − receipt corrections − net allocations − recorded refunds`. Available credit is held credit minus approved unpaid refund reservations. Fee-applied payments are `direct fee receipts − direct receipt reversals + net advance allocations`. Cash reporting separately counts money received minus recorded-entry corrections and actual recorded payouts. Held advance and outstanding fees are displayed separately until an allocation is posted.

A refund request has no cash effect. Independent approval reserves the entitlement; cancellation releases the reservation. Only recording a completed offline payout creates the refund journal entry and that day's cash outflow. A successful approval must never be displayed as a completed payout. All actual cash postings use the current IST business day, and a closed day rejects new postings. An uncertain HTTP result recovers the original UUID/payload before another operation can start.

The advance balance belongs to the retained pupil identity across academic sessions. It cannot be moved to another pupil or school through an allocation. This module supports refunds of unused advance credit, including credit returned from its own allocations. It does not turn an old ordinary fee-payment receipt into refundable advance, and it does not create fake receipts for imported historical credit.

## Adding an online provider later

Add a server-only provider adapter and verified webhook/settlement endpoint. Keep provider SDKs, credentials, webhook signatures, retries and remote status checks outside UI components and outside the balance-calculation functions. Preserve a distinction between a checkout/order, a confirmed settlement, a refund authorization and a confirmed provider refund.

Before posting, the adapter must verify the authoritative provider settlement, INR amount, currency, school merchant context, internal pupil/order mapping and terminal success state. Browser redirect parameters, client booleans and user-editable auth metadata are not settlement proof. Use unique provider/account/settlement identifiers and a transactionally stored event receipt; repeated or out-of-order provider events must recover the same accounting outcome. A refund authorization must reserve entitlement before an asynchronous payout, and a failed/cancelled payout must release it without a fake cash event.

The current manual office wrappers remain role-gated. Do not grant them anonymous execution or pass a privileged service key to the browser to make an integration work. Introduce a narrowly scoped trusted settlement entrypoint and migration when the real provider is chosen; reuse the account/journal rules beneath it. Provider-specific features such as webhook validation, fee settlement, chargebacks, partial bank refunds, reconciliation and operational alerts require their own integration tests and school sign-off.

No gateway SDK, payment button, mock-success webhook or provider credentials are included in this phase. The typed service and journal boundaries allow that integration to be added without replacing fee demands, credit allocations or retained receipts.
