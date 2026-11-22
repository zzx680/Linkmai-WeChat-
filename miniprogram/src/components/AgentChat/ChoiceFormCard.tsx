import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import type { ChoiceForm } from '../../services/api'
import './index.scss'

interface Props {
  form: ChoiceForm
  submitted?: boolean
  disabled?: boolean
  onSubmit?: (answers: Record<string, string>) => Promise<void>
}

export default function ChoiceFormCard({ form, submitted = false, disabled = false, onSubmit }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const locked = submitted || disabled || submitting
  const complete = form.questions.every(question => Boolean(answers[question.id]))

  const submit = async () => {
    if (locked || !complete || !onSubmit) return
    setSubmitting(true)
    try {
      await onSubmit(answers)
    } catch {
      setSubmitting(false)
    }
  }

  return <View className={`chat-choice-form${submitted ? ' is-submitted' : ''}`} role="form" aria-label={form.title}>
    <Text className="chat-choice-form-title">{form.title}</Text>
    {form.questions.map((question, questionIndex) => (
      <View key={question.id} className="chat-choice-question" role="radiogroup" aria-label={question.title}>
        <Text className="chat-choice-question-title">{questionIndex + 1}. {question.title}</Text>
        <View className="chat-choice-options">
          {question.options.map(option => {
            const selected = answers[question.id] === option
            return <View
              key={option}
              className={`chat-choice-option${selected ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`}
              role="radio"
              aria-checked={selected}
              onClick={() => {
                if (!locked) setAnswers(previous => ({ ...previous, [question.id]: option }))
              }}
            >
              <View className="chat-choice-radio">{selected && <View className="chat-choice-radio-dot" />}</View>
              <Text className="chat-choice-option-label">{option}</Text>
            </View>
          })}
        </View>
      </View>
    ))}
    <Button className="chat-choice-submit" disabled={locked || !complete || !onSubmit} loading={submitting} onClick={submit}>
      {submitted ? '已提交' : submitting ? '提交中…' : '提交选择'}
    </Button>
  </View>
}
