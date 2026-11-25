import { CALCULATOR_VERSION } from '../harness/calculator'
import { workflowStore } from '../harness/store'
import { ensureCoreTrafficLegalCorpus } from './legal-corpus'

// The review portal is retired, so policy is curated in-repo and seeded idempotently.
const CURATED_REVIEWER = 'curated-source'
const CURATED_LEGAL_REFS = ['cn-civil-code-2021-art-1179']

export async function ensureCuratedPolicy(): Promise<void> {
  await ensureCoreTrafficLegalCorpus()
  await workflowStore.control(control => {
    if (control.calculators.some(item => item.id === CALCULATOR_VERSION)) return
    control.calculators.push({
      id: CALCULATOR_VERSION,
      status: 'approved',
      legalRefs: [...CURATED_LEGAL_REFS],
      reviewedBy: CURATED_REVIEWER,
    })
  }, CURATED_REVIEWER)
}
