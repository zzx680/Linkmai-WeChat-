import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CALCULATOR_VERSION } from '../src/harness/calculator'
import { currentLegalRefs, requireCalculator } from '../src/harness/policy'
import { workflowStore } from '../src/harness/store'
import { ensureCuratedPolicy } from '../src/services/curated-policy'

test('curated policy seeds an approved calculator version idempotently', async () => {
  await ensureCuratedPolicy()
  await ensureCuratedPolicy()
  const control = await workflowStore.control(current => current)
  const versions = control.calculators.filter(item => item.id === CALCULATOR_VERSION)
  assert.equal(versions.length, 1)
  assert.equal(versions[0].status, 'approved')
  assert.equal(versions[0].reviewedBy, 'curated-source')
  assert.ok(currentLegalRefs(control, '2026-01-02', 'CN-ZJ-HZ').includes('cn-civil-code-2021-art-1179'))
  assert.equal(requireCalculator(control, '2026-01-02', 'CN-ZJ-HZ').id, CALCULATOR_VERSION)
})

test('curated policy never overwrites an existing calculator version', async () => {
  await workflowStore.control(current => {
    current.calculators = [{ id: CALCULATOR_VERSION, status: 'retired', legalRefs: ['legacy'], reviewedBy: 'ops' }]
  })
  await ensureCuratedPolicy()
  const control = await workflowStore.control(current => current)
  assert.deepEqual(control.calculators.find(item => item.id === CALCULATOR_VERSION),
    { id: CALCULATOR_VERSION, status: 'retired', legalRefs: ['legacy'], reviewedBy: 'ops' })
})
