import assert from 'node:assert/strict'
import { test } from 'node:test'

// Run only against an explicitly selected disposable local test database, after migrations.
test('case workflow PostgreSQL persistence, leases, stale triggers and AI draft confirmation', {skip:process.env.WORKFLOW_POSTGRES_TEST !== '1',timeout:30000}, async () => {
  assert.equal(process.env.NODE_ENV,'test')
  assert.equal(process.env.DB_TYPE,'postgres')
  assert.match(process.env.POSTGRES_DB || '',/test/)
  assert.ok(['localhost','127.0.0.1','::1'].includes(process.env.POSTGRES_HOST || 'localhost'))
  const {db,pool} = await import('../src/db/postgres')
  const {WorkflowStore,id} = await import('../src/harness/store')
  const {HarnessService} = await import('../src/harness/service')
  const {coreTrafficLegalDocuments,coreTrafficLegalSections} = await import('../src/legal/core-traffic-law')
  const {expenseDefinitions} = await import('../src/harness/calculator')
  const store = new WorkflowStore(true), service = new HarnessService(store)
  const user = await db.createUser(`workflow-pg-${id()}`)
  try {
    await db.upsertLegalCorpus(coreTrafficLegalDocuments,coreTrafficLegalSections,{insertOnly:true})
    await store.control(c => {
      const version = {id:'compensation-v1',status:'approved' as const,legalRefs:['cn-civil-code-2021-art-1179'],reviewedBy:'curated-source'}
      const existing = c.calculators.find(v => v.id === version.id)
      if(existing)Object.assign(existing,version);else c.calculators.push(version)
    },'test-fixture')
    const item = await db.createCase(user.id,'PG workflow fixture')
    await pool.query("INSERT INTO case_entitlements(id,case_id,user_id,status,amount_cents) VALUES($1,$2,$3,'paid',4990)",[id(),item.id,user.id])
    await db.persistConfirmedFacts(user.id,item.id,[['accident_date','2026-10-20'],['jurisdiction','CN-ZJ-HZ'],...expenseDefinitions.map(d=>[`claim_${d.code}`,'no'])].map(([key,value])=>({key,label:key,value,source:'user_text'})))
    const run = await service.enqueue(user.id,item.id)
    assert.equal((await service.enqueue(user.id,item.id)).runId,run.runId)
    const claims = await Promise.all(Array.from({length:5},(_,i)=>service.claim(user.id,item.id,`worker-${i}`)))
    assert.equal(claims.filter(Boolean).length,1)
    const claimed = claims.find(Boolean)!
    await service.complete(user.id,item.id,run.runId,claimed.run.leaseToken!)
    const state = await new HarnessService(new WorkflowStore(true)).get(user.id,item.id)
    assert.equal(state.documents.length,3)
    // More concurrent reads than pool connections must still finish: commands must use
    // their transaction connection for references instead of borrowing another one.
    const workspaces = await Promise.all(Array.from({length:(pool.options.max || 20)+5},()=>service.get(user.id,item.id)))
    assert.ok(workspaces.every(workspace=>workspace.documents.length===3&&workspace.legalReferences.length>0))
    const report = state.documents.find(d=>d.type==='case_report')!
    const confirmed = await service.confirm(user.id,item.id,report.id)
    assert.equal(confirmed.status,'approved')
    assert.equal((await service.approved(user.id,item.id,report.id)).status,'approved')
    await pool.query("UPDATE case_entitlements SET status='refunded' WHERE case_id=$1",[item.id])
    await assert.rejects(service.approved(user.id,item.id,report.id),/PAYMENT_REQUIRED/)
    await pool.query("UPDATE case_entitlements SET status='paid' WHERE case_id=$1",[item.id])
    await store.control(c => {c.calculators.find(v=>v.id==='compensation-v1')!.status='retired'},admin)
    const stale = await pool.query('SELECT payload FROM document_versions WHERE id=$1',[report.id])
    assert.equal(stale.rows[0].payload.status,'stale')
    await assert.rejects(service.approved(user.id,item.id,report.id),/INPUT_STALE/)
  } finally {
    await pool.query('DELETE FROM users WHERE id=$1',[user.id])
    await pool.end()
  }
})
