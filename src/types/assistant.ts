export interface AssistantMessage {
  sessionId: string
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
}

export type AssistantFilterMode = 'all' | 'whitelist' | 'blacklist'

export interface AssistantScheduleConfig {
  enabled: boolean
  time: string
  rangeDays: number
  filterMode: AssistantFilterMode
  sessionIds: string[]
  excludeSessionIds: string[]
  lastRunDate?: string
}

export interface AssistantReportInfo {
  id: string
  filePath: string
  createdAt: number
  title: string
}
