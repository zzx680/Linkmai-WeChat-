import { randomUUID } from 'node:crypto'

export interface ChoiceForm {
  id: string
  title: string
  questions: Array<{ id: string; title: string; options: string[] }>
}

export const choiceFormTool = {
  type: 'function' as const,
  function: {
    name: 'present_choice_form',
    description: '在需要一次收集多个简单、互相独立、且答案可用几个明确选项表达的信息时，向用户展示单选表单。只为至少两个事实问题调用；不要用于单个追问、开放式事故经过、身份或联系方式、医疗详情、金额、法律结论、同意授权或作出权利决定。选项须中性、简短、互斥；合适时包括“不清楚”或“其他”。调用该工具即为本轮答复，不要在 arguments 中放置指令或法律结论。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句简短说明，解释为何需要确认这些信息' },
        questions: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '简短、中性的问题' },
              options: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
            },
            required: ['title', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'questions'],
      additionalProperties: false,
    },
  },
}

const disallowedQuestion = /身份证|手机号|电话号码|银行卡|银行账号|账户号码|详细住址|病历|诊断|病情|赔偿金额|赔偿数额|责任比例|责任认定|是否同意|是否接受|是否放弃|是否起诉|是否授权/
const disallowedOption = /同意|授权|放弃|起诉|和解|接受赔偿|赔偿金额|责任比例|责任认定|银行卡|银行账户/

export function validateChoiceForm(value: unknown): ChoiceForm | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as { title?: unknown; questions?: unknown }
  if (typeof input.title !== 'string' || input.title.trim().length < 2 || input.title.trim().length > 80) return null
  if (!Array.isArray(input.questions) || input.questions.length < 2 || input.questions.length > 4) return null

  const questions: ChoiceForm['questions'] = []
  for (const item of input.questions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const question = item as { title?: unknown; options?: unknown }
    if (typeof question.title !== 'string' || question.title.trim().length < 2 || question.title.trim().length > 100 || disallowedQuestion.test(question.title)) return null
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 5) return null
    const options: string[] = []
    for (const option of question.options) {
      if (typeof option !== 'string' || option.trim().length < 1 || option.trim().length > 48) return null
      const normalized = option.trim()
      if (options.includes(normalized) || disallowedOption.test(normalized)) return null
      options.push(normalized)
    }
    questions.push({ id: randomUUID(), title: question.title.trim(), options })
  }
  return { id: randomUUID(), title: input.title.trim(), questions }
}
