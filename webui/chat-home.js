const FILES_PROMPT = '列出清华云盘个人私有资料库中/Agent工作区的文件，不使用共享或公开资料库。';

// Prompt actions only describe drafts; callers decide when to submit them.
export const HOME_ACTIONS = Object.freeze([
  { id: 'assignments', label: '未交作业', icon: 'assignments', prompt: '查询本学期尚未提交的作业，按截止时间排序。' },
  { id: 'courses', label: '更新课程', icon: 'calendar', prompt: '增量更新本学期课程公告、作业和文件，先核对保存目标和变更范围；涉及写入时展示确认卡，等待我授权。' },
  { id: 'files', label: '云盘文件', icon: 'cloud', prompt: FILES_PROMPT },
  { id: 'rain', label: '雨课堂', icon: 'rain', prompt: '查看雨课堂当前课程与待办任务，只查询，不进入课堂或提交答题。' },
  { id: 'auth', label: '登录状态', icon: 'user', view: 'services' },
].map(Object.freeze));

export const ADD_ACTIONS = Object.freeze([
  { id: 'tools', label: '选择工具', icon: 'tools', view: 'tools' },
  { id: 'files', label: '云盘文件', icon: 'cloud', prompt: FILES_PROMPT },
  { id: 'workspace', label: '工作区设置', icon: 'cloud', view: 'settings' },
].map(Object.freeze));

// Paths share viewBox="0 0 24 24"; stroke and other presentation belong to the UI.
export const ICON_PATHS = Object.freeze({
  plus: 'M12 5v14M5 12h14',
  cloud: 'M7 18a4 4 0 0 1-.8-7.92 6 6 0 0 1 11.6 0A4 4 0 0 1 17 18H7Z',
  send: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M8 8h8v8H8Z',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.55-1L20 9M4 15l2.35 3A7 7 0 0 0 17.9 17',
  assignments: 'M9 5H6a1 1 0 0 0-1 1v14h14V6a1 1 0 0 0-1-1h-3M9 3h6v4H9ZM8 12l2 2 4-4M8 17h8',
  calendar: 'M4 5h16v15H4ZM8 3v4M16 3v4M4 10h16M8 14h2M14 14h2M8 17h2',
  rain: 'M4 4h16v13H4ZM9 20h6M12 17v3M10 7l5 3-5 3Z',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 21v-2a7 7 0 0 1 14 0v2',
  tools: 'M14 6a5 5 0 0 0-6 6L3 17l4 4 5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z',
});

export function getHomeAction(id) {
  return HOME_ACTIONS.find(action => action.id === id)
    ?? ADD_ACTIONS.find(action => action.id === id)
    ?? null;
}

export function homeIsEmpty(messages, busy = false) {
  return Array.isArray(messages) && messages.length === 0 && !busy;
}
