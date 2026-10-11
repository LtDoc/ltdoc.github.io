# Treaties, coalitions and peace conferences

Open **Nation → Treaties and coalitions → Negotiate / view treaties**. A nation can invite other nations to a diplomatic treaty, or open a peace conference from an active war. The GM can choose the nation they represent. Observers can read ratified treaties but cannot negotiate.

All signatories can edit the shared document and selectable clauses. Saving creates a new revision and clears every approval. Every nation must approve the exact same revision before ratification. War conferences always include both entire war sides, with the original aggressor and defender shown as lead negotiators. There is no war score, bidding, or privileged veto for the leads. Players negotiate through RP. A war continues until its ratified settlement takes effect.

Concurrent edits use revision checks: a stale save or approval is rejected, the player's local writing remains available, and the latest document and terms are shown for review and merging. Reconnecting refreshes the shared revision. The archive contains revision history, approvals and treaty events. Custom writing is RP-only; only the configured clauses drive automatic game effects.

## Selectable clauses

- **Province transfers:** choose the ceding nation and recipient, then select provinces on the map. The treaty screen hides during selection; click provinces to toggle their highlighted outlines, then choose Done to return. Cancel/Escape returns without changing the selection. Ownership is validated again at ratification and activation.
- **Annexation:** transfer all remaining provinces or free-form territory owned by the ceding nation. Nations and their armies remain in the campaign for RP and management; annexation does not delete their accounts, troops or treaty history.
- **Mutual research agreements:** a new project costs 70% of its normal RP if a partner has already unlocked that technology. Discounts do not stack. The requirement locks when the project becomes active, including projects promoted from the queue. Existing active projects and preserved research progress receive no retroactive discount. Money costs and research prerequisites remain unchanged.
- **Unit production licenses:** the licensor must be able to build the chosen unit type. The recipient may produce that type without receiving the underlying technology. Fees can be negotiated through currency-payment clauses. Unfinished production that relied on a license is cancelled and its original resource, money and manpower costs refunded when permission ends. Completed units remain.
- **Movement and supply rights:** directional grants with independent land passage, ports, airfields/landing, and supply switches. Add a second grant for mutual access. Land passage includes railway movement through the host; supply access permits its supply sources and railway supply links. Port/airfield access permits the relevant refitting. Combat remains subject to war relations.
- **Mutual defensive pacts:** a declaration against a partner automatically brings its defensive partners onto the defending war side. Offensive entry is not forced.
- **Permanent coalitions:** members are allied and may elect to join a member's future war. Leaving a coalition does not leave a war already joined. Once participants join, their opposing relations belong to a common war and peace conference. Compatible overlapping wars merge; unrelated wars stay separate.
- **Dissolution:** a demand can dissolve a named coalition with every coalition member's approval, or end a bilateral alliance. Permanent coalitions persist beyond treaty expiration unless members leave or negotiate dissolution.
- **Currency payments / reparations:** a fixed amount is paid at the end of each eligible turn for the negotiated payment count. A one-payment clause can cover a license fee or settlement payment. Available funds are transferred and any shortfall remains visible in arrears. Later funds pay arrears even after the payment schedule ends. Missed payments automatically appear in the news.
- **Truces:** record an agreed period of peace. Breaking one by declaring war reports the breach in the news; RP commitments do not prevent players from choosing renewed war.

## Timelines and breaches

The effective turn and optional overall duration use game turns. Continuing clauses can have their own start turn and duration. A duration of N covers turns start through start + N − 1. Territory transfers and coalition changes happen with the treaty and persist afterwards. Scheduled settlements revalidate ownership and war participation; an invalid settlement returns to a draft with approvals cleared instead of applying partially.

Joining a war changes its conference participants, increments the draft revision and clears approvals. A signed but future settlement also returns to negotiation if a new participant joins. Ratification ends the covered war for every participant together. Unrelated wars continue.

Captured provinces already belong to their occupier in the ownership ledger. Peace retains that control for provinces not mentioned in a territorial clause; explicit transfers and annexation take precedence. Province maps display only this ownership layer, suppressing legacy territory polygons that could otherwise tint ceded land with a former owner's colour. This also corrects existing campaign displays when the updated client reloads, without rewriting their ownership history.

Signatories may withdraw. Breaking a ratified treaty, declaring war against a treaty partner, and failing to pay reparations produce public diplomatic news. A breach never automatically restarts a settled war. Peace and completed territory transfers are not reversed by withdrawal or expiry. The GM's turn undo restores treaty state, payment balances, affected ownership and generated diplomatic news along with the turn snapshot.

## Storage and validation

Each campaign has a `treaty_ledgers` row containing treaties, war sides and permanent coalitions. Diplomacy retains its existing bilateral relation rows for combat, supply and compatibility. Legacy wars are imported on access without guessing connections between unrelated wars. Treaty mutation, ratification and immediate effects share a database transaction; scheduled activation uses a savepoint so invalid clauses cannot partly end a war or transfer land.

API: `/api/lobbies/:id/game/treaties`, `/:treatyId`, `/:treatyId/{approve,revoke,withdraw}`, `/wars/:warId/join`, and `/coalitions/:coalitionId/leave`. Player identity comes from campaign membership. GM representation is explicit through `factionId`. Edits and approvals require the current `revision`. Drafts are visible only to signatories and the GM; ratified treaties are public. Bounds and campaign ownership are enforced server-side.

Run the integration checks with `npm run test:treaties`. Browser checks additionally use a Playwright installation via `WOE_PLAYWRIGHT_MODULE` or the project's available package.
