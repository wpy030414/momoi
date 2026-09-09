import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Send, Check } from 'lucide-react'
import type { AskUserQuestion } from '@/shared/types'

interface QuestionBarProps {
  questions: AskUserQuestion[]
  onAnswer: (answer: string, selectedOptions?: string[]) => void
  onSkip: () => void
}

export function QuestionBar({ questions, onAnswer, onSkip }: QuestionBarProps) {
  const { t } = useTranslation()
  const [selectedOptions, setSelectedOptions] = useState<Record<number, string[]>>({})
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = () => {
    const allSelected: string[] = []
    for (const q of questions) {
      const idx = questions.indexOf(q)
      const sel = selectedOptions[idx] || []
      if (sel.length > 0) allSelected.push(...sel)
    }
    const answer = allSelected.length > 0
      ? allSelected.join(', ')
      : freeText.trim()

    if (!answer) return
    setSubmitting(true)
    onAnswer(answer, allSelected.length > 0 ? allSelected : undefined)
  }

  const handleSkip = () => {
    setSubmitting(true)
    onSkip()
  }

  const toggleOption = (questionIdx: number, optionLabel: string, multiSelect: boolean) => {
    setSelectedOptions((prev) => {
      const current = prev[questionIdx] || []
      if (multiSelect) {
        if (current.includes(optionLabel)) {
          return { ...prev, [questionIdx]: current.filter((o) => o !== optionLabel) }
        }
        return { ...prev, [questionIdx]: [...current, optionLabel] }
      }
      return { ...prev, [questionIdx]: [optionLabel] }
    })
  }

  const hasSelection = Object.values(selectedOptions).some((s) => s.length > 0)
  const canSubmit = hasSelection || freeText.trim().length > 0

  return (
    <div className="border-t bg-card/80 backdrop-blur-sm px-4 py-3 animate-slide-up">
      <div className="max-w-3xl mx-auto">
        {questions.map((q, qi) => (
          <div key={qi} className="mb-3 last:mb-0">
            {/* Header chip */}
            {q.header && (
              <span className="inline-block text-xs font-medium bg-primary/10 text-primary rounded-full px-2 py-0.5 mb-1.5">
                {q.header}
              </span>
            )}

            {/* Question text */}
            <p className="text-sm font-medium text-foreground mb-2">{q.question}</p>

            {/* Options */}
            {q.options && q.options.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {q.options.map((opt, oi) => {
                  const isSelected = (selectedOptions[qi] || []).includes(opt.label)
                  return (
                    <button
                      key={oi}
                      onClick={() => toggleOption(qi, opt.label, q.multiSelect)}
                      disabled={submitting}
                      className={`
                        inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm
                        border transition-colors
                        ${isSelected
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card text-foreground border-border hover:border-primary/50 hover:bg-accent'
                        }
                        ${submitting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                      `}
                      title={opt.description}
                    >
                      {isSelected && q.multiSelect && <Check className="h-3 w-3" />}
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Free-form input */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder={t('chat.askUser.placeholder', '输入你的回答...')}
                disabled={submitting}
                className="flex-1 bg-background border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) handleSubmit()
                }}
              />
            </div>
          </div>
        ))}

        {/* Action buttons */}
        <div className="flex items-center justify-between mt-3">
          <button
            onClick={handleSkip}
            disabled={submitting}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            {t('chat.askUser.skip', '跳过')}
          </button>

          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            {t('chat.askUser.submit', '提交')}
          </button>
        </div>
      </div>
    </div>
  )
}