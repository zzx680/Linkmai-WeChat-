import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { harness } from './service'
import { expenseDefinitions } from './calculator'
import { deliverReportNotificationForRun, linkReportNotificationToRun } from '../services/report-notifications'

export function harnessEnabled(_req: Request, res: Response, next: NextFunction) {
  if (process.env.HARNESS_ENABLED !== 'true') return res.status(503).json({ success: false, error: '案件处理流程暂未启用' })
  next()
}
const identifier = z.string().min(1).max(160)
const candidate = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/), label: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(3000), evidenceRefs: z.array(identifier).max(20).default([]) }).strict()
const codeMessage: Record<string,string> = {
  CASE_NOT_FOUND: '案件不存在', PAYMENT_REQUIRED: '请先解锁本案件', FACT_CONFLICT: '请先解决事实冲突', FACTS_REQUIRED: '请先确认事故事实',
  FACT_CONFIRMATION_REQUIRED: '请先确认或拒绝待确认信息，再重新生成当前版本',
  ACCIDENT_DATE_REQUIRED: '请确认 YYYY-MM-DD 格式的事故日期', JURISDICTION_REQUIRED: '请确认事故地区代码',
  CALCULATOR_NOT_APPROVED: '处理规则暂不可用', INPUT_STALE: '案件输入或规则已更新，请刷新并重新生成',
  DOCUMENT_NOT_APPROVED: '内容尚未完成确认',
  WORKFLOW_PAUSED: '当前暂停新分析，请稍后再试',
}
function endpoint(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try { res.json({ success: true, data: await fn(req) }) }
    catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ success: false, error: '输入格式无效' }); return }
      const code = error instanceof Error ? error.message : 'INTERNAL_ERROR'
      const status = !/^[A-Z_]{1,100}$/.test(code) ? 500 : code === 'CASE_NOT_FOUND' || code.endsWith('_NOT_FOUND') ? 404 : code === 'PAYMENT_REQUIRED' ? 402
        : code.endsWith('_NOT_CONFIGURED') ? 503
          : /INVALID_|REQUIRED|NOT_PROPOSED/.test(code) ? 400 : 409
      res.status(status).json({ success: false, error: codeMessage[code] || '操作未完成，请核对当前状态后重试', code: /^[A-Z_]{1,100}$/.test(code) ? code : 'WORKFLOW_FAILED' })
    }
  }
}
const param = (req: Request, name: string) => identifier.parse(req.params[name])
const user = (req: Request) => identifier.parse(req.userId)
export const caseWorkflowRouter = Router()
caseWorkflowRouter.use(harnessEnabled)
caseWorkflowRouter.get('/:caseId/workspace', endpoint(req => harness.get(user(req), param(req,'caseId'))))
caseWorkflowRouter.get('/:caseId/calculator-fields', endpoint(async req => {
  await harness.get(user(req), param(req,'caseId')); return expenseDefinitions
}))
caseWorkflowRouter.post('/:caseId/facts', endpoint(req => harness.propose(user(req), param(req,'caseId'), candidate.parse(req.body))))
caseWorkflowRouter.post('/:caseId/claims/:candidateId/accept', endpoint(req => {
  const input = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).optional() }).strict().parse(req.body || {})
  return harness.acceptClaim(user(req), param(req,'caseId'), param(req,'candidateId'), input.key)
}))
caseWorkflowRouter.post('/:caseId/facts/:factId/:decision', endpoint(req => harness.decideFact(user(req), param(req,'caseId'), param(req,'factId'), z.enum(['confirm','reject']).parse(req.params.decision))))
caseWorkflowRouter.post('/:caseId/conflicts/:conflictId/resolve', endpoint(req => harness.resolve(user(req), param(req,'caseId'), param(req,'conflictId'), z.object({ factId: identifier }).strict().parse(req.body).factId)))
caseWorkflowRouter.post('/:caseId/calculations', endpoint(req => harness.calculate(user(req), param(req,'caseId'))))
caseWorkflowRouter.post('/:caseId/documents/drafts', endpoint(async req => {
  const userId = user(req)
  const caseId = param(req,'caseId')
  const run = await harness.enqueue(userId, caseId)
  const subscriptionId = req.body?.notificationSubscriptionId
  if (typeof subscriptionId === 'string' && subscriptionId.length <= 64) {
    await linkReportNotificationToRun(subscriptionId, userId, caseId, run.runId)
    try {
      const workspace = await harness.get(userId, caseId)
      if (workspace.runs.some(item => item.id === run.runId && item.status === 'succeeded')) {
        await deliverReportNotificationForRun(run.runId)
      }
    } catch {
      // The report run remains valid if optional notification reconciliation is unavailable.
    }
  }
  return run
}))
caseWorkflowRouter.post('/:caseId/runs/:runId/retry', endpoint(req => harness.retry(user(req), param(req,'caseId'), param(req,'runId'))))
caseWorkflowRouter.post('/:caseId/documents/:documentId/confirm', endpoint(req => harness.confirm(user(req), param(req,'caseId'), param(req,'documentId'))))
caseWorkflowRouter.get('/:caseId/documents/:documentId/approved', endpoint(req => harness.approved(user(req), param(req,'caseId'), param(req,'documentId'))))
