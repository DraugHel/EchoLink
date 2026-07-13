import {
  SEARCH_TOOL,
  FIRECRAWL_TOOL,
  TERMINAL_TOOL
} from './webSearch.js'
import { TASK_TOOLS } from './taskTools.js'
import { CALENDAR_TOOLS } from './calendarTools.js'

// Zentrale Tool-Liste für alle Modellanbieter.
// Mail- und Kalender-Tools werden später nur hier ergänzt.
export const ALL_TOOLS = [
  SEARCH_TOOL,
  FIRECRAWL_TOOL,
  TERMINAL_TOOL,
  ...CALENDAR_TOOLS,
  ...TASK_TOOLS
]
