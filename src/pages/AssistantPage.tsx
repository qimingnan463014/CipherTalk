import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, CalendarRange, ClipboardCopy, Filter, ListTodo, Search, Send, Sparkles, ArrowLeft, FileDown } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useChatStore } from '../stores/chatStore'
import { useAssistantStore } from '../stores/assistantStore'
import { getAiEnableThinking, getAiModel, getAiProvider, getAiProviderConfig } from '../services/config'
import { getAIProviders } from '../types/ai'
import DataFilterPanel from '../components/Assistant/DataFilterPanel'

import type { AssistantMessage } from '../types/assistant'
import './AssistantPage.scss'

type SearchIntent = {
  keyword: string
  startTime?: number
  endTime?: number
  summary: string
}

type SearchResultPayload = {
  messageId: number
  talkerId: string
  content: string
  timestamp: number
  senderUsername?: string | null
  isSend?: number | null
}

type SearchParseResult = {
  keyword: string
  startDate?: string
  endDate?: string
  summary?: string
}

type AssistantTimeRange = {
  type: 'today' | 'last_days' | 'range' | 'all'
  value?: number
  startDate?: string
  endDate?: string
}

type AssistantIntent = {
  intent: 'search' | 'report' | 'export' | 'none'
  timeRange?: AssistantTimeRange
  keywords?: string[]
  scope?: 'all' | 'whitelist' | 'blacklist'
  needContext?: boolean
}

const assistantReportPrompt = `你是 CipherTalk 的个人业务助理，擅长从聊天记录中提炼关键信息、输出日报总结、列出待办与风险提醒。请始终使用中文输出，结构清晰，优先使用要点列表与表格。`
const assistantIntentPrompt = `你是 CipherTalk 的自然语言控制器。请根据用户的一句话判断意图，只输出 JSON，不要添加解释或 Markdown。\n\nJSON 字段说明：\n- intent: search | report | export | none\n- timeRange: 可选，{ "type": "today" | "last_days" | "range" | "all", "value": number, "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }\n- keywords: 可选，搜索关键词数组\n- scope: 可选，all | whitelist | blacklist\n- needContext: 可选，是否需要上下文\n\n示例：\n用户输入：近一个月我和谁转过账？\n返回：{"intent":"search","timeRange":{"type":"last_days","value":30},"keywords":["转账"],"scope":"all","needContext":true}`
const reportRangeStorageKey = 'assistant-report-range'

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10)
}

function formatTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString()
}

function buildDailyPrompt(dateRangeLabel: string, messages: AssistantMessage[], sessionNameMap: Map<string, string>) {
  const lines = messages.map((msg) => {
    const sessionName = sessionNameMap.get(msg.sessionId) || msg.sessionId
    const sender = msg.senderUsername || (msg.isSend ? '我' : sessionName)
    const content = msg.parsedContent || msg.rawContent
    return `[${formatTime(msg.createTime)}] ${sessionName} · ${sender}: ${content}`
  })

  const historyText = lines.length > 0 ? lines.join('\n') : '（该时段未检索到可用聊天记录）'

  return `你是我的个人业务助理，请根据以下聊天记录生成【${dateRangeLabel}】的工作日报，并输出：\n\n1. 今日关键进展（按客户/项目/群组归类）\n2. 重要决策/结论\n3. 待办清单（包含负责人、截止时间，如未明确则标注待确认）\n4. 风险/异常点与需要跟进的问题\n\n要求：\n- 只基于记录事实，不要臆测\n- 无价值寒暄可忽略\n- 输出清晰的标题与列表\n\n聊天记录：\n${historyText}`
}

function resolveRelativeRange(query: string) {
  const rangePatterns = [
    { regex: /(最近|近)一年|一年内/, days: 365, label: '最近一年' },
    { regex: /(最近|近)半年|半年内/, days: 182, label: '最近半年' },
    { regex: /(最近|近)(三|3)个月|(三|3)个月内/, days: 90, label: '最近三个月' },
    { regex: /(最近|近)(两|2)个月|(两|2)个月内/, days: 60, label: '最近两个月' },
    { regex: /(最近|近)(一|1)个月|(一|1)个月内/, days: 30, label: '最近一个月' },
    { regex: /(最近|近)一周|(最近|近)7天/, days: 7, label: '最近一周' },
    { regex: /(最近|近)30天/, days: 30, label: '最近30天' },
    { regex: /(最近|近)90天/, days: 90, label: '最近90天' },
    { regex: /(最近|近)180天/, days: 180, label: '最近180天' }
  ]

  for (const pattern of rangePatterns) {
    if (pattern.regex.test(query)) {
      const endTime = Math.floor(Date.now() / 1000)
      const startTime = endTime - pattern.days * 24 * 60 * 60
      return { startTime, endTime, label: pattern.label }
    }
  }

  return null
}

function normalizeSearchKeyword(query: string) {
  const keywords = ['转账', '交易', '付款', '打款', '汇款', '收款', '对账', '发票', '合同', '报价', '欠款', '报销', '退款', '物流', '发货', '签约', '开票']
  const matched = keywords.filter(keyword => query.includes(keyword))
  if (matched.length > 0) {
    return Array.from(new Set(matched)).join(' ')
  }

  const stripped = query
    .replace(/(最近|近)(一年|半年|三个月|两个月|一个月|一周|7天|30天|90天|180天)/g, '')
    .replace(/(所有|全部|相关|有关|关于|的)?(聊天记录|消息|记录)/g, '')
    .replace(/(显示|查找|搜索|查询|帮我|帮忙|列出|获取|看看)/g, '')
    .trim()

  return stripped
}

function extractJsonBlock(content: string) {
  const match = content.match(/\{[\s\S]*\}/)
  return match ? match[0] : ''
}

function getDefaultReportRange() {
  const endDate = new Date()
  const startDate = new Date(endDate)
  return {
    startDate: formatDateInput(startDate),
    endDate: formatDateInput(endDate)
  }
}

function loadReportRange() {
  try {
    const raw = localStorage.getItem(reportRangeStorageKey)
    if (raw) {
      const parsed = JSON.parse(raw) as { startDate?: string; endDate?: string }
      if (parsed.startDate && parsed.endDate) {
        return { startDate: parsed.startDate, endDate: parsed.endDate }
      }
    }
  } catch (error) {
    console.warn('读取日报日期范围失败:', error)
  }
  return getDefaultReportRange()
}

function detectSearchIntent(query: string): SearchIntent | null {
  const cleaned = query.trim()
  if (!cleaned) return null

  const mentionsMessages = /(聊天记录|消息|记录)/.test(cleaned)
  const mentionsSearch = /(搜索|查找|查询|显示|列出|获取|看看)/.test(cleaned)
  if (!mentionsMessages && !mentionsSearch) return null

  const keyword = normalizeSearchKeyword(cleaned)
  if (!keyword) return null

  const range = resolveRelativeRange(cleaned)
  const summaryParts = [`关键词「${keyword}」`]
  if (range?.label) summaryParts.push(range.label)

  return {
    keyword,
    startTime: range?.startTime,
    endTime: range?.endTime,
    summary: summaryParts.join(' · ')
  }
}

function resolveIntentDateRange(intentRange?: AssistantTimeRange, fallbackQuery?: string) {
  if (intentRange?.type === 'today') {
    const today = formatDateInput(new Date())
    return { startDate: today, endDate: today, label: '今天' }
  }
  if (intentRange?.type === 'last_days' && intentRange.value) {
    const days = Math.max(1, intentRange.value)
    const endDate = new Date()
    const startDate = new Date(endDate)
    startDate.setDate(endDate.getDate() - (days - 1))
    return {
      startDate: formatDateInput(startDate),
      endDate: formatDateInput(endDate),
      label: `最近${days}天`
    }
  }
  if (intentRange?.type === 'range' && intentRange.startDate && intentRange.endDate) {
    return {
      startDate: intentRange.startDate,
      endDate: intentRange.endDate,
      label: `${intentRange.startDate} 至 ${intentRange.endDate}`
    }
  }
  if (intentRange?.type === 'all') {
    return { label: '全部时间' }
  }
  if (fallbackQuery) {
    const resolved = resolveRelativeRange(fallbackQuery)
    if (resolved?.startTime && resolved?.endTime) {
      return {
        startDate: formatDateInput(new Date(resolved.startTime * 1000)),
        endDate: formatDateInput(new Date(resolved.endTime * 1000)),
        label: resolved.label
      }
    }
  }
  return {}
}

function AssistantPage() {
  const navigate = useNavigate()
  const { sessions, setSessions } = useChatStore()
  const { filterMode, selectedSessionIds } = useAssistantStore()

  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchResults, setSearchResults] = useState<AssistantMessage[]>([])
  const [searchParsed, setSearchParsed] = useState<SearchParseResult | null>(null)

  const initialReportRange = useMemo(() => loadReportRange(), [])
  const [reportStartDate, setReportStartDate] = useState(initialReportRange.startDate)
  const [reportEndDate, setReportEndDate] = useState(initialReportRange.endDate)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportMessages, setReportMessages] = useState<AssistantMessage[]>([])
  const [reportPrompt, setReportPrompt] = useState('')
  const [reportError, setReportError] = useState('')
  const [reportStats, setReportStats] = useState<{ messageCount: number | null; sessionCount: number | null }>({
    messageCount: null,
    sessionCount: null
  })

  const [assistantInput, setAssistantInput] = useState('')
  const [assistantTaskError, setAssistantTaskError] = useState('')
  const [assistantTaskLoading, setAssistantTaskLoading] = useState(false)
  const [assistantTaskSummary, setAssistantTaskSummary] = useState('')
  const [assistantIntentJson, setAssistantIntentJson] = useState<AssistantIntent | null>(null)
  const [assistantReportOutput, setAssistantReportOutput] = useState('')
  const assistantInputRef = useRef<HTMLTextAreaElement | null>(null)

  const [assistantSearchResults, setAssistantSearchResults] = useState<SearchResultPayload[]>([])
  const [assistantSearchLoading, setAssistantSearchLoading] = useState(false)
  const [assistantSearchError, setAssistantSearchError] = useState('')
  const [assistantSearchSummary, setAssistantSearchSummary] = useState('')
  const [highlightedResult, setHighlightedResult] = useState<string | null>(null)

  const [aiProviderName, setAiProviderName] = useState('')
  const [aiModelName, setAiModelName] = useState('')
  const [aiProviderId, setAiProviderId] = useState('')
  const [enableThinking, setEnableThinking] = useState(true)
  const [ollamaModelName, setOllamaModelName] = useState('')

  useEffect(() => {
    let cancelled = false
    const loadSessions = async () => {
      if (sessions.length > 0) return
      const connectResult = await window.electronAPI.chat.connect()
      if (!connectResult.success) return
      const result = await window.electronAPI.chat.getSessions()
      if (!cancelled && result.success && result.sessions) {
        setSessions(result.sessions)
      }
    }
    loadSessions().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessions.length, setSessions])

  useEffect(() => {
    const loadProvider = async () => {
      const providerId = await getAiProvider()
      const modelName = await getAiModel()
      const providers = await getAIProviders()
      const provider = providers.find(p => p.id === providerId)
      const ollamaConfig = await getAiProviderConfig('ollama')
      const ollamaProvider = providers.find(p => p.id === 'ollama')
      setAiProviderId(providerId)
      setAiProviderName(provider?.displayName || providerId)
      setAiModelName(modelName || provider?.models?.[0] || '')
      setOllamaModelName(ollamaConfig?.model || ollamaProvider?.models?.[0] || 'qwen2.5:latest')
    }

    const loadThinkingSetting = async () => {
      const enabled = await getAiEnableThinking()
      setEnableThinking(enabled)
    }

    loadProvider()
    loadThinkingSetting()
  }, [])
  const sessionNameMap = useMemo(() => {
    return new Map(sessions.map((session) => [session.username, session.displayName || session.username]))
  }, [sessions])

  const isGroupChat = (sessionId: string) => sessionId.includes('@chatroom')
  const getSessionTypeLabel = (sessionId: string) => (isGroupChat(sessionId) ? '群聊' : '私聊')

  useEffect(() => {
    localStorage.setItem(reportRangeStorageKey, JSON.stringify({
      startDate: reportStartDate,
      endDate: reportEndDate
    }))
  }, [reportStartDate, reportEndDate])

  const resolveSessionFilterPayload = () => {
    if (filterMode === 'whitelist') {
      return { sessionIds: selectedSessionIds }
    }
    if (filterMode === 'blacklist') {
      return { excludeSessionIds: selectedSessionIds }
    }
    return {}
  }

  const parseSearchQueryWithAi = async (query: string) => {
    let content = ''
    const cleanup = window.electronAPI.ai.onAssistantChunk((chunk) => {
      content += chunk
    })

    const result = await window.electronAPI.ai.assistantChat({
      messages: [
        { role: 'system', content: assistantIntentPrompt },
        { role: 'user', content: query }
      ],
      options: {
        provider: 'ollama',
        model: ollamaModelName,
        temperature: 0,
        maxTokens: 300,
        enableThinking: false,
        disableTools: true
      }
    })

    cleanup()

    if (!result.success) {
      throw new Error(result.error || '智能解析失败')
    }

    const jsonBlock = extractJsonBlock(content)
    if (!jsonBlock) {
      throw new Error('未能解析搜索指令')
    }

    const parsed = JSON.parse(jsonBlock) as AssistantIntent
    const resolvedRange = resolveIntentDateRange(parsed.timeRange)
    return {
      keyword: (parsed.keywords || []).join(' ').trim(),
      startDate: parsed.timeRange?.startDate || resolvedRange.startDate,
      endDate: parsed.timeRange?.endDate || resolvedRange.endDate,
      summary: parsed.intent ? `意图：${parsed.intent}` : undefined
    }
  }

  const parseAssistantIntent = async (query: string) => {
    let content = ''
    const cleanup = window.electronAPI.ai.onAssistantChunk((chunk) => {
      content += chunk
    })

    const result = await window.electronAPI.ai.assistantChat({
      messages: [
        { role: 'system', content: assistantIntentPrompt },
        { role: 'user', content: query }
      ],
      options: {
        provider: 'ollama',
        model: ollamaModelName,
        temperature: 0,
        maxTokens: 200,
        enableThinking: false,
        disableTools: true
      }
    })

    cleanup()

    if (!result.success) {
      throw new Error(result.error || '意图识别失败')
    }

    const jsonBlock = extractJsonBlock(content)
    if (!jsonBlock) {
      throw new Error('未能识别指令')
    }

    return JSON.parse(jsonBlock) as AssistantIntent
  }

  const resolveSearchPayload = async () => {
    const query = searchKeyword.trim()
    if (!query) {
      setSearchError('请输入搜索内容后再试')
      return null
    }

    setSearchError('')
    setSearchParsed(null)

    try {
      const parsed = await parseSearchQueryWithAi(query)
      const keyword = parsed.keyword?.trim() || normalizeSearchKeyword(query)
      const fallbackIntent = detectSearchIntent(query)
      const startDate = parsed.startDate || (fallbackIntent?.startTime ? formatDateInput(new Date(fallbackIntent.startTime * 1000)) : undefined)
      const endDate = parsed.endDate || (fallbackIntent?.endTime ? formatDateInput(new Date(fallbackIntent.endTime * 1000)) : undefined)
      const summaryParts = []
      if (keyword) summaryParts.push(`关键词「${keyword}」`)
      if (startDate || endDate) summaryParts.push(`${startDate || '不限'} 至 ${endDate || '不限'}`)
      const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : (parsed.summary || fallbackIntent?.summary)

      const normalized: SearchParseResult = {
        keyword,
        startDate,
        endDate,
        summary
      }

      setSearchParsed(normalized)

      return normalized
    } catch (error) {
      const fallbackIntent = detectSearchIntent(query)
      if (fallbackIntent) {
        const fallbackParsed: SearchParseResult = {
          keyword: fallbackIntent.keyword,
          startDate: fallbackIntent.startTime ? formatDateInput(new Date(fallbackIntent.startTime * 1000)) : undefined,
          endDate: fallbackIntent.endTime ? formatDateInput(new Date(fallbackIntent.endTime * 1000)) : undefined,
          summary: fallbackIntent.summary
        }
        setSearchParsed(fallbackParsed)
        return fallbackParsed
      }

      setSearchError(error instanceof Error ? error.message : '智能解析失败')
      return null
    }
  }

  const handleGlobalSearch = async () => {
    setSearchLoading(true)
    setSearchResults([])

    const parsed = await resolveSearchPayload()
    if (!parsed?.keyword) {
      setSearchLoading(false)
      setSearchError('未识别到有效关键词，请补充说明')
      return
    }

    const startTime = parsed.startDate ? Math.floor(new Date(`${parsed.startDate}T00:00:00`).getTime() / 1000) : undefined
    const endTime = parsed.endDate ? Math.floor(new Date(`${parsed.endDate}T23:59:59`).getTime() / 1000) : undefined

    try {
      const result = await window.electronAPI.chat.searchGlobalMessages({
        keyword: parsed.keyword,
        startTime,
        endTime,
        limit: 1000,
        ...resolveSessionFilterPayload()
      })

      if (!result.success) {
        setSearchError(result.error || '搜索失败，请重试')
        setSearchResults([])
        return
      }

      setSearchResults(result.results || [])
    } catch (e) {
      setSearchError('搜索过程中发生异常')
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }

  const runAssistantSearch = async (intent: SearchIntent) => {
    setAssistantSearchLoading(true)
    setAssistantSearchError('')
    setAssistantSearchSummary(intent.summary)

    try {
      const result = await window.electronAPI.chat.searchGlobalMessages({
        keyword: intent.keyword,
        startTime: intent.startTime,
        endTime: intent.endTime,
        limit: 1000,
        ...resolveSessionFilterPayload()
      })

      if (!result.success) {
        setAssistantSearchError(result.error || '检索失败，请重试')
        setAssistantSearchResults([])
        return []
      }

      const resolvedResults = (result.results || []).map(item => ({
        messageId: item.localId,
        talkerId: item.sessionId,
        content: item.parsedContent || item.rawContent,
        timestamp: item.createTime,
        senderUsername: item.senderUsername,
        isSend: item.isSend
      }))
      setAssistantSearchResults(resolvedResults)
      setAssistantSearchSummary(`${intent.summary} · ${resolvedResults.length} 条`)
      return resolvedResults
    } catch (e) {
      setAssistantSearchError('检索过程中发生异常')
      setAssistantSearchResults([])
      return []
    } finally {
      setAssistantSearchLoading(false)
    }
  }

  const handleCopyPrompt = async () => {
    if (!reportPrompt) return
    try {
      await navigator.clipboard.writeText(reportPrompt)
    } catch (e) {
      console.error('复制失败:', e)
    }
  }

  const handleUsePrompt = () => {
    if (!reportPrompt) return
    setAssistantInput(reportPrompt)
    assistantInputRef.current?.focus()
  }

  const handleCopyReport = async () => {
    if (!assistantReportOutput.trim()) return
    const html = DOMPurify.sanitize(marked.parse(assistantReportOutput || ''))
    const temp = document.createElement('div')
    temp.innerHTML = html
    const plainText = temp.textContent || ''
    try {
      await navigator.clipboard.writeText(plainText)
    } catch (error) {
      console.error('复制失败:', error)
    }
  }

  const handleExportReport = () => {
    if (!assistantReportOutput.trim()) return
    const html = DOMPurify.sanitize(marked.parse(assistantReportOutput || ''))
    const temp = document.createElement('div')
    temp.innerHTML = html
    const plainText = temp.textContent || ''
    const blob = new Blob([plainText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `日报-${formatDateInput(new Date())}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleResultJump = (result: { talkerId: string; messageId: number }) => {
    const key = `${result.talkerId}-${result.messageId}`
    setHighlightedResult(key)
    window.electronAPI.chat.jumpToMessage({ talkerId: result.talkerId, messageId: result.messageId })
    setTimeout(() => {
      setHighlightedResult(prev => (prev === key ? null : prev))
    }, 2000)
  }

  const transcribeVoiceMessages = async (messages: AssistantMessage[]) => {
    const updatedMessages = messages.map(msg => ({ ...msg }))
    const voiceMessages = updatedMessages.filter(msg => msg.localType === 34 && !msg.parsedContent?.trim())
    if (voiceMessages.length === 0) return updatedMessages

    const concurrency = 3
    const transcribeOne = async (msg: AssistantMessage) => {
      const cached = await window.electronAPI.stt.getCachedTranscript(msg.sessionId, msg.createTime)
      if (cached.success && cached.transcript) {
        msg.parsedContent = cached.transcript
        return
      }

      const voiceData = await window.electronAPI.chat.getVoiceData(msg.sessionId, String(msg.localId), msg.createTime)
      if (!voiceData.success || !voiceData.data) return

      const transcribeResult = await window.electronAPI.stt.transcribe(
        voiceData.data,
        msg.sessionId,
        msg.createTime,
        false
      )

      if (transcribeResult.success && transcribeResult.transcript) {
        msg.parsedContent = transcribeResult.transcript
      }
    }

    for (let i = 0; i < voiceMessages.length; i += concurrency) {
      const batch = voiceMessages.slice(i, i + concurrency)
      await Promise.all(batch.map(msg => transcribeOne(msg)))
    }

    return updatedMessages
  }

  const generateReportForRange = async (startDate: string, endDate: string, options?: { fillInput?: boolean }) => {
    if (!startDate || !endDate) {
      setReportError('请先选择完整的日期范围')
      return null
    }

    const rangeStart = new Date(`${startDate}T00:00:00`)
    const rangeEnd = new Date(`${endDate}T23:59:59`)
    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
      setReportError('日期格式不正确，请重新选择')
      return null
    }

    if (rangeStart.getTime() > rangeEnd.getTime()) {
      setReportError('开始日期不能晚于结束日期')
      return null
    }

    setReportLoading(true)
    setReportError('')

    try {
      const startTime = Math.floor(rangeStart.getTime() / 1000)
      const endTime = Math.floor(rangeEnd.getTime() / 1000)

      const result = await window.electronAPI.chat.getMessagesInRange({
        startTime,
        endTime,
        limit: 5000,
        ...resolveSessionFilterPayload()
      })

      if (!result.success) {
        setReportError(result.error || '提取失败，请重试')
        setReportMessages([])
        setReportPrompt('')
        setReportStats({ messageCount: null, sessionCount: null })
        return null
      }

      const messages = await transcribeVoiceMessages(result.messages || [])
      const uniqueSessions = new Set(messages.map(msg => msg.sessionId))
      setReportMessages(messages)
      setReportStats({ messageCount: messages.length, sessionCount: uniqueSessions.size })
      const rangeLabel = startDate === endDate ? startDate : `${startDate} - ${endDate}`
      const prompt = buildDailyPrompt(rangeLabel, messages, sessionNameMap)
      setReportPrompt(prompt)
      if (options?.fillInput) {
        setAssistantInput(prompt)
        assistantInputRef.current?.focus()
      }
      return prompt
    } catch (e) {
      setReportError('提取过程中发生异常')
      setReportMessages([])
      setReportPrompt('')
      setReportStats({ messageCount: null, sessionCount: null })
      return null
    } finally {
      setReportLoading(false)
    }
  }

  const handleGenerateReport = async () => {
    await generateReportForRange(reportStartDate, reportEndDate, { fillInput: true })
  }

  const runReportOutput = async (prompt: string) => {
    setAssistantReportOutput('')
    setAssistantTaskError('')

    let content = ''
    const cleanup = window.electronAPI.ai.onAssistantChunk((chunk) => {
      content += chunk
      setAssistantReportOutput(prev => prev + chunk)
    })

    try {
      const result = await window.electronAPI.ai.assistantChat({
        messages: [
          { role: 'system', content: assistantReportPrompt },
          { role: 'user', content: prompt }
        ],
        options: {
          provider: aiProviderId,
          model: aiModelName,
          enableThinking,
          disableTools: true
        }
      })

      if (!result.success) {
        setAssistantTaskError(result.error || '日报生成失败')
      }
    } catch (e) {
      setAssistantTaskError('日报生成失败')
    } finally {
      cleanup()
    }
  }

  const handleSendReportPrompt = async () => {
    if (!reportPrompt || assistantTaskLoading) return
    setAssistantTaskLoading(true)
    try {
      await runReportOutput(reportPrompt)
    } finally {
      setAssistantTaskLoading(false)
    }
  }

  const handleRunAssistantTask = async () => {
    const query = assistantInput.trim()
    if (!query || assistantTaskLoading) return

    setAssistantTaskLoading(true)
    setAssistantTaskError('')
    setAssistantTaskSummary('')
    setAssistantIntentJson(null)
    setAssistantSearchResults([])
    setAssistantSearchSummary('')
    setAssistantSearchError('')
    setAssistantReportOutput('')

    try {
      let intent = await parseAssistantIntent(query)
      if (!intent?.intent) {
        intent = { intent: 'none' }
      }

      const fallbackSearch = detectSearchIntent(query)
      if (intent.intent === 'none' && fallbackSearch) {
        intent = {
          intent: 'search',
          keywords: [fallbackSearch.keyword],
          timeRange: fallbackSearch.startTime && fallbackSearch.endTime
            ? {
              type: 'range',
              startDate: formatDateInput(new Date(fallbackSearch.startTime * 1000)),
              endDate: formatDateInput(new Date(fallbackSearch.endTime * 1000))
            }
            : undefined
        }
      }

      setAssistantIntentJson(intent)

      if (intent.intent === 'search') {
        const keyword = (intent.keywords || []).join(' ').trim() || normalizeSearchKeyword(query)
        if (!keyword) {
          setAssistantTaskError('未识别到有效关键词，请补充说明')
          return
        }

        const resolvedRange = resolveIntentDateRange(intent.timeRange, query)
        const startTime = resolvedRange.startDate ? Math.floor(new Date(`${resolvedRange.startDate}T00:00:00`).getTime() / 1000) : undefined
        const endTime = resolvedRange.endDate ? Math.floor(new Date(`${resolvedRange.endDate}T23:59:59`).getTime() / 1000) : undefined
        const summaryParts = [`关键词「${keyword}」`]
        if (resolvedRange.label) summaryParts.push(resolvedRange.label)
        const scopeLabel = filterMode === 'all'
          ? '全部会话'
          : filterMode === 'whitelist'
            ? `白名单(${selectedSessionIds.length})`
            : `黑名单(${selectedSessionIds.length})`
        summaryParts.push(scopeLabel)

        await runAssistantSearch({
          keyword,
          startTime,
          endTime,
          summary: summaryParts.join(' · ')
        })

        setAssistantTaskSummary(summaryParts.join(' · '))
        return
      }

      if (intent.intent === 'report') {
        const resolvedRange = resolveIntentDateRange(intent.timeRange, query)
        const today = formatDateInput(new Date())
        const startDate = resolvedRange.startDate || today
        const endDate = resolvedRange.endDate || startDate
        setReportStartDate(startDate)
        setReportEndDate(endDate)
        const prompt = await generateReportForRange(startDate, endDate)
        if (!prompt) {
          setAssistantTaskError('日报生成失败，请检查日期范围或数据源')
          return
        }
        const scopeLabel = filterMode === 'all'
          ? '全部会话'
          : filterMode === 'whitelist'
            ? `白名单(${selectedSessionIds.length})`
            : `黑名单(${selectedSessionIds.length})`
        setAssistantTaskSummary(`日报范围：${startDate === endDate ? startDate : `${startDate} - ${endDate}`} · ${scopeLabel}`)
        await runReportOutput(prompt)
        return
      }

      if (intent.intent === 'export') {
        if (!assistantReportOutput.trim()) {
          setAssistantTaskError('当前没有可导出的日报内容')
          return
        }
        handleExportReport()
        setAssistantTaskSummary('已导出日报')
        return
      }

      setAssistantTaskError('未识别到可执行的任务，请补充说明')
    } catch (error) {
      setAssistantTaskError(error instanceof Error ? error.message : '指令解析失败')
    } finally {
      setAssistantTaskLoading(false)
    }
  }

  return (
    <div className="assistant-page">
      <header className="assistant-header">
        <div className="assistant-title">
          <button className="assistant-back" onClick={() => navigate('/home')}>
            <ArrowLeft size={18} />
            返回首页
          </button>
          <div>
            <div className="assistant-title-row">
              <Bot size={28} />
              <h1>自然语言控制器</h1>
              <span className="assistant-badge"><Sparkles size={14} />单次任务</span>
            </div>
            <p>一句话驱动检索、语音转写、日报生成与导出，作为统一查询入口。</p>
          </div>
        </div>
        <div className="assistant-meta">
          <div>
            <span>当前模型</span>
            <strong>{aiProviderName || '未配置'} {aiModelName ? `· ${aiModelName}` : ''}</strong>
          </div>
          <div>
            <span>本地化</span>
            <strong>{aiProviderId === 'ollama' ? 'Ollama 本地模型已启用' : '支持 Ollama 本地模型'}</strong>
          </div>
        </div>
      </header>

      <div className="assistant-content">
        <div className="assistant-panel assistant-panel--left">
          <section className="assistant-card assistant-card--sessions">
            <div className="assistant-card-header">
              <Filter size={18} />
              <h2>数据范围与过滤</h2>
            </div>
            <div className="assistant-card-body assistant-card-body--sessions">
              <DataFilterPanel sessions={sessions} />
            </div>
          </section>

          <section className="assistant-card">
            <div className="assistant-card-header">
              <Search size={18} />
              <h2>智能全局搜索</h2>
            </div>
            <div className="assistant-card-body">
              <div className="assistant-search-row">
                <input
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  placeholder="例：近一个月我和谁转过账？"
                />
                <button type="button" onClick={handleGlobalSearch} disabled={searchLoading}>
                  {searchLoading ? '搜索中...' : '立即搜索'}
                </button>
              </div>
              {searchParsed && (
                <div className="assistant-search-summary">
                  <span>解析结果</span>
                  <div className="assistant-search-tags">
                    <span>关键词：{searchParsed.keyword || '未识别'}</span>
                    {(searchParsed.startDate || searchParsed.endDate) && (
                      <span>时间范围：{searchParsed.startDate || '不限'} 至 {searchParsed.endDate || '不限'}</span>
                    )}
                    {searchParsed.summary && <span>{searchParsed.summary}</span>}
                  </div>
                </div>
              )}
              {searchError && <div className="assistant-error">{searchError}</div>}
              <div className="assistant-result-list">
                {searchResults.map(result => (
                  <button
                    type="button"
                    key={`${result.sessionId}-${result.localId}`}
                    className={`assistant-result-item ${highlightedResult === `${result.sessionId}-${result.localId}` ? 'highlighted' : ''}`}
                    onClick={() => handleResultJump({ talkerId: result.sessionId, messageId: result.localId })}
                  >
                    <div className="assistant-result-meta">
                      <span>{sessionNameMap.get(result.sessionId) || result.sessionId} · {getSessionTypeLabel(result.sessionId)}</span>
                      <span>{result.senderUsername || (result.isSend ? '我' : '未知')} · {formatTime(result.createTime)}</span>
                    </div>
                    <div className="assistant-result-content">{result.parsedContent || result.rawContent}</div>
                    <span className="assistant-link">查看上下文</span>
                  </button>
                ))}
                {!searchLoading && searchResults.length === 0 && (
                  <div className="assistant-empty">暂无搜索结果</div>
                )}
              </div>
            </div>
          </section>

          <section className="assistant-card">
            <div className="assistant-card-header">
              <CalendarRange size={18} />
              <h2>智能日报生成</h2>
            </div>
            <div className="assistant-card-body">
              <div className="assistant-report-row">
                <label>
                  开始日期
                  <input type="date" value={reportStartDate} onChange={(e) => setReportStartDate(e.target.value)} />
                </label>
                <label>
                  结束日期
                  <input type="date" value={reportEndDate} onChange={(e) => setReportEndDate(e.target.value)} />
                </label>
                <button type="button" onClick={handleGenerateReport} disabled={reportLoading}>
                  {reportLoading ? '提取中...' : '提取聊天记录'}
                </button>
              </div>
              {reportError && <div className="assistant-error">{reportError}</div>}
              <div className="assistant-report-summary">
                <div>
                  <span>记录条数</span>
                  <strong>{reportStats.messageCount && reportStats.messageCount > 0 ? reportStats.messageCount : '--'}</strong>
                </div>
                <div>
                  <span>覆盖会话</span>
                  <strong>{reportStats.sessionCount && reportStats.sessionCount > 0 ? reportStats.sessionCount : '--'}</strong>
                </div>
              </div>
              <div className="assistant-report-prompt">
                <div className="assistant-prompt-header">
                  <ListTodo size={18} />
                  <h3>日报 Prompt</h3>
                  <div>
                    <button type="button" onClick={handleCopyPrompt} disabled={!reportPrompt}>
                      <ClipboardCopy size={14} />复制
                    </button>
                    <button type="button" onClick={handleUsePrompt} disabled={!reportPrompt}>
                      <Send size={14} />填入控制器
                    </button>
                    <button type="button" onClick={handleSendReportPrompt} disabled={!reportPrompt}>
                      <Send size={14} />生成日报
                    </button>
                  </div>
                </div>
                <textarea
                  value={reportPrompt}
                  onChange={(e) => setReportPrompt(e.target.value)}
                  placeholder="点击提取聊天记录后，将自动生成日报 Prompt..."
                />
              </div>
            </div>
          </section>
        </div>

        <div className="assistant-panel assistant-panel--right">
          <section className="assistant-card assistant-chat">
            <div className="assistant-card-header">
              <Bot size={18} />
              <h2>自然语言控制器</h2>
            </div>
            <div className="assistant-controller-body">
              <div className="assistant-controller-input">
                <textarea
                  ref={assistantInputRef}
                  value={assistantInput}
                  onChange={(e) => setAssistantInput(e.target.value)}
                  placeholder="一句话下达任务：检索聊天、生成日报、导出结果..."
                  rows={3}
                />
                <button type="button" onClick={handleRunAssistantTask} disabled={assistantTaskLoading}>
                  <Send size={18} />{assistantTaskLoading ? '执行中...' : '执行'}
                </button>
              </div>
              {assistantIntentJson && (
                <div className="assistant-intent-preview">
                  <span>解析结果</span>
                  <pre>{JSON.stringify(assistantIntentJson, null, 2)}</pre>
                </div>
              )}
              {assistantTaskSummary && <div className="assistant-task-summary">{assistantTaskSummary}</div>}
              {assistantTaskError && <div className="assistant-error">{assistantTaskError}</div>}
              <div className="assistant-task-output">
                {assistantReportOutput ? (
                  <div
                    className="assistant-report-output"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(marked.parse(assistantReportOutput || '...'))
                    }}
                  />
                ) : assistantSearchResults.length > 0 ? (
                  <div className="assistant-task-summary">检索结果已展示在下方列表。</div>
                ) : assistantTaskLoading ? (
                  <div className="assistant-empty">任务执行中...</div>
                ) : (
                  <div className="assistant-empty">等待指令执行结果...</div>
                )}
              </div>
            </div>
            <div className="assistant-report-actions">
              <span>日报输出</span>
              <div>
                <button type="button" onClick={handleCopyReport} disabled={!assistantReportOutput.trim()}>
                  <ClipboardCopy size={14} />复制纯文本
                </button>
                <button type="button" onClick={handleExportReport} disabled={!assistantReportOutput.trim()}>
                  <FileDown size={14} />导出
                </button>
              </div>
            </div>
            <div className="assistant-chat-search">
              <div className="assistant-chat-search-header">
                <h3>检索结果</h3>
                {assistantSearchSummary && <span>{assistantSearchSummary}</span>}
              </div>
              {assistantSearchError && <div className="assistant-error">{assistantSearchError}</div>}
              <div className="assistant-result-list assistant-result-list--chat">
                {assistantSearchLoading && <div className="assistant-empty">正在检索聊天记录...</div>}
                {!assistantSearchLoading && assistantSearchResults.map(result => (
                  <button
                    type="button"
                    key={`assistant-${result.talkerId}-${result.messageId}`}
                    className={`assistant-result-item ${highlightedResult === `${result.talkerId}-${result.messageId}` ? 'highlighted' : ''}`}
                    onClick={() => handleResultJump({ talkerId: result.talkerId, messageId: result.messageId })}
                  >
                    <div className="assistant-result-meta">
                      <span>{sessionNameMap.get(result.talkerId) || result.talkerId} · {getSessionTypeLabel(result.talkerId)}</span>
                      <span>{result.senderUsername || (result.isSend ? '我' : '未知')} · {formatTime(result.timestamp)}</span>
                    </div>
                    <div className="assistant-result-content">{result.content}</div>
                    <span className="assistant-link">查看上下文</span>
                  </button>
                ))}
                {!assistantSearchLoading && assistantSearchResults.length === 0 && (
                  <div className="assistant-empty">暂无检索结果</div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default AssistantPage
