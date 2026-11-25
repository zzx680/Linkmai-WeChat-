import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Fact } from '../src/harness/types'

process.env.DB_TYPE = 'memory'
process.env.NODE_ENV = 'test'
const { memoryDB: db } = require('../src/db/memory') as typeof import('../src/db/memory')
const { config } = require('../src/config') as typeof import('../src/config')
const { WorkflowStore, id } = require('../src/harness/store') as typeof import('../src/harness/store')
const { HarnessService } = require('../src/harness/service') as typeof import('../src/harness/service')
const { calculate, yuanToCents, integerInput, expenseDefinitions, fingerprint } = require('../src/harness/calculator') as typeof import('../src/harness/calculator')
const { ContextBuilder, OutputValidator, RiskValidator, applicableParameters } = require('../src/harness/policy') as typeof import('../src/harness/policy')
const { coreTrafficLegalDocuments, coreTrafficLegalSections } = require('../src/legal/core-traffic-law') as typeof import('../src/legal/core-traffic-law')
const store = new WorkflowStore(false)
const service = new HarnessService(store)
const fact = (key: string, value: string, evidenceRefs: string[] = []): Fact => ({ id: id(), key, label: key, value, evidenceRefs, status: 'confirmed', source: 'user', sourceId: 'user', revision: 1 })
const scopes = () => expenseDefinitions.map(d => fact(`claim_${d.code}`, 'no'))
const version = { id: 'compensation-v1', status: 'approved' as const, legalRefs: ['cn-civil-code-2021-art-1179'], reviewedBy: 'curated-source' }
const calc = (facts: Fact[], parameters: any[] = []) => calculate({ id:'calc', revision:1, contextHash:'ctx', facts, parameters, jurisdiction:'CN-ZJ-HZ', accidentDate:'2026-10-20', version })

test('integer cents, explicit scope, missing inputs and formula boundaries', () => {
  assert.equal(yuanToCents('0.01'), 1); assert.equal(yuanToCents('100.10'), 10010)
  for (const bad of ['-1','0.001','1e3','1,000','NaN']) assert.throws(() => yuanToCents(bad))
  assert.throws(() => integerInput('1.5'))
  assert.equal(calc([]).totalCents, undefined)
  assert.equal(calc(scopes()).totalCents, 0)
  const facts = scopes().filter(f => f.key !== 'claim_nursing').concat(fact('claim_nursing','yes'),fact('nursing_daily_cents','12001'),fact('nursing_days','3'),fact('nursing_people','2'))
  const result = calc(facts)
  assert.equal(result.totalCents, 72006); assert.equal(result.status, 'requires_review')
  assert.throws(() => calc(facts.map(f => f.key === 'nursing_days' ? {...f,value:'3.2'} : f)), /INVALID_CALCULATION_INPUT/)
  assert.throws(() => calc(facts.map(f => f.key === 'nursing_daily_cents' ? {...f,value:'999999999999'} : f).map(f => f.key === 'nursing_days' ? {...f,value:'36500'} : f)), /CALCULATION_OVERFLOW/)
  const meals = scopes().filter(f => f.key !== 'claim_meals').concat(fact('claim_meals','yes'),fact('hospital_days','3'))
  assert.deepEqual(calc(meals).missingInputs, ['meals_daily_cents'])
  const p = {id:'p', code:'meals_daily_cents', status:'approved', jurisdiction:'CN-ZJ-HZ', from:'2026-01-01', value:5000}
  assert.equal(calc(meals,[p]).totalCents,15000)
  assert.equal(calc(meals,[{...p,from:'2026-11-01'}]).totalCents,undefined)
  assert.equal(calc(meals,[{...p,jurisdiction:'CN-JS'}]).totalCents,undefined)
  assert.equal(calc(meals,[p,{...p,id:'p2'}]).totalCents,undefined)
})

async function fixture() {
  await db.upsertLegalCorpus(coreTrafficLegalDocuments, coreTrafficLegalSections)
  await store.control(c => { c.calculators = [version]; c.parameters = [] })
  const user = await db.createUser(`workflow-${id()}`)
  const item = await db.createCase(user.id, '测试案件')
  const entitlement = await db.getOrCreateCaseEntitlement(user.id,item.id); entitlement.status = 'paid'
  await db.persistConfirmedFacts(user.id,item.id,[
    ['accident_date','2026-10-20'],['jurisdiction','CN-ZJ-HZ'],['injury_severity','minor'],['risk_screened','yes'],['has_liability_document','yes'],
    ...expenseDefinitions.map(d => [`claim_${d.code}`,'no'])
  ].map(([key,value]) => ({key,label:key,value,source:'user_text'})))
  return {userId:user.id, caseId:item.id, entitlement}
}
async function generate(f: Awaited<ReturnType<typeof fixture>>) {
  const run = await service.enqueue(f.userId,f.caseId)
  const claim = await service.claim(f.userId,f.caseId,'test-worker'); assert.ok(claim)
  await service.complete(f.userId,f.caseId,run.runId,claim.run.leaseToken!)
  return (await service.get(f.userId,f.caseId)).documents.find(d => d.type === 'case_report' && d.status === 'draft')!
}

test('legacy lawyer-review drafts require user confirmation again without a review task', async () => {
  const f = await fixture()
  const report = await generate(f)
  await store.transaction(f.userId, f.caseId, state => {
    const document = state.documents.find(item => item.id === report.id)!
    Object.assign(document, { status: 'lawyer_review', userConfirmedAt: new Date().toISOString(), reviewTaskId: 'retired-task' })
    Object.assign(state, { reviews: [{ id: 'retired-task' }], workflow: 'review_pending' })
  })
  const state = await service.get(f.userId, f.caseId)
  const draft = state.documents.find(item => item.id === report.id)!
  assert.equal(draft.status, 'draft')
  assert.equal(draft.userConfirmedAt, undefined)
  assert.equal('reviewTaskId' in draft, false)
  assert.equal('reviews' in state, false)
  assert.equal(state.workflow, 'analysis_available')
  await assert.rejects(service.approved(f.userId, f.caseId, report.id), /DOCUMENT_NOT_APPROVED/)
  const confirmed = await service.confirm(f.userId, f.caseId, report.id)
  assert.equal(confirmed.status, 'approved')
  assert.ok(confirmed.riskReasons.length)
})

test('free billing mode allows calculation and report drafting for unpaid or refunded cases', async () => {
  const billingEnabled = config.payment.billingEnabled
  config.payment.billingEnabled = false
  try {
    const f = await fixture()
    f.entitlement.status = 'refunded'
    const calculation = await service.calculate(f.userId, f.caseId)
    assert.equal(calculation.status, 'complete')
    const run = await service.enqueue(f.userId, f.caseId)
    const claimed = await service.claim(f.userId, f.caseId, 'free-test-worker')
    assert.ok(claimed)
    await service.complete(f.userId, f.caseId, run.runId, claimed.run.leaseToken!)
    assert.equal((await service.get(f.userId, f.caseId)).documents.length, 3)
  } finally {
    config.payment.billingEnabled = billingEnabled
  }
})

test('worker idempotency, concurrent claim, crash recovery and fencing', async () => {
  const f = await fixture(), now = Date.now()
  const one = await service.enqueue(f.userId,f.caseId,now), two = await service.enqueue(f.userId,f.caseId,now)
  assert.equal(one.runId,two.runId)
  const claims = await Promise.all(Array.from({length:8},(_,i) => service.claim(f.userId,f.caseId,`worker-${i}`,now)))
  assert.equal(claims.filter(Boolean).length,1)
  const original = claims.find(Boolean)!
  const recovered = await service.claim(f.userId,f.caseId,'recovery',now+31000); assert.ok(recovered)
  await assert.rejects(service.complete(f.userId,f.caseId,one.runId,original.run.leaseToken!,now+31001),/LEASE_LOST/)
  await service.complete(f.userId,f.caseId,one.runId,recovered.run.leaseToken!,now+31002)
  await assert.rejects(service.complete(f.userId,f.caseId,one.runId,recovered.run.leaseToken!,now+31003),/LEASE_LOST/)
  const state = await service.get(f.userId,f.caseId)
  assert.equal(state.documents.length,3); assert.equal(state.runs[0].attemptCount,2)
  assert.equal('leaseToken' in state.runs[0],false)
})

test('restored source facts reactivate their deterministic record', async () => {
  const f = await fixture()
  await service.get(f.userId, f.caseId)
  await db.persistConfirmedFacts(f.userId, f.caseId, [{ key: 'accident_date', label: '事故日期', value: '2026-10-21', source: 'user_text' }])
  await service.get(f.userId, f.caseId)
  await db.persistConfirmedFacts(f.userId, f.caseId, [{ key: 'accident_date', label: '事故日期', value: '2026-10-20', source: 'user_text' }])
  const workspace = await service.get(f.userId, f.caseId)
  assert.equal(workspace.facts.find(fact => fact.key === 'accident_date' && fact.value === '2026-10-20')?.status, 'confirmed')
  assert.equal((await service.calculate(f.userId, f.caseId)).accidentDate, '2026-10-20')
})

test('candidate facts stay excluded; conflicts need explicit resolution; ownership is checked', async () => {
  const f = await fixture()
  const candidate = await service.propose(f.userId,f.caseId,{key:'accident_date',label:'事故日期',value:'2026-10-21',evidenceRefs:[]})
  assert.equal((await service.calculate(f.userId,f.caseId)).accidentDate,'2026-10-20')
  await service.decideFact(f.userId,f.caseId,candidate.id,'confirm')
  await assert.rejects(service.enqueue(f.userId,f.caseId),/FACT_CONFLICT/)
  const conflict = (await service.get(f.userId,f.caseId)).conflicts.find(c => c.status === 'open')!
  await service.resolve(f.userId,f.caseId,conflict.id,candidate.id)
  assert.equal((await service.calculate(f.userId,f.caseId)).accidentDate,'2026-10-21')
  await assert.rejects(service.propose(f.userId,f.caseId,{key:'test',label:'测试',value:'x',evidenceRefs:['another-case-reference']}),/INVALID_REFERENCE/)
  await assert.rejects(service.get('another-user',f.caseId),/CASE_NOT_FOUND/)
  assert.ok((await store.casesForWork()).every(entry => entry.caseId !== f.caseId || entry.userId === f.userId))
})

test('risk flags are visible, but AI drafts can be confirmed without a lawyer-review workflow', async () => {
  const f = await fixture(), document = await generate(f)
  assert.ok(document.riskReasons.includes('RISK_SCREENING_REQUIRED'))
  const confirmed = await service.confirm(f.userId,f.caseId,document.id)
  assert.equal(confirmed.status,'approved')
  assert.equal((await service.approved(f.userId,f.caseId,document.id)).status,'approved')
  await store.transaction(f.userId,f.caseId,state => {
    assert.equal('reviews' in state,false)
    assert.ok(state.events.some(e => e.code === 'DOCUMENT_USER_CONFIRMED'))
  })
})

test('refund, changed input and retired policy still block AI document access', async () => {
  const f = await fixture(), document = await generate(f)
  await service.confirm(f.userId,f.caseId,document.id)
  f.entitlement.status = 'refunded'
  await assert.rejects(service.approved(f.userId,f.caseId,document.id),/PAYMENT_REQUIRED/)
  assert.equal((await service.get(f.userId,f.caseId)).documents.length,0)
  f.entitlement.status = 'paid'
  await db.persistConfirmedFacts(f.userId,f.caseId,[{key:'location',label:'地点',value:'新地点',source:'user_text'}])
  await assert.rejects(service.approved(f.userId,f.caseId,document.id),/INPUT_STALE/)
  assert.ok((await service.get(f.userId,f.caseId)).documents.every(d => d.status === 'stale'))
  const next = await generate(f)
  await store.control(c => { c.calculators[0].status = 'retired' })
  await assert.rejects(service.confirm(f.userId,f.caseId,next.id),/INPUT_STALE/)
  assert.ok((await service.get(f.userId,f.caseId)).documents.every(d => d.status === 'stale'))
})

test('user-editable material fields cannot waive human risk screening', () => {
  const materialFacts = [fact('injury_severity','minor'), ...['risk_screened','has_liability_document'].map(key => ({
    ...fact(key,'yes',['uploaded-field']), source: 'material' as const,
  }))]
  const calculation = calc(scopes())
  assert.equal(calculation.status,'complete')
  assert.ok(RiskValidator.check(materialFacts,calculation).includes('RISK_SCREENING_REQUIRED'))
})

test('validators detect tampering; context masks private data; parameters require effective legal refs', async () => {
  const f = await fixture(), document = await generate(f)
  await store.transaction(f.userId,f.caseId,(state,_sources,control) => {
    const calculation = state.calculations[0]
    assert.throws(() => OutputValidator.validate({...document, sections:[{title:'伪造金额',paragraphs:['赔偿999万元']}]},state,calculation),/DOCUMENT_TAMPERED/)
    assert.throws(() => OutputValidator.validate({...document,factRefs:['fabricated']},state,calculation),/INVALID_REFERENCE/)
    state.facts.push(fact('contact_phone','13812345678'),fact('name_note','证件110101199001011234'))
    const context = ContextBuilder.build(state)
    assert.ok(!JSON.stringify(context.displayFacts).includes('13812345678'))
    assert.ok(!JSON.stringify(context.displayFacts).includes('110101199001011234'))
    state.facts.find(f => f.key === 'accident_date')!.value = '2026-99-20'
    assert.throws(() => ContextBuilder.build(state),/ACCIDENT_DATE_REQUIRED/)
    control.parameters = [{id:'p',version:'v1',code:'meals_daily_cents',jurisdiction:'CN-ZJ-HZ',from:'2026-01-01',value:5000,legalRefs:['expired'],status:'approved',reviewedBy:'curated-source'}]
    assert.equal(applicableParameters(control,'2026-10-20','CN-ZJ-HZ').length,0)
  })
})

test('bounded retries need an explicit new revision after exhaustion', async () => {
  const f=await fixture(), now=Date.now(), run=await service.enqueue(f.userId,f.caseId,now)
  for(let attempt=0;attempt<3;attempt++){
    const claimed=await service.claim(f.userId,f.caseId,'failing-worker',now+attempt*10000);assert.ok(claimed)
    await service.fail(f.userId,f.caseId,run.runId,claimed.run.leaseToken!,now+attempt*10000+1)
  }
  assert.equal((await service.get(f.userId,f.caseId)).runs[0].status,'failed')
  assert.equal(await service.claim(f.userId,f.caseId,'worker',now+40000),null)
  const before=(await service.get(f.userId,f.caseId)).revision
  const retried=await service.retry(f.userId,f.caseId,run.runId)
  assert.equal((await service.get(f.userId,f.caseId)).revision,before+1)
  assert.notEqual(retried.runId,run.runId)
  assert.equal(retried.status,'queued')
  assert.equal((await service.get(f.userId,f.caseId)).runs.filter(item=>item.inputRevision===before+1&&item.status==='queued').length,1)
})

test('seed loading cannot restore revoked legal sources', async () => {
  await db.upsertLegalCorpus(coreTrafficLegalDocuments.map(d=>({...d,status:'repealed' as const,reviewStatus:'rejected' as const})),coreTrafficLegalSections)
  await db.upsertLegalCorpus(coreTrafficLegalDocuments,coreTrafficLegalSections,{insertOnly:true})
  const reference=(await db.getLegalReferences([coreTrafficLegalSections[0].legalRefId]))[0]
  assert.equal(reference.status,'repealed');assert.equal(reference.reviewStatus,'rejected')
  // Restore the fixture registry for later cases in this isolated test process.
  await db.upsertLegalCorpus(coreTrafficLegalDocuments,coreTrafficLegalSections)
})

test('JSONB object key normalization preserves fingerprints and approved publication', async () => {
  assert.equal(fingerprint({a:1,b:{c:2,d:3}}),fingerprint({b:{d:3,c:2},a:1}))
  const f=await fixture(), document=await generate(f)
  await store.transaction(f.userId,f.caseId,state=>{
    const reverse=(value:any):any=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverse(value[key])])):value
    Object.assign(state,reverse(JSON.parse(JSON.stringify(state))))
  })
  const confirmed=await service.confirm(f.userId,f.caseId,document.id)
  assert.equal(confirmed.status,'approved')
  assert.equal((await service.approved(f.userId,f.caseId,document.id)).status,'approved')
})

test('workflow HTTP contracts allow user confirmation without an internal lawyer queue', async () => {
  const {caseWorkflowRouter,harnessEnabled}=require('../src/harness/routes') as typeof import('../src/harness/routes')
  const f=await fixture()
  async function invoke(router:any,path:string,method:string,body:any={},params:any={},extra:any={}){
    const route=router.stack.find((item:any)=>item.route?.path===path&&item.route.methods[method]).route
    let status=200,payload:any
    const response={status(code:number){status=code;return this},json(value:any){payload=value;return this}}
    await route.stack[route.stack.length-1].handle({body,params,userId:f.userId,...extra},response,()=>undefined)
    return {status,...payload}
  }
  let gateStatus=0
  const gateResponse={status(code:number){gateStatus=code;return this},json(){return this}}
  const previous=process.env.HARNESS_ENABLED
  try{
    delete process.env.HARNESS_ENABLED
    harnessEnabled({} as any,gateResponse as any,()=>assert.fail('disabled feature passed'))
    assert.equal(gateStatus,503)
    process.env.HARNESS_ENABLED='true'
    const document=await generate(f)
    const confirmation=await invoke(caseWorkflowRouter,'/:caseId/documents/:documentId/confirm','post',{}, {caseId:f.caseId,documentId:document.id})
    assert.equal(confirmation.status,200)
    assert.equal(confirmation.data.status,'approved')
  }finally{if(previous===undefined)delete process.env.HARNESS_ENABLED;else process.env.HARNESS_ENABLED=previous}
})
