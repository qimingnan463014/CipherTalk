import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, CalendarRange, ClipboardCopy, Filter, ListTodo, Search, Send, Sparkles, ArrowLeft } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useChatStore } from '../stores/chatStore'
import { getAiEnableThinking, getAiModel, getAiProvider } from '../services/config'
import { getAIProviders } from '../types/ai'
import type { AssistantMessage, AssistantReportInfo, AssistantScheduleConfig } from '../types/assistant'
import './AssistantPage.scss'

type FilterMode = 'all' | 'whitelist' | 'blacklist'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  isStreaming?: boolean
}

const assistantSystemPrompt = `你是 CipherTalk 的个人业务助理，擅长从聊天记录和用户指令中提炼关键信息、输出日报总结、列出待办与风险提醒。请始终使用中文输出，结构清晰，优先使用要点列表与表格。`

function formatDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildDayRange(dateString: string) {
  const [year, month, day] = dateString.split('-').map(Number)
  const start = new Date(year, month - 1, day, 0, 0, 0)
  const end = new Date(year, month - 1, day, 23, 59, 59)
  return {
    startTime: Math.floor(start.getTime() / 1000),
    endTime: Math.floor(end.getTime() / 1000)
  }
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

  return `你是我的个人业务助理，请根据以下聊天记录生成【${date}】的工作日报，并输出：\n\n1. 今日关键进展（按客户/项目/群组归类）\n2. 重要决策/结论\n3. 待办清单（包含负责人、截止时间，如未明确则标注待确认）\n4. 风险/异常点与需要跟进的问题\n\n要求：\n- 只基于记录事实，不要臆测\n- 无价值寒暄可忽略\n- 输出清晰的标题与列表\n\n聊天记录：\n${lines.join('\n')}`
}

function AssistantPage() {
  const navigate = useNavigate()
  const { sessions, setSessions } = useChatStore()
  const [sessionQuery, setSessionQuery] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())

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

  const [aiProviderName, setAiProviderName] = useState('')
  const [aiModelName, setAiModelName] = useState('')
  const [aiProviderId, setAiProviderId] = useState('')
  const [enableThinking, setEnableThinking] = useState(true)

  const [scheduleConfig, setScheduleConfig] = useState<AssistantScheduleConfig>({
    enabled: false,
    time: '03:00',
    rangeDays: 1,
    filterMode: 'all',
    sessionIds: [],
    excludeSessionIds: []
  })
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [reports, setReports] = useState<AssistantReportInfo[]>([])
  const [reportContent, setReportContent] = useState('')

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

  useEffect(() => {
    const loadSchedule = async () => {
      const result = await window.electronAPI.assistant.getSchedule()
      if (result.success && result.schedule) {
        setScheduleConfig(result.schedule)
      }
    }

    const loadReports = async () => {
      const result = await window.electronAPI.assistant.getReports()
      if (result.success && result.reports) {
        setReports(result.reports)
      }
    }

    loadSchedule()
    loadReports()
  }, [])

  const sessionNameMap = useMemo(() => {
    return new Map(sessions.map((session) => [session.username, session.displayName || session.username]))
  }, [sessions])

  const filteredSessions = useMemo(() => {
    const keyword = sessionQuery.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter(session =>
      (session.displayName || session.username).toLowerCase().includes(keyword)
    )
  }, [sessions, sessionQuery])

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

    const startTime = searchStartDate ? buildDayRange(searchStartDate).startTime : undefined
    const endTime = searchEndDate ? buildDayRange(searchEndDate).endTime : undefined

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
      const { startTime, endTime } = buildDayRange(reportDate)

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
      if (messages.length === 0) {
        setReportError('该日期未找到消息，请调整时间范围或检查过滤条件')
        setReportMessages([])
        setReportPrompt('')
        return
      }

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

  const handleSendMessage = async () => {
    const content = assistantInput.trim()
    if (!content || assistantStreaming) return

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
    setAssistantInput('')
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

  const handleSaveSchedule = async () => {
    setScheduleSaving(true)
    setScheduleError('')
    try {
      const payload: AssistantScheduleConfig = {
        ...scheduleConfig,
        filterMode,
        sessionIds: filterMode === 'whitelist' ? Array.from(selectedSessions) : [],
        excludeSessionIds: filterMode === 'blacklist' ? Array.from(selectedSessions) : []
      }
      const result = await window.electronAPI.assistant.setSchedule(payload)
      if (!result.success || !result.schedule) {
        setScheduleError(result.error || '保存失败')
        return
      }
      setScheduleConfig(result.schedule)
    } catch (e) {
      setScheduleError('保存过程中发生异常')
    } finally {
      setScheduleSaving(false)
    }
  }

  const handleRunScheduleNow = async () => {
    setScheduleSaving(true)
    setScheduleError('')
    try {
      const payload: Partial<AssistantScheduleConfig> = {
        rangeDays: scheduleConfig.rangeDays,
        filterMode,
        sessionIds: filterMode === 'whitelist' ? Array.from(selectedSessions) : [],
        excludeSessionIds: filterMode === 'blacklist' ? Array.from(selectedSessions) : []
      }
      const result = await window.electronAPI.assistant.runScheduleNow(payload)
      if (!result.success) {
        setScheduleError(result.error || '生成失败')
        return
      }
      const reportsResult = await window.electronAPI.assistant.getReports()
      if (reportsResult.success && reportsResult.reports) {
        setReports(reportsResult.reports)
      }
    } catch (e) {
      setScheduleError('生成过程中发生异常')
    } finally {
      setScheduleSaving(false)
    }
  }

  const handleReadReport = async (reportId: string) => {
    const result = await window.electronAPI.assistant.readReport(reportId)
    if (result.success && result.content) {
      setReportContent(result.content)
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
              <div className="assistant-session-list">
                {filteredSessions.map(session => (
                  <label key={session.username} className={selectedSessions.has(session.username) ? 'selected' : ''}>
                    <input
                      type="checkbox"
                      checked={selectedSessions.has(session.username)}
                      onChange={() => toggleSession(session.username)}
                    />
                    <span>{session.displayName || session.username}</span>
                  </label>
                ))}
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
                      <Send size={14} />发送到助理
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

          <section className="assistant-card">
            <div className="assistant-card-header">
              <Sparkles size={18} />
              <h2>自动总结</h2>
            </div>
            <div className="assistant-card-body">
              <div className="assistant-schedule-row">
                <label className="assistant-switch">
                  <input
                    type="checkbox"
                    checked={scheduleConfig.enabled}
                    onChange={(e) => setScheduleConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                  />
                  启用每日自动总结
                </label>
                <label>
                  执行时间
                  <input
                    type="time"
                    value={scheduleConfig.time}
                    onChange={(e) => setScheduleConfig(prev => ({ ...prev, time: e.target.value }))}
                  />
                </label>
                <label>
                  时间跨度（天）
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={scheduleConfig.rangeDays}
                    onChange={(e) => setScheduleConfig(prev => ({ ...prev, rangeDays: Number(e.target.value) }))}
                  />
                </label>
              </div>
              <div className="assistant-filter-hint">
                当前过滤模式会同步到自动总结：{filterMode === 'all' ? '全部会话' : filterMode === 'whitelist' ? '白名单' : '黑名单'}
              </div>
              {scheduleConfig.lastRunDate && (
                <div className="assistant-filter-hint">上次自动总结：{scheduleConfig.lastRunDate}</div>
              )}
              {scheduleError && <div className="assistant-error">{scheduleError}</div>}
              <div className="assistant-filter-actions">
                <button type="button" onClick={handleSaveSchedule} disabled={scheduleSaving}>
                  {scheduleSaving ? '保存中...' : '保存设置'}
                </button>
                <button type="button" onClick={handleRunScheduleNow} disabled={scheduleSaving}>
                  立即生成
                </button>
              </div>
              <div className="assistant-report-list">
                {reports.slice(0, 5).map(report => (
                  <button
                    type="button"
                    key={report.id}
                    className="assistant-report-item"
                    onClick={() => handleReadReport(report.id)}
                  >
                    <span>{report.title}</span>
                    <span>{new Date(report.createdAt).toLocaleString()}</span>
                  </button>
                ))}
                {reports.length === 0 && <div className="assistant-empty">暂无自动总结</div>}
              </div>
              <textarea
                value={reportContent}
                readOnly
                className="assistant-report-preview"
                placeholder="点击上方报告查看内容，支持复制后自行发送或对接接口..."
              />
            </div>
          </section>
        </div>

        <div className="assistant-panel assistant-panel--right">
          <section className="assistant-card assistant-chat">
            <div className="assistant-card-header">
              <Bot size={18} />
              <h2>AI 助理对话</h2>
            </div>
            <div className="assistant-chat-body">
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
          </section>
        </div>
      </div>
    </div>
  )
}

export default AssistantPage
