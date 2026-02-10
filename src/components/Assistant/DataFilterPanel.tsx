import { useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { ChatSession } from '../../types/models'
import { useAssistantStore } from '../../stores/assistantStore'

function getAvatarText(name: string) {
  if (!name) return '?'
  return name.trim().slice(0, 1).toUpperCase()
}

interface DataFilterPanelProps {
  sessions: ChatSession[]
}

const modeLabels = {
  all: '全部',
  whitelist: '白名单',
  blacklist: '黑名单'
} as const

export default function DataFilterPanel({ sessions }: DataFilterPanelProps) {
  const { filterMode, selectedSessionIds, setFilterMode, toggleSession, setSelectedSessionIds, clearSelection } = useAssistantStore()
  const [sessionQuery, setSessionQuery] = useState('')
  const [friendGroupCollapsed, setFriendGroupCollapsed] = useState(false)
  const [groupGroupCollapsed, setGroupGroupCollapsed] = useState(false)

  const selectedSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds])

  const filteredSessions = useMemo(() => {
    const keyword = sessionQuery.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter(session =>
      (session.displayName || session.username).toLowerCase().includes(keyword)
    )
  }, [sessions, sessionQuery])

  const groupedSessions = useMemo(() => {
    const friendSessions = filteredSessions.filter(session => !session.username.includes('@chatroom'))
    const groupSessions = filteredSessions.filter(session => session.username.includes('@chatroom'))
    return { friendSessions, groupSessions }
  }, [filteredSessions])

  const handleSelectAll = () => {
    setSelectedSessionIds(filteredSessions.map(session => session.username))
  }

  return (
    <div className="assistant-filter-panel">
      <div className="assistant-filter-modes" role="tablist" aria-label="数据范围模式">
        {(Object.keys(modeLabels) as Array<keyof typeof modeLabels>).map(mode => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={filterMode === mode}
            className={`assistant-filter-mode ${filterMode === mode ? 'active' : ''}`}
            onClick={() => setFilterMode(mode)}
          >
            {modeLabels[mode]}
          </button>
        ))}
      </div>

      {filterMode !== 'all' && (
        <>
          <div className="assistant-filter-row">
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
            <button type="button" onClick={clearSelection}>清空选择</button>
            <span>已选 {selectedSessionIds.length} 个会话</span>
          </div>
          <div className="assistant-session-groups">
            <div className="assistant-session-group">
              <button
                type="button"
                className="assistant-session-group-header"
                onClick={() => setFriendGroupCollapsed(prev => !prev)}
              >
                <span>好友聊天</span>
                <span className="assistant-session-count">{groupedSessions.friendSessions.length}</span>
                <ChevronDown size={16} className={friendGroupCollapsed ? 'collapsed' : ''} />
              </button>
              <div className={`assistant-session-group-body ${friendGroupCollapsed ? 'collapsed' : ''}`}>
                {groupedSessions.friendSessions.map(session => (
                  <label
                    key={session.username}
                    className={`assistant-session-item ${selectedSet.has(session.username) ? 'selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(session.username)}
                      onChange={() => toggleSession(session.username)}
                    />
                    <span className="assistant-session-avatar">
                      {getAvatarText(session.displayName || session.username)}
                    </span>
                    <span className="assistant-session-name">{session.displayName || session.username}</span>
                    <span className={`assistant-session-check ${selectedSet.has(session.username) ? 'checked' : ''}`}>
                      <Check size={14} />
                    </span>
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
                <span>群聊</span>
                <span className="assistant-session-count">{groupedSessions.groupSessions.length}</span>
                <ChevronDown size={16} className={groupGroupCollapsed ? 'collapsed' : ''} />
              </button>
              <div className={`assistant-session-group-body ${groupGroupCollapsed ? 'collapsed' : ''}`}>
                {groupedSessions.groupSessions.map(session => (
                  <label
                    key={session.username}
                    className={`assistant-session-item ${selectedSet.has(session.username) ? 'selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(session.username)}
                      onChange={() => toggleSession(session.username)}
                    />
                    <span className="assistant-session-avatar">
                      {getAvatarText(session.displayName || session.username)}
                    </span>
                    <span className="assistant-session-name">{session.displayName || session.username}</span>
                    <span className={`assistant-session-check ${selectedSet.has(session.username) ? 'checked' : ''}`}>
                      <Check size={14} />
                    </span>
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
        </>
      )}

      {filterMode === 'all' && (
        <div className="assistant-filter-summary">
          当前范围：全部会话（共 {sessions.length} 个会话）
        </div>
      )}
    </div>
  )
}
