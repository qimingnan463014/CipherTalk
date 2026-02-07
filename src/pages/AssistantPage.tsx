import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, CalendarRange, ChevronDown, ClipboardCopy, Filter, ListTodo, Search, Send, Sparkles, ArrowLeft } from 'lucide-react'
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
}

type SearchIntent = {
  keyword: string
  startTime?: number
  endTime?: number
  summary: string
}

const assistantSystemPrompt = `你是 CipherTalk 的个人业务助理，擅长从聊天记录和用户指令中提炼关键信息、输出日报总结、列出待办与风险提醒。请始终使用中文输出，结构清晰，优先使用要点列表与表格。`

function formatDateInput(date: Date) {

  return date.toISOString().slice(0, 10)
}

function formatTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString()
}

function buildDailyPrompt(date: string, messages: AssistantMessage[], sessionNameMap: Map<string, string>) {
  const lines = messages.map((msg) => {
    const sessionName = sessionNameMap.get(msg.sessionId) || msg.sessionId
    const sender = msg.senderUsername || (msg.isSend ? '我' : sessionName)
    const content = msg.parsedContent || msg.rawContent
    return `[${formatTime(msg.createTime)}] ${sessionName} · ${sender}: ${content}`
  })

  const historyText = lines.length > 0 ? lines.join('\n') : '（当日未检索到可用聊天记录）'

  return `你是我的个人业务助理，请根据以下聊天记录生成【${date}】的工作日报，并输出：\n\n1. 今日关键进展（按客户/项目/群组归类）\n2. 重要决策/结论\n3. 待办清单（包含负责人、截止时间，如未明确则标注待确认）\n4. 风险/异常点与需要跟进的问题\n\n要求：\n- 只基于记录事实，不要臆测\n- 无价值寒暄可忽略\n- 输出清晰的标题与列表\n\n聊天记录：\n${historyText}`
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
  const [searchStartDate, setSearchStartDate] = useState('')
  const [searchEndDate, setSearchEndDate] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchResults, setSearchResults] = useState<AssistantMessage[]>([])

  const [reportDate, setReportDate] = useState(formatDateInput(new Date()))
  const [reportLoading, setReportLoading] = useState(false)
  const [reportMessages, setReportMessages] = useState<AssistantMessage[]>([])
  const [reportPrompt, setReportPrompt] = useState('')
  const [reportError, setReportError] = useState('')

  const [assistantMessages, setAssistantMessages] = useState<ChatMessage[]>([])
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantError, setAssistantError] = useState('')
  const [assistantStreaming, setAssistantStreaming] = useState(false)
  const assistantInputRef = useRef<HTMLTextAreaElement | null>(null)
  const assistantChatBodyRef = useRef<HTMLDivElement | null>(null)

  const [assistantSearchResults, setAssistantSearchResults] = useState<AssistantMessage[]>([])
  const [assistantSearchLoading, setAssistantSearchLoading] = useState(false)
  const [assistantSearchError, setAssistantSearchError] = useState('')
  const [assistantSearchSummary, setAssistantSearchSummary] = useState('')

  const [aiProviderName, setAiProviderName] = useState('')
  const [aiModelName, setAiModelName] = useState('')
  const [aiProviderId, setAiProviderId] = useState('')
  const [enableThinking, setEnableThinking] = useState(true)

  useEffect(() => {
    if (sessions.length > 0) return

    window.electronAPI.chat.getSessions().then(result => {
      if (result.success && result.sessions) {
        setSessions(result.sessions)
      }
    })
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
    if (assistantChatBodyRef.current) {
      assistantChatBodyRef.current.scrollTop = assistantChatBodyRef.current.scrollHeight
    }
  }, [assistantMessages, assistantSearchResults, assistantSearchLoading])

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

  const handleGlobalSearch = async () => {
    if (!searchKeyword.trim()) {
      setSearchError('请输入关键词后再搜索')
      return
    }

    setSearchLoading(true)
    setSearchError('')

    const startTime = searchStartDate ? Math.floor(new Date(`${searchStartDate}T00:00:00`).getTime() / 1000) : undefined
    const endTime = searchEndDate ? Math.floor(new Date(`${searchEndDate}T23:59:59`).getTime() / 1000) : undefined

    try {
      const result = await window.electronAPI.chat.searchGlobalMessages({
        keyword: searchKeyword.trim(),
        startTime,
        endTime,
        limit: 200,
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
    setReportLoading(true)
    setReportError('')

    try {

      const startTime = Math.floor(new Date(`${reportDate}T00:00:00`).getTime() / 1000)
      const endTime = Math.floor(new Date(`${reportDate}T23:59:59`).getTime() / 1000) 

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
        return
      }

      const messages = result.messages || []
      setReportMessages(messages)
      setReportPrompt(buildDailyPrompt(reportDate, messages, sessionNameMap))
    } catch (e) {
      setReportError('提取过程中发生异常')
      setReportMessages([])
      setReportPrompt('')
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
        limit: 200,
        ...resolveSessionFilterPayload()
      })

      if (!result.success) {
        setAssistantSearchError(result.error || '检索失败，请重试')
        setAssistantSearchResults([])
        return
      }

      setAssistantSearchResults(result.results || [])
    } catch (e) {
      setAssistantSearchError('检索过程中发生异常')
      setAssistantSearchResults([])
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

  const sendAssistantMessage = async (content: string, options?: { enableSearchIntent?: boolean }) => {
    if (!content || assistantStreaming) return

    if (options?.enableSearchIntent) {
      const intent = detectSearchIntent(content)
      if (intent) {
        await runAssistantSearch(intent)
      }
    }

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
    await sendAssistantMessage(content, { enableSearchIntent: true })
    setAssistantInput('')
  }

  const handleSendReportPrompt = async () => {
    if (!reportPrompt || assistantStreaming) return
    await sendAssistantMessage(reportPrompt, { enableSearchIntent: false })
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
          <section className="assistant-card">
            <div className="assistant-card-header">
              <Filter size={18} />
              <h2>数据范围与过滤</h2>
            </div>
            <div className="assistant-card-body">
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
                      <label key={session.username} className={`assistant-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selectedSessions.has(session.username)}
                          onChange={() => toggleSession(session.username)}
                        />
                        <span>{session.displayName || session.username}</span>
                      </label>
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
                      <label key={session.username} className={`assistant-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selectedSessions.has(session.username)}
                          onChange={() => toggleSession(session.username)}
                        />
                        <span>{session.displayName || session.username}</span>
                      </label>
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
              <h2>全局搜索</h2>
            </div>
            <div className="assistant-card-body">
              <div className="assistant-search-row">
                <input
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  placeholder="关键词，如：欠账、报价、付款"
                />
                <button type="button" onClick={handleGlobalSearch} disabled={searchLoading}>
                  {searchLoading ? '搜索中...' : '立即搜索'}
                </button>
              </div>
              <div className="assistant-date-row">
                <label>
                  开始日期
                  <input type="date" value={searchStartDate} onChange={(e) => setSearchStartDate(e.target.value)} />
                </label>
                <label>
                  结束日期
                  <input type="date" value={searchEndDate} onChange={(e) => setSearchEndDate(e.target.value)} />
                </label>
              </div>
              {searchError && <div className="assistant-error">{searchError}</div>}
              <div className="assistant-result-list">
                {searchResults.map(result => (
                  <div key={`${result.sessionId}-${result.localId}-${result.sortSeq}`} className="assistant-result-item">
                    <div className="assistant-result-meta">
                      <span>{sessionNameMap.get(result.sessionId) || result.sessionId}</span>
                      <span>{result.senderUsername || (result.isSend ? '我' : '未知')} · {formatTime(result.createTime)}</span>
                    </div>
                    <div className="assistant-result-content">{result.parsedContent || result.rawContent}</div>
                    <button
                      type="button"
                      className="assistant-link"
                      onClick={() => window.electronAPI.window.openChatHistoryWindow(result.sessionId, result.localId)}
                    >
                      查看上下文
                    </button>
                  </div>
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
                  日报日期
                  <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
                </label>
                <button type="button" onClick={handleGenerateReport} disabled={reportLoading}>
                  {reportLoading ? '提取中...' : '提取聊天记录'}
                </button>
              </div>
              {reportError && <div className="assistant-error">{reportError}</div>}
              <div className="assistant-report-summary">
                <div>
                  <span>记录条数</span>
                  <strong>{reportMessages.length}</strong>
                </div>
                <div>
                  <span>覆盖会话</span>
                  <strong>{new Set(reportMessages.map(msg => msg.sessionId)).size}</strong>
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
            <div className="assistant-chat-body" ref={assistantChatBodyRef}>
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
                  <div className="assistant-chat-time">
                    {message.isStreaming ? '生成中...' : new Date(message.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
            {assistantError && <div className="assistant-error">{assistantError}</div>}
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
                  <div key={`assistant-${result.sessionId}-${result.localId}-${result.sortSeq}`} className="assistant-result-item">
                    <div className="assistant-result-meta">
                      <span>{sessionNameMap.get(result.sessionId) || result.sessionId}</span>
                      <span>{result.senderUsername || (result.isSend ? '我' : '未知')} · {formatTime(result.createTime)}</span>
                    </div>
                    <div className="assistant-result-content">{result.parsedContent || result.rawContent}</div>
                    <button
                      type="button"
                      className="assistant-link"
                      onClick={() => window.electronAPI.window.openChatHistoryWindow(result.sessionId, result.localId)}
                    >
                      查看上下文
                    </button>
                  </div>
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
