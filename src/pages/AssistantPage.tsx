import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, CalendarRange, ChevronDown, ClipboardCopy, Filter, ListTodo, Search, Send, Sparkles, ArrowLeft, Check, FileDown } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useChatStore } from '../stores/chatStore'
import { getAiEnableThinking, getAiModel, getAiProvider } from '../services/config'
import { getAIProviders } from '../types/ai'

import type { AssistantMessage } from '../types/assistant'
import './AssistantPage.scss'

type FilterMode = 'all' | 'whitelist' | 'blacklist'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  isStreaming?: boolean
  payload?: SearchResultPayload[]
}

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

type AssistantAction = {
  action: 'search' | 'none'
  params?: {
    keyword?: string
    dateRange?: string
    startDate?: string
    endDate?: string
  }
}

const assistantSystemPrompt = `你是 CipherTalk 的个人业务助理，擅长从聊天记录和用户指令中提炼关键信息、输出日报总结、列出待办与风险提醒。请始终使用中文输出，结构清晰，优先使用要点列表与表格。`
const assistantSearchPrompt = `你是 CipherTalk 的智能搜索解析器。请根据用户的自然语言，返回用于检索聊天记录的 JSON 数据，且只输出 JSON，不要添加解释或 Markdown。\n\nJSON 字段说明：\n- keyword: 用于全文检索的关键词（必填，若找不到关键词返回空字符串）\n- startDate: 可选，开始日期，格式 YYYY-MM-DD\n- endDate: 可选，结束日期，格式 YYYY-MM-DD\n- summary: 可选，用中文简述解析结果\n\n示例：\n用户输入：近一个月我和谁转过账？\n返回：{\"keyword\":\"转账\",\"startDate\":\"2024-03-01\",\"endDate\":\"2024-03-31\",\"summary\":\"关键词“转账” · 近一个月\"}`
const assistantAgentPrompt = `你是 CipherTalk 的指令解析器。请判断用户是否在查询聊天记录或业务信息。\n\n若是查询/搜索意图，仅输出 JSON：\n{\"action\":\"search\",\"params\":{\"keyword\":\"关键词\",\"dateRange\":\"15days\",\"startDate\":\"YYYY-MM-DD\",\"endDate\":\"YYYY-MM-DD\"}}\n\n字段说明：\n- action: search 或 none\n- keyword: 关键词，尽量提取与业务/交易相关的词\n- dateRange: 可选，使用类似 7days/15days/30days 的表达\n- startDate/endDate: 可选，明确日期范围时填写 YYYY-MM-DD\n\n若不是查询意图，仅输出：{\"action\":\"none\"}\n\n只输出 JSON，不要添加解释或 Markdown。`
const assistantSearchSummaryPrompt = `你是 CipherTalk 的智能业务助理。请根据用户的问题与检索到的聊天记录 JSON，总结为中文回答。\n\n要求：\n- 先给出总体结论/数量\n- 如果有多条记录，用列表逐条简要说明（包含会话、时间、摘要）\n- 如果没有记录，明确说明未找到\n- 不要编造未提供的数据`
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

function parseRelativeDays(range?: string) {
  if (!range) return null
  const match = range.match(/(\d+)\s*(day|days|d|天)/i)
  if (!match) return null
  const days = Number(match[1])
  if (Number.isNaN(days) || days <= 0) return null
  const endTime = Math.floor(Date.now() / 1000)
  const startTime = endTime - days * 24 * 60 * 60
  return { startTime, endTime, label: `最近${days}天` }
}

function getDefaultReportRange() {
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(endDate.getDate() - 2)
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

function getAvatarText(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return '#'
  return trimmed.slice(0, 1).toUpperCase()
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

function AssistantPage() {
  const navigate = useNavigate()
  const { sessions, setSessions } = useChatStore()
  const [sessionQuery, setSessionQuery] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [friendGroupCollapsed, setFriendGroupCollapsed] = useState(false)
  const [groupGroupCollapsed, setGroupGroupCollapsed] = useState(false)

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

  const [assistantMessages, setAssistantMessages] = useState<ChatMessage[]>([])
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantError, setAssistantError] = useState('')
  const [assistantStreaming, setAssistantStreaming] = useState(false)
  const [assistantAutoScroll, setAssistantAutoScroll] = useState(true)
  const assistantInputRef = useRef<HTMLTextAreaElement | null>(null)
  const assistantChatBodyRef = useRef<HTMLDivElement | null>(null)

  const [assistantSearchResults, setAssistantSearchResults] = useState<SearchResultPayload[]>([])
  const [assistantSearchLoading, setAssistantSearchLoading] = useState(false)
  const [assistantSearchError, setAssistantSearchError] = useState('')
  const [assistantSearchSummary, setAssistantSearchSummary] = useState('')
  const [highlightedResult, setHighlightedResult] = useState<string | null>(null)

  const [aiProviderName, setAiProviderName] = useState('')
  const [aiModelName, setAiModelName] = useState('')
  const [aiProviderId, setAiProviderId] = useState('')
  const [enableThinking, setEnableThinking] = useState(true)

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
      setAiProviderId(providerId)
      setAiProviderName(provider?.displayName || providerId)
      setAiModelName(modelName || provider?.models?.[0] || '')
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

  const filteredSessions = useMemo(() => {
    const keyword = sessionQuery.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter(session =>
      (session.displayName || session.username).toLowerCase().includes(keyword)
    )
  }, [sessions, sessionQuery])

  const groupedSessions = useMemo(() => {
    const friendSessions = filteredSessions.filter(session => !isGroupChat(session.username))
    const groupSessions = filteredSessions.filter(session => isGroupChat(session.username))
    return { friendSessions, groupSessions }
  }, [filteredSessions])

  useEffect(() => {
    if (assistantChatBodyRef.current && assistantAutoScroll) {
      assistantChatBodyRef.current.scrollTop = assistantChatBodyRef.current.scrollHeight
    }
  }, [assistantMessages, assistantSearchResults, assistantSearchLoading, assistantAutoScroll])

  useEffect(() => {
    localStorage.setItem(reportRangeStorageKey, JSON.stringify({
      startDate: reportStartDate,
      endDate: reportEndDate
    }))
  }, [reportStartDate, reportEndDate])

  const toggleSession = (sessionId: string) => {
    setSelectedSessions(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    setSelectedSessions(new Set(filteredSessions.map(session => session.username)))
  }

  const handleClearSelection = () => {
    setSelectedSessions(new Set())
  }

  const resolveSessionFilterPayload = () => {
    if (filterMode === 'whitelist') {
      return { sessionIds: Array.from(selectedSessions) }
    }
    if (filterMode === 'blacklist') {
      return { excludeSessionIds: Array.from(selectedSessions) }
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
        { role: 'system', content: assistantSearchPrompt },
        { role: 'user', content: query }
      ],
      options: {
        temperature: 0.1,
        maxTokens: 300,
        enableThinking: false
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

    return JSON.parse(jsonBlock) as SearchParseResult
  }

  const parseAssistantAction = async (query: string) => {
    let content = ''
    const cleanup = window.electronAPI.ai.onAssistantChunk((chunk) => {
      content += chunk
    })

    const result = await window.electronAPI.ai.assistantChat({
      messages: [
        { role: 'system', content: assistantAgentPrompt },
        { role: 'user', content: query }
      ],
      options: {
        temperature: 0,
        maxTokens: 200,
        enableThinking: false
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

    return JSON.parse(jsonBlock) as AssistantAction
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
      const summary = parsed.summary || fallbackIntent?.summary

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

  const handleGenerateReport = async () => {
    if (!reportStartDate || !reportEndDate) {
      setReportError('请先选择完整的日期范围')
      return
    }

    const rangeStart = new Date(`${reportStartDate}T00:00:00`)
    const rangeEnd = new Date(`${reportEndDate}T23:59:59`)
    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
      setReportError('日期格式不正确，请重新选择')
      return
    }

    if (rangeStart.getTime() > rangeEnd.getTime()) {
      setReportError('开始日期不能晚于结束日期')
      return
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
        return
      }

      const messages = result.messages || []
      const uniqueSessions = new Set(messages.map(msg => msg.sessionId))
      setReportMessages(messages)
      setReportStats({ messageCount: messages.length, sessionCount: uniqueSessions.size })
      const rangeLabel = reportStartDate === reportEndDate ? reportStartDate : `${reportStartDate} - ${reportEndDate}`
      const prompt = buildDailyPrompt(rangeLabel, messages, sessionNameMap)
      setReportPrompt(prompt)
      setAssistantInput(prompt)
      assistantInputRef.current?.focus()
    } catch (e) {
      setReportError('提取过程中发生异常')
      setReportMessages([])
      setReportPrompt('')
      setReportStats({ messageCount: null, sessionCount: null })
    } finally {
      setReportLoading(false)
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
    const latest = assistantMessages.slice().reverse().find(message => message.role === 'assistant' && message.content.trim())
    if (!latest) return
    const html = DOMPurify.sanitize(marked.parse(latest.content || ''))
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
    const latest = assistantMessages.slice().reverse().find(message => message.role === 'assistant' && message.content.trim())
    if (!latest) return
    const html = DOMPurify.sanitize(marked.parse(latest.content || ''))
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

  const handleAssistantScroll = () => {
    const container = assistantChatBodyRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    setAssistantAutoScroll(distanceFromBottom < 80)
  }

  const handleResultJump = (result: { talkerId: string; messageId: number }) => {
    const key = `${result.talkerId}-${result.messageId}`
    setHighlightedResult(key)
    window.electronAPI.chat.jumpToMessage({ talkerId: result.talkerId, messageId: result.messageId })
    setTimeout(() => {
      setHighlightedResult(prev => (prev === key ? null : prev))
    }, 2000)
  }

  const buildChatPayload = (newUserMessage: ChatMessage) => {
    const baseMessages = assistantMessages
      .filter(message => message.content.trim().length > 0)
      .map(message => ({ role: message.role, content: message.content }))

    return [
      { role: 'system' as const, content: assistantSystemPrompt },
      ...baseMessages,
      { role: 'user' as const, content: newUserMessage.content }
    ]
  }

  const buildSearchSummaryPayload = (query: string, results: AssistantMessage[]) => {
    const summarized = results.map((msg) => ({
      session: sessionNameMap.get(msg.sessionId) || msg.sessionId,
      sender: msg.senderUsername || (msg.isSend ? '我' : '未知'),
      time: formatTime(msg.createTime),
      content: msg.parsedContent || msg.rawContent
    }))

    return [
      { role: 'system' as const, content: assistantSearchSummaryPrompt },
      {
        role: 'user' as const,
        content: `用户问题：${query}\n\n检索结果 JSON：${JSON.stringify(summarized)}`
      }
    ]
  }

  const resolveSearchIntentFromAction = (action: AssistantAction, query: string): SearchIntent | null => {
    if (action.action !== 'search') return null

    const keyword = action.params?.keyword?.trim() || normalizeSearchKeyword(query)
    if (!keyword) return null

    const dateRange = parseRelativeDays(action.params?.dateRange)
    const startDate = action.params?.startDate
    const endDate = action.params?.endDate
    const parsedRange = resolveRelativeRange(query)

    const startTime = startDate ? Math.floor(new Date(`${startDate}T00:00:00`).getTime() / 1000) : (dateRange?.startTime ?? parsedRange?.startTime)
    const endTime = endDate ? Math.floor(new Date(`${endDate}T23:59:59`).getTime() / 1000) : (dateRange?.endTime ?? parsedRange?.endTime)

    const summaryParts = [`关键词「${keyword}」`]
    if (startDate || endDate) {
      summaryParts.push(`${startDate || '不限'} 至 ${endDate || '不限'}`)
    } else if (dateRange?.label) {
      summaryParts.push(dateRange.label)
    } else if (parsedRange?.label) {
      summaryParts.push(parsedRange.label)
    }

    return {
      keyword,
      startTime,
      endTime,
      summary: summaryParts.join(' · ')
    }
  }

  const sendAssistantSummary = async (query: string, results: AssistantMessage[]) => {
    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: 'user',
      content: query,
      createdAt: Date.now()
    }

    const assistantMessage: ChatMessage = {
      id: `${Date.now()}-assistant`,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      isStreaming: true
    }

    setAssistantMessages(prev => [...prev, userMessage, assistantMessage])
    setAssistantError('')
    setAssistantStreaming(true)

    const cleanup = window.electronAPI.ai.onAssistantChunk((chunk) => {
      setAssistantMessages(prev => prev.map(msg => {
        if (msg.id !== assistantMessage.id) return msg
        return { ...msg, content: msg.content + chunk }
      }))
    })

    try {
      const result = await window.electronAPI.ai.assistantChat({
        messages: buildSearchSummaryPayload(query, results),
        options: {
          enableThinking
        }
      })

      if (!result.success) {
        setAssistantError(result.error || 'AI 响应失败')
      }
    } catch (e) {
      setAssistantError('AI 响应失败')
    } finally {
      cleanup()
      setAssistantMessages(prev => prev.map(msg => {
        if (msg.id !== assistantMessage.id) return msg
        return { ...msg, isStreaming: false }
      }))
      setAssistantStreaming(false)
    }
  }

  const sendAssistantMessage = async (content: string) => {
    if (!content || assistantStreaming) return
    setAssistantSearchResults([])
    setAssistantSearchSummary('')
    setAssistantSearchError('')

    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: 'user',
      content,
      createdAt: Date.now()
    }

    const assistantMessage: ChatMessage = {
      id: `${Date.now()}-assistant`,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      isStreaming: true
    }

    setAssistantMessages(prev => [...prev, userMessage, assistantMessage])
    setAssistantError('')
    setAssistantStreaming(true)

    const apiMessages = buildChatPayload(userMessage)

    const cleanup = window.electronAPI.ai.onAssistantChunk((chunk) => {
      setAssistantMessages(prev => prev.map(msg => {
        if (msg.id !== assistantMessage.id) return msg
        return { ...msg, content: msg.content + chunk }
      }))
    })

    try {
      const result = await window.electronAPI.ai.assistantChat({
        messages: apiMessages,
        options: {
          enableThinking
        }
      })

      if (!result.success) {
        setAssistantError(result.error || 'AI 响应失败')
      } else if (result.payload && result.payload.length > 0) {
        setAssistantMessages(prev => prev.map(msg => {
          if (msg.id !== assistantMessage.id) return msg
          return { ...msg, payload: result.payload }
        }))
        setAssistantSearchResults(result.payload)
        setAssistantSearchSummary(`AI 检索结果 · ${result.payload.length} 条`)
      }
    } catch (e) {
      setAssistantError('AI 响应失败')
    } finally {
      cleanup()
      setAssistantMessages(prev => prev.map(msg => {
        if (msg.id !== assistantMessage.id) return msg
        return { ...msg, isStreaming: false }
      }))
      setAssistantStreaming(false)
    }
  }

  const handleSendMessage = async () => {
    const content = assistantInput.trim()
    if (!content || assistantStreaming) return
    await sendAssistantMessage(content)
    setAssistantInput('')
  }

  const handleSendReportPrompt = async () => {
    if (!reportPrompt || assistantStreaming) return
    await sendAssistantMessage(reportPrompt)
    setAssistantInput('')
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
              <h1>个人业务助理</h1>
              <span className="assistant-badge"><Sparkles size={14} />全能模式</span>
            </div>
            <p>跨会话检索、日报生成、自动 Prompt 与对话指令，一站式管理你的业务信息。</p>
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
              <div className="assistant-filter-row">
                <label>
                  模式
                  <select value={filterMode} onChange={(e) => setFilterMode(e.target.value as FilterMode)}>
                    <option value="all">全部会话</option>
                    <option value="whitelist">白名单模式</option>
                    <option value="blacklist">黑名单模式</option>
                  </select>
                </label>
                <label>
                  会话搜索
                  <input
                    value={sessionQuery}
                    onChange={(e) => setSessionQuery(e.target.value)}
                    placeholder="搜索联系人或群名称"
                  />
                </label>
              </div>
              <div className="assistant-filter-actions">
                <button type="button" onClick={handleSelectAll}>全选当前列表</button>
                <button type="button" onClick={handleClearSelection}>清空选择</button>
                <span>已选 {selectedSessions.size} 个会话</span>
              </div>
              <div className="assistant-session-groups">
                <div className="assistant-session-group">
                  <button
                    type="button"
                    className="assistant-session-group-header"
                    onClick={() => setFriendGroupCollapsed(prev => !prev)}
                  >
                    <span>Friend Chats</span>
                    <span className="assistant-session-count">{groupedSessions.friendSessions.length}</span>
                    <ChevronDown size={16} className={friendGroupCollapsed ? 'collapsed' : ''} />
                  </button>
                  <div className={`assistant-session-group-body ${friendGroupCollapsed ? 'collapsed' : ''}`}>
                    {groupedSessions.friendSessions.map(session => (
                      <button
                        key={session.username}
                        type="button"
                        className={`assistant-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}
                        onClick={() => toggleSession(session.username)}
                      >
                        <span className="assistant-session-avatar">
                          {getAvatarText(session.displayName || session.username)}
                        </span>
                        <span className="assistant-session-name">{session.displayName || session.username}</span>
                        <span className={`assistant-session-check ${selectedSessions.has(session.username) ? 'checked' : ''}`}>
                          <Check size={14} />
                        </span>
                      </button>
                    ))}
                    {groupedSessions.friendSessions.length === 0 && (
                      <div className="assistant-empty">暂无匹配的好友会话</div>
                    )}
                  </div>
                </div>
                <div className="assistant-session-group">
                  <button
                    type="button"
                    className="assistant-session-group-header"
                    onClick={() => setGroupGroupCollapsed(prev => !prev)}
                  >
                    <span>Group Chats</span>
                    <span className="assistant-session-count">{groupedSessions.groupSessions.length}</span>
                    <ChevronDown size={16} className={groupGroupCollapsed ? 'collapsed' : ''} />
                  </button>
                  <div className={`assistant-session-group-body ${groupGroupCollapsed ? 'collapsed' : ''}`}>
                    {groupedSessions.groupSessions.map(session => (
                      <button
                        key={session.username}
                        type="button"
                        className={`assistant-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}
                        onClick={() => toggleSession(session.username)}
                      >
                        <span className="assistant-session-avatar">
                          {getAvatarText(session.displayName || session.username)}
                        </span>
                        <span className="assistant-session-name">{session.displayName || session.username}</span>
                        <span className={`assistant-session-check ${selectedSessions.has(session.username) ? 'checked' : ''}`}>
                          <Check size={14} />
                        </span>
                      </button>
                    ))}
                    {groupedSessions.groupSessions.length === 0 && (
                      <div className="assistant-empty">暂无匹配的群聊会话</div>
                    )}
                  </div>
                </div>
                {filteredSessions.length === 0 && (
                  <div className="assistant-empty">暂无匹配的会话</div>
                )}
              </div>
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
                      <span>{sessionNameMap.get(result.sessionId) || result.sessionId}</span>
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
                      <Send size={14} />填入对话框
                    </button>
                    <button type="button" onClick={handleSendReportPrompt} disabled={!reportPrompt}>
                      <Send size={14} />发送到 AI 助理
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
              <h2>AI 助理对话</h2>
            </div>
            <div className="assistant-chat-body" ref={assistantChatBodyRef} onScroll={handleAssistantScroll}>
              {assistantMessages.length === 0 && (
                <div className="assistant-empty">
                  输入需求开始对话，支持粘贴日报 Prompt 或直接提问。
                </div>
              )}
              {assistantMessages.map(message => (
                <div key={message.id} className={`assistant-chat-message ${message.role}`}>
                  <div
                    className="assistant-chat-bubble"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(marked.parse(message.content || '...'))
                    }}
                  />
                  {message.payload && message.payload.length > 0 && (
                    <div className="assistant-chat-results">
                      {message.payload.map(result => (
                        <button
                          type="button"
                          key={`payload-${result.talkerId}-${result.messageId}`}
                          className={`assistant-chat-result ${highlightedResult === `${result.talkerId}-${result.messageId}` ? 'highlighted' : ''}`}
                          onClick={() => handleResultJump({ talkerId: result.talkerId, messageId: result.messageId })}
                        >
                          <div className="assistant-chat-result-avatar">
                            {getAvatarText(result.senderUsername || sessionNameMap.get(result.talkerId) || result.talkerId)}
                          </div>
                          <div className="assistant-chat-result-body">
                            <div className="assistant-chat-result-meta">
                              <span>{result.senderUsername || (result.isSend ? '我' : sessionNameMap.get(result.talkerId) || result.talkerId)}</span>
                              <span>{formatTime(result.timestamp)}</span>
                            </div>
                            <div className="assistant-chat-result-content">{result.content}</div>
                            <span className="assistant-link">查看上下文</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="assistant-chat-time">
                    {message.isStreaming ? '生成中...' : new Date(message.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
            {assistantError && <div className="assistant-error">{assistantError}</div>}
            <div className="assistant-report-actions">
              <span>日报输出</span>
              <div>
                <button type="button" onClick={handleCopyReport} disabled={!assistantMessages.some(msg => msg.role === 'assistant' && msg.content.trim())}>
                  <ClipboardCopy size={14} />复制纯文本
                </button>
                <button type="button" onClick={handleExportReport} disabled={!assistantMessages.some(msg => msg.role === 'assistant' && msg.content.trim())}>
                  <FileDown size={14} />导出
                </button>
              </div>
            </div>
            <div className="assistant-chat-input">
              <textarea
                ref={assistantInputRef}
                value={assistantInput}
                onChange={(e) => setAssistantInput(e.target.value)}
                placeholder="告诉我今天的重点、要跟进的客户，或直接粘贴日报 Prompt..."
                rows={3}
              />
              <button type="button" onClick={handleSendMessage} disabled={assistantStreaming}>
                <Send size={18} />发送
              </button>
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
                      <span>{sessionNameMap.get(result.talkerId) || result.talkerId}</span>
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
