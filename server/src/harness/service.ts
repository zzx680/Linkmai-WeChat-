import { Control, Document, Fact, Sources, Workspace } from './types'
import { calculate, CALCULATOR_VERSION, fingerprint, integerInput, numericFactKeys } from './calculator'
import { applicableParameters, ContextBuilder, contextHash, currentLegalRefs, draftSections, ModelRouter, OutputValidator, requireCalculator, RiskValidator, SkillRegistry } from './policy'
import { id, registerMemoryOwner, sourceDigest, WorkflowStore, workflowStore } from './store'
import { claimableFactKeys, claimCodeByKey, materialClaimCandidates } from './material-claims'

const timestamp = (now: number) => new Date(now).toISOString()
export function audit(state: Workspace, code: string, entityId: string, actorId: string, now = Date.now()) {
  state.events.push({ id: id(), code, entityId, actorId, at: timestamp(now) })
}
function invalidate(state: Workspace) {
  state.documents.forEach(doc => { if (!['stale','superseded'].includes(doc.status)) doc.status = 'stale' })
  state.runs.forEach(run => { if (['queued','running'].includes(run.status)) { run.status = 'stale'; delete run.leaseToken; delete run.leaseOwner; delete run.leaseExpiresAt } })
  state.workflow = 'collecting'
}
function reconcileConflicts(state: Workspace) {
  const keys = new Set(state.facts.map(fact => fact.key))
  for (const key of keys) {
    const facts = state.facts.filter(fact => fact.key === key && ['confirmed','disputed'].includes(fact.status))
    const open = state.conflicts.find(conflict => conflict.key === key && conflict.status === 'open')
    if (new Set(facts.map(f => f.value)).size > 1) {
      facts.forEach(f => { f.status = 'disputed' })
      if (open) open.factIds = facts.map(f => f.id)
      else state.conflicts.push({ id: id(), key, factIds: facts.map(f => f.id), status: 'open' })
    } else if (open) {
      // Do not choose a winning fact silently when an underlying source disappears.
      facts.forEach(f => { f.status = 'proposed' })
      open.status = 'resolved'
    }
  }
}
function synchronize(state: Workspace, sources: Sources, control: Control) {
  const digest = sourceDigest(sources)
  const changed = state.sourceHash !== digest
  const oldHash = state.contextHash
  const revisionChanged = state.revision !== sources.revision
  if (state.revision !== sources.revision) { state.revision = sources.revision; invalidate(state) }
  if (changed) {
    if (state.sourceHash && !revisionChanged && oldHash) { state.revision++; invalidate(state) }
    state.sourceHash = digest
    state.evidence.forEach(e => { e.status = 'replaced' })
    const incoming: Fact[] = []
    // Only these describe the case itself. Everything else read off a material is a
    // per-document record: two invoices are not two competing answers to one question,
    // so they must not collide into a conflict or silently overwrite each other.
    const caseLevelKeys = new Set(['accident_date', 'accident_location', 'parties_a', 'parties_b', 'liability', 'accident_description'])
    for (const artifact of sources.artifacts) {
      if (!artifact.metadata?.confirmed) continue
      for (const field of artifact.metadata.fields || []) {
        const hash = fingerprint([artifact.id, field.key, field.value])
        const evidenceId = fingerprint(['evidence', hash])
        const existing = state.evidence.find(e => e.id === evidenceId)
        if (existing) existing.status = 'active'
        else state.evidence.push({ id: evidenceId, sourceId: artifact.id, fieldKey: field.key, sourceHash: hash, status: 'active' })
        const key = caseLevelKeys.has(field.key) ? field.key : `${field.key}#${artifact.id}`
        incoming.push({ id: fingerprint(['material',hash]), key, label: field.label, value: String(field.value),
          status: 'confirmed', source: 'material', sourceId: artifact.id, evidenceRefs: [evidenceId], revision: state.revision })
      }
    }
    for (const fact of sources.facts.filter(f => f.sourceType !== 'material')) {
      incoming.push({ id: fingerprint(['legacy',fact.id,fact.value]), key: fact.key, label: fact.label, value: fact.value,
        status: 'confirmed', source: 'legacy', sourceId: fact.sourceId, evidenceRefs: [], revision: state.revision })
    }
    const active = new Set(incoming.map(f => f.id))
    state.facts.filter(f => f.source !== 'user' && !active.has(f.id)).forEach(f => { f.status = 'rejected' })
    state.facts.filter(f => f.source === 'user' && f.evidenceRefs.some(ref => !state.evidence.some(e => e.id === ref && e.status === 'active'))).forEach(f => { f.status = 'proposed' })
    for (const fact of incoming) {
      const existing = state.facts.find(item => item.id === fact.id)
      if (existing) Object.assign(existing, fact)
      else state.facts.push(fact)
    }
    reconcileConflicts(state)
  }
  state.contextHash = contextHash(state, control)
  if (oldHash && oldHash !== state.contextHash && !changed && !revisionChanged) {
    state.revision++
    state.contextHash = contextHash(state, control)
  }
  if (oldHash && oldHash !== state.contextHash) invalidate(state)
}
function changedInput(state: Workspace, control: Control, actor: string, entityId: string, code: string) {
  state.revision++; invalidate(state); state.contextHash = contextHash(state, control); audit(state, code, entityId, actor)
}
function queueRun(state: Workspace, sources: Sources, control: Control, userId: string, caseId: string, now: number) {
  requirePaid(sources)
  const ctx = ContextBuilder.build(state)
  requireCalculator(control, ctx.accidentDate, ctx.jurisdiction)
  const skill = SkillRegistry.get('case-bundle')
  const key = fingerprint([caseId, state.revision, state.contextHash, skill.version])
  const existing = state.runs.find(run => run.key === key)
  if (existing) return { runId: existing.id, status: existing.status }
  const run = { id: id(), inputRevision: state.revision, contextHash: state.contextHash, key, skillVersion: skill.version,
    status: 'queued' as const, attemptCount: 0, documentIds: [], createdAt: timestamp(now), availableAt: timestamp(now), modelSnapshot: ModelRouter.snapshot() }
  state.runs.push(run)
  audit(state, 'RUN_QUEUED', run.id, userId, now)
  return { runId: run.id, status: run.status }
}
function requirePaid(sources: Sources) { if (!sources.paid) throw new Error('PAYMENT_REQUIRED') }
function refreshWorkflow(state: Workspace) {
  const documents = state.documents.filter(d => d.contextHash === state.contextHash && !['stale','superseded'].includes(d.status))
  state.workflow = state.conflicts.some(c => c.status === 'open') || state.facts.some(f => f.status === 'proposed') ? 'confirming'
    : state.runs.some(r => ['queued','running'].includes(r.status)) ? 'analyzing'
      : documents.length && documents.every(d => d.status === 'approved') ? 'ready'
        : documents.length ? 'analysis_available' : 'collecting'
}
function findDocument(state: Workspace, documentId: string) {
  const document = state.documents.find(item => item.id === documentId)
  if (!document) throw new Error('DOCUMENT_NOT_FOUND')
  if (['stale','superseded'].includes(document.status) || document.contextHash !== state.contextHash || document.inputRevision !== state.revision) throw new Error('INPUT_STALE')
  return document
}
function validatePublication(state: Workspace, document: Document, control: Control) {
  if (state.facts.some(fact => ['proposed','disputed'].includes(fact.status))) throw new Error('FACT_CONFIRMATION_REQUIRED')
  const calculation = state.calculations.find(item => item.id === document.calculationId)
  if (!calculation) throw new Error('INVALID_CALCULATION_REFERENCE')
  const ctx = ContextBuilder.build(state)
  const version = requireCalculator(control, ctx.accidentDate, ctx.jurisdiction)
  const recomputed = calculate({ id: calculation.id, revision: state.revision, contextHash: state.contextHash,
    facts: ctx.facts, jurisdiction: ctx.jurisdiction, accidentDate: ctx.accidentDate, version, parameters: applicableParameters(control, ctx.accidentDate, ctx.jurisdiction) })
  if (fingerprint(recomputed) !== fingerprint(calculation)) throw new Error('CALCULATION_TAMPERED')
  OutputValidator.validate(document, state, calculation)
  const effective = new Set(currentLegalRefs(control, ctx.accidentDate, ctx.jurisdiction))
  const legalRefs = [...new Set([...version.legalRefs, ...calculation.items.flatMap(item => item.parameterRefs.flatMap(ref => control.parameters.find(p => p.id === ref)?.legalRefs || []))])]
  if (fingerprint([...document.legalRefs].sort()) !== fingerprint(legalRefs.sort())) throw new Error('INVALID_LEGAL_REFERENCE')
  if (document.legalRefs.some(ref => !effective.has(ref))) throw new Error('INVALID_LEGAL_REFERENCE')
  if (fingerprint(RiskValidator.check(ctx.facts, calculation)) !== fingerprint(document.riskReasons)) throw new Error('INVALID_RISK_ASSESSMENT')
  if (!document.userConfirmedAt) throw new Error('USER_CONFIRMATION_REQUIRED')
}
export class HarnessService {
  constructor(readonly store: WorkflowStore = workflowStore) {}
  private command<T>(userId: string, caseId: string, fn: (state: Workspace, sources: Sources, control: Control) => T | Promise<T>) {
    return this.store.transaction(userId, caseId, async (state, sources, control) => {
      registerMemoryOwner(caseId, userId)
      synchronize(state, sources, control)
      refreshWorkflow(state)
      const result = await fn(state, sources, control)
      refreshWorkflow(state)
      return result
    })
  }
  get(userId: string, caseId: string) {
    return this.command(userId, caseId, async (state, sources) => ({ ...state, events: undefined,
      legalReferences: sources.paid ? (await sources.getLegalReferences([...new Set(state.documents.filter(d => d.contextHash === state.contextHash).flatMap(d => d.legalRefs))]))
        .map(ref => ({ id: ref.legalRefId, title: ref.title, articleNumber: ref.articleNumber, content: ref.content,
          sourceUrl: ref.sourceUrl, from: ref.effectiveFrom, to: ref.effectiveTo })) : [],
      // Amounts read off confirmed materials, offered for one-tap confirmation.
      // Kept outside the paid gate: the user must be able to see what paying unlocks.
      claimCandidates: materialClaimCandidates(state, sources),
      documents: sources.paid ? state.documents : [], calculations: sources.paid ? state.calculations : [],
      runs: state.runs.map(({ leaseToken: _token, leaseOwner: _owner, ...run }) => run) }))
  }
  // Accepts a material-derived amount for one loss item. The amount is recomputed
  // server side from the same materials, so a client cannot submit its own number.
  acceptClaim(userId: string, caseId: string, candidateId: string, key?: string) {
    return this.command(userId, caseId, (state, sources, control) => {
      const candidate = materialClaimCandidates(state, sources).find(item => item.id === candidateId)
      if (!candidate) throw new Error('CLAIM_CANDIDATE_NOT_FOUND')
      const targetKey = key || candidate.key
      if (key && !candidate.alternatives.includes(key)) throw new Error('CLAIM_KEY_NOT_ALLOWED')
      if (!targetKey || !claimableFactKeys.has(targetKey)) throw new Error('CLAIM_KEY_REQUIRED')
      const code = claimCodeByKey[targetKey]
      const value = String(candidate.amountCents)
      const push = (factKey: string, label: string, factValue: string, evidenceRefs: string[]) => {
        const existing = state.facts.find(item => item.key === factKey && item.status !== 'rejected')
        if (existing) {
          if (existing.value === factValue) return
          existing.value = factValue; existing.label = label; existing.status = 'confirmed'
          existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...evidenceRefs])]
          existing.revision = state.revision + 1
          return
        }
        // source 'user': a person confirmed this amount. Material-derived auto facts are
        // recomputed on every sync and would otherwise be discarded on the next material change.
        state.facts.push({ id: id(), key: factKey, label, value: factValue, status: 'confirmed',
          source: 'user', sourceId: userId, evidenceRefs: evidenceRefs, revision: state.revision + 1 })
      }
      push(targetKey, candidate.label, value, candidate.evidenceIds)
      // Claiming an amount also states the scope, which the calculator otherwise reports as missing.
      push(`claim_${code}`, '是否主张', 'yes', [])
      reconcileConflicts(state)
      changedInput(state, control, userId, candidateId, 'CLAIM_ACCEPTED')
      return state.facts.filter(fact => fact.key === targetKey || fact.key === `claim_${code}`)
    })
  }
  propose(userId: string, caseId: string, input: { key: string; label: string; value: string; evidenceRefs: string[] }) {
    return this.command(userId, caseId, (state, _sources, control) => {
      if (numericFactKeys.has(input.key)) integerInput(input.value)
      if (input.key.startsWith('claim_') && !['yes','no'].includes(input.value)) throw new Error('INVALID_CLAIM_SCOPE')
      if (input.evidenceRefs.some(ref => !state.evidence.some(e => e.id === ref && e.status === 'active'))) throw new Error('INVALID_REFERENCE')
      const fact: Fact = { ...input, id: id(), source: 'user', sourceId: userId, status: 'proposed', revision: state.revision + 1 }
      state.facts.push(fact); changedInput(state, control, userId, fact.id, 'FACT_PROPOSED'); state.workflow = 'confirming'
      return fact
    })
  }
  decideFact(userId: string, caseId: string, factId: string, action: 'confirm' | 'reject') {
    return this.command(userId, caseId, (state, _sources, control) => {
      const fact = state.facts.find(f => f.id === factId)
      if (!fact || fact.status !== 'proposed') throw new Error('FACT_NOT_PROPOSED')
      fact.status = action === 'confirm' ? 'confirmed' : 'rejected'; reconcileConflicts(state)
      changedInput(state, control, userId, fact.id, action === 'confirm' ? 'FACT_CONFIRMED' : 'FACT_REJECTED')
      return fact
    })
  }
  resolve(userId: string, caseId: string, conflictId: string, factId: string) {
    return this.command(userId, caseId, (state, _sources, control) => {
      const conflict = state.conflicts.find(c => c.id === conflictId && c.status === 'open')
      if (!conflict || !conflict.factIds.includes(factId)) throw new Error('CONFLICT_NOT_FOUND')
      for (const fact of state.facts.filter(f => conflict.factIds.includes(f.id))) fact.status = fact.id === factId ? 'confirmed' : 'rejected'
      conflict.status = 'resolved'; conflict.resolutionFactId = factId
      changedInput(state, control, userId, conflict.id, 'CONFLICT_RESOLVED'); return conflict
    })
  }
  calculate(userId: string, caseId: string) {
    return this.command(userId, caseId, (state, sources, control) => {
      requirePaid(sources)
      const ctx = ContextBuilder.build(state)
      const version = requireCalculator(control, ctx.accidentDate, ctx.jurisdiction)
      const existing = state.calculations.find(c => c.contextHash === state.contextHash)
      if (existing) return existing
      const result = calculate({ id: id(), revision: state.revision, contextHash: state.contextHash, facts: ctx.facts,
        jurisdiction: ctx.jurisdiction, accidentDate: ctx.accidentDate, version, parameters: applicableParameters(control, ctx.accidentDate, ctx.jurisdiction) })
      state.calculations.push(result); audit(state, 'CALCULATION_CREATED', result.id, userId); return result
    })
  }
  enqueue(userId: string, caseId: string, now = Date.now()) {
    if (process.env.HARNESS_PAUSED === 'true') throw new Error('WORKFLOW_PAUSED')
    return this.command(userId, caseId, (state, sources, control) => queueRun(state, sources, control, userId, caseId, now))
  }
  claim(userId: string, caseId: string, worker: string, at?: number) {
    return this.command(userId, caseId, (state, sources) => {
      const now = at ?? Date.now()
      if (!sources.paid) return null
      const skill = SkillRegistry.get('case-bundle')
      const run = state.runs.find(r => r.status === 'queued' && r.availableAt <= timestamp(now)
        || r.status === 'running' && !!r.leaseExpiresAt && r.leaseExpiresAt <= timestamp(now))
      if (!run) return null
      if (run.attemptCount >= skill.maxAttempts) { run.status = 'failed'; run.safeErrorCode = 'ATTEMPTS_EXHAUSTED'; audit(state, 'RUN_FAILED', run.id, worker, now); return null }
      run.status = 'running'; run.attemptCount++; run.leaseOwner = worker; run.leaseToken = id(); run.leaseExpiresAt = timestamp(now + skill.leaseMs)
      delete run.safeErrorCode
      run.startedAt = timestamp(now)
      audit(state, 'RUN_CLAIMED', run.id, worker, now)
      return { run: structuredClone(run), snapshot: structuredClone(state), model: ModelRouter.snapshot() }
    })
  }
  complete(userId: string, caseId: string, runId: string, token: string, at?: number) {
    return this.command(userId, caseId, (state, sources, control) => {
      const now = at ?? Date.now()
      requirePaid(sources)
      const run = state.runs.find(r => r.id === runId)
      if (!run || run.status !== 'running' || run.leaseToken !== token || !run.leaseExpiresAt || run.leaseExpiresAt <= timestamp(now)) throw new Error('LEASE_LOST')
      if (run.contextHash !== state.contextHash) throw new Error('INPUT_STALE')
      const ctx = ContextBuilder.build(state)
      const version = requireCalculator(control, ctx.accidentDate, ctx.jurisdiction)
      let calculation = state.calculations.find(c => c.contextHash === state.contextHash)
      if (!calculation) {
        calculation = calculate({ id: id(), revision: state.revision, contextHash: state.contextHash, facts: ctx.facts,
          jurisdiction: ctx.jurisdiction, accidentDate: ctx.accidentDate, version, parameters: applicableParameters(control, ctx.accidentDate, ctx.jurisdiction) })
        state.calculations.push(calculation)
      }
      const skill = SkillRegistry.get('case-bundle')
      const reasons = RiskValidator.check(ctx.facts, calculation)
      for (const type of ['case_report','evidence_catalog','action_plan'] as const) {
        const previous = state.documents.filter(d => d.type === type).sort((a,b) => b.version - a.version)[0]
        const document: Document = { id: id(), type, version: (previous?.version || 0) + 1, inputRevision: state.revision,
          contextHash: state.contextHash, skillVersion: skill.version, promptVersion: skill.promptVersion, templateVersion: skill.templateVersion,
          sections: draftSections(type, state, calculation), factRefs: ctx.facts.map(f => f.id), evidenceRefs: [...new Set(ctx.facts.flatMap(f => f.evidenceRefs))],
          legalRefs: [...new Set([...version.legalRefs, ...calculation.items.flatMap(item => item.parameterRefs.flatMap(ref => control.parameters.find(p => p.id === ref)?.legalRefs || []))])], calculationId: calculation.id, status: 'draft', riskReasons: reasons,
          supersedesId: previous?.id, createdAt: timestamp(now) }
        OutputValidator.validate(document, state, calculation)
        if (previous && previous.status !== 'stale') previous.status = 'superseded'
        state.documents.push(document); run.documentIds.push(document.id)
        audit(state, 'DOCUMENT_DRAFTED', document.id, run.leaseOwner || 'worker', now)
      }
      run.status = 'succeeded'; delete run.leaseToken; delete run.leaseOwner; delete run.leaseExpiresAt
      run.completedAt = timestamp(now); run.durationMs = now - new Date(run.startedAt!).getTime()
      state.workflow = 'analysis_available'; audit(state, 'RUN_SUCCEEDED', run.id, 'worker', now)
      return run.documentIds
    })
  }
  fail(userId: string, caseId: string, runId: string, token: string, now = Date.now()) {
    return this.command(userId, caseId, state => {
      const run = state.runs.find(r => r.id === runId)
      if (!run || run.status !== 'running' || run.leaseToken !== token) return
      run.status = run.attemptCount < SkillRegistry.get('case-bundle').maxAttempts ? 'queued' : 'failed'
      run.availableAt = timestamp(now + 1000 * 2 ** run.attemptCount); run.safeErrorCode = 'WORKFLOW_EXECUTION_FAILED'
      delete run.leaseToken; delete run.leaseExpiresAt; delete run.leaseOwner
      audit(state, 'RUN_RETRY_OR_FAILURE', run.id, 'worker', now)
    })
  }
  confirm(userId: string, caseId: string, documentId: string) {
    return this.command(userId, caseId, (state, sources, control) => {
      requirePaid(sources)
      const document = findDocument(state, documentId)
      if (document.userConfirmedAt) return document
      if (document.status !== 'draft') throw new Error('INVALID_DOCUMENT_TRANSITION')
      if (process.env.HARNESS_PAUSED === 'true') throw new Error('WORKFLOW_PAUSED')
      // Confirmation records that the user reviewed this AI-generated draft;
      // risk reasons remain visible and do not imply a lawyer reviewed it.
      document.userConfirmedAt = timestamp(Date.now()); document.status = 'user_confirmed'
      validatePublication(state, document, control); document.status = 'approved'; document.approvedAt = timestamp(Date.now()); state.workflow = 'ready'
      audit(state, 'DOCUMENT_USER_CONFIRMED', document.id, userId); return document
    })
  }
  retry(userId: string, caseId: string, runId: string) {
    if (process.env.HARNESS_PAUSED === 'true') throw new Error('WORKFLOW_PAUSED')
    return this.command(userId, caseId, (state, sources, control) => {
      requirePaid(sources)
      const run = state.runs.find(r => r.id === runId && r.contextHash === state.contextHash && r.status === 'failed')
      if (!run) throw new Error('INVALID_RETRY_STATE')
      changedInput(state, control, userId, run.id, 'MANUAL_RETRY_REQUESTED')
      return queueRun(state, sources, control, userId, caseId, Date.now())
    })
  }
  approved(userId: string, caseId: string, documentId: string) {
    return this.command(userId, caseId, (state, sources, control) => {
      requirePaid(sources); const document = findDocument(state, documentId)
      if (document.status !== 'approved') throw new Error('DOCUMENT_NOT_APPROVED')
      validatePublication(state, document, control); audit(state, 'DOCUMENT_VIEWED', document.id, userId); return document
    })
  }
}
export const harness = new HarnessService()
export const supportedCalculatorVersion = CALCULATOR_VERSION
