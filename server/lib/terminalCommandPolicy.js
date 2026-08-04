const READ_ONLY_COMMANDS = new Set([
  'basename', 'b2sum', 'cat', 'cksum', 'column', 'cut', 'date', 'df',
  'dirname', 'du', 'echo', 'file', 'free', 'getent', 'grep', 'head', 'jq',
  'hostname', 'id', 'lsof', 'md5sum', 'nl', 'pgrep', 'pidof', 'printenv',
  'printf', 'ps', 'pwd', 'readlink', 'realpath', 'rg', 'sha1sum',
  'sha256sum', 'sort', 'ss', 'stat', 'tac', 'tail', 'tr', 'true',
  'false', 'uname', 'uniq', 'uptime', 'wc', 'which', 'who', 'whoami'
])

const SHELL_LOCAL_COMMANDS = new Set([
  'cd', 'declare', 'export', 'local', 'popd', 'pushd', 'readonly', 'set',
  'shift', 'test', 'typeset', 'unset'
])

const CONTROL_ONLY = new Set([
  'do', 'done', 'else', 'esac', 'fi', 'in', 'then', '{', '}'
])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const DANGEROUS_FIND = /-(?:delete|exec|execdir|fprint|fprintf|fls|ok|okdir)\b/
const DANGEROUS_AWK = /\bsystem\s*\(|\b(?:getline|close)\s*\(|\||(?:^|[^<])>(?![>=])/i
const WRITE_SQL = /\b(?:alter|attach|backup|begin|commit|create|delete|detach|drop|insert|load_extension|reindex|release|replace|rollback|savepoint|update|vacuum)\b|\.\s*(?:backup|clone|dump|import|load|once|output|read|restore|save|shell|system)/i
const READ_ONLY_PRAGMA = /^(?:application_id|collation_list|compile_options|database_list|encoding|foreign_key_check|foreign_key_list|foreign_keys|freelist_count|function_list|index_info|index_list|index_xinfo|integrity_check|journal_mode|module_list|page_count|page_size|pragma_list|quick_check|schema_version|table_info|table_list|table_xinfo|user_version)$/i
const READ_ONLY_SQLITE_DOT_COMMAND = /^\.(?:databases|indexes|schema|tables)(?:\s|$)/i
const SAFE_PYTHON_MODULES = new Set([
  'collections', 'datetime', 'hashlib', 'json', 'math', 'pathlib', 're',
  'statistics', 'sys'
])
const FORBIDDEN_PYTHON = [
  /\b(?:breakpoint|compile|delattr|eval|exec|getattr|globals|locals|setattr|vars|__import__)\s*\(/,
  /\b(?:aiohttp|ctypes|ftplib|http\.client|multiprocessing|requests|shutil|socket|subprocess|urllib)\b/,
  /\bopen\s*\(/,
  /\bpathlib\.(?:Path|PurePath)\([^\n]*\)\.(?:chmod|hardlink_to|link_to|lchmod|mkdir|open|rename|replace|rmdir|symlink_to|touch|unlink|write_bytes|write_text)\b/,
  /\.(?:chmod|hardlink_to|link_to|lchmod|mkdir|open|rename|replace|rmdir|symlink_to|touch|unlink|write_bytes|write_text)\b/,
  /\b(?:os|posix)\.(?:chmod|chown|exec\w*|fork|kill|link|lchown|makedirs|mkdir|popen|remove|removedirs|rename|renames|replace|rmdir|spawn\w*|symlink|system|truncate|unlink)\s*\(/,
  /\bsys\.modules\b/,
  /\b__\w+__\b/
]

export const NEVER_AUTO_APPROVE = /^(?:rm|rmdir|mv|cp|install|touch|dd|mkfs|shred|shutdown|reboot|halt|poweroff|kill|killall|pkill|chmod|chown|truncate|useradd|userdel|usermod|groupadd|groupdel|fdisk|parted|wipefs|iptables|nft|ufw|tee|xargs|eval|source|exec|bash|sh|zsh|python3?|perl|ruby|node|npx|curl|wget)\b|^(?:pm2\s+(?:delete|kill|flush|restart|reload|start|stop))\b|^(?:git\s+(?:add|apply|am|checkout|cherry-pick|clean|commit|fetch|merge|pull|push|rebase|reset|restore|revert|switch|tag))\b|^(?:docker\s+(?:build|compose|container|exec|image|kill|network|pull|push|restart|rm|rmi|run|start|stop|system\s+prune|volume\s+(?:create|prune|rm)))\b|^(?:npm\s+(?:install|uninstall|remove|run|start|stop|restart|publish))\b/i

const DESTRUCTIVE_EXECUTABLES = new Set([
  'rm', 'rmdir', 'shred', 'unlink',
  'mkfs', 'wipefs', 'fdisk', 'parted',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'kill', 'killall', 'pkill', 'truncate'
])

const DESTRUCTIVE_INTERPRETER_SOURCE =
  /\b(?:unlink|remove|rmdir|removedirs|rmtree)\s*\(|\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(|\bfs\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/i

const NESTED_DESTRUCTIVE_COMMAND =
  /(?:^|[;&|(`\n]\s*)(?:command\s+|sudo\s+|env\s+)*(?:rm|rmdir|shred|unlink|mkfs|wipefs|fdisk|parted|shutdown|reboot|halt|poweroff|kill|killall|pkill|truncate)\b/i

function shellWords(source) {
  const words = []
  let word = ''
  let quote = null
  let escaped = false

  const push = () => {
    if (word) words.push(word)
    word = ''
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (escaped) {
      word += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    word += char
  }
  if (escaped || quote) return null
  push()
  return words
}

function matchingParen(source, start) {
  let depth = 1
  let quote = null
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function substitutionsAreReadOnly(source, classify) {
  let quote = null
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"'
      continue
    }
    if (char === '`') return false

    const isCommandSubstitution = char === '$' && source[i + 1] === '('
    const isProcessSubstitution = (char === '<' || char === '>') && source[i + 1] === '('
    if (!isCommandSubstitution && !isProcessSubstitution) continue
    if (isCommandSubstitution && source[i + 2] === '(') return false
    const bodyStart = i + 2
    const end = matchingParen(source, bodyStart)
    if (end < 0 || !classify(source.slice(bodyStart, end)).readOnly) return false
    i = end
  }
  return quote === null && !escaped
}

function splitCommands(source) {
  const segments = []
  let start = 0
  let quote = null
  let escaped = false
  let parenDepth = 0

  const push = end => {
    const value = source.slice(start, end).trim()
    if (value) segments.push(value)
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '(') {
      parenDepth += 1
      continue
    }
    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1
      continue
    }
    if (parenDepth > 0) continue

    const pair = source.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      push(i)
      i += 1
      start = i + 1
      continue
    }
    if (char === ';' || char === '|' || char === '\n') {
      push(i)
      start = i + 1
      continue
    }
    if (char === '&' && source[i - 1] !== '>' && source[i - 1] !== '<') {
      return null
    }
  }
  if (quote || escaped || parenDepth !== 0) return null
  push(source.length)
  return segments
}

function redirectionsAreReadOnly(segment) {
  let masked = ''
  let quote = null
  let escaped = false
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]
    if (escaped) {
      masked += 'Q'
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      masked += 'Q'
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      masked += 'Q'
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      masked += 'Q'
      continue
    }
    masked += char
  }

  // Descriptor duplication and writes to /dev/null do not persist data.
  const withoutSafe = masked
    .replace(/\d*[<>]&\d+/g, '')
    .replace(/(?:\d*>>?|&>)\s*\/dev\/null\b/g, '')
    .replace(/\d*<<<[^;|\n]*/g, '')
    .replace(/\d*<<?\s*[^;|\n\s]+/g, '')
  return !/(?:^|[^<])>{1,2}|&>|<<|<>/.test(withoutSafe)
}

function unwrapBash(command) {
  const login = command.match(/^bash\s+-lc\s+([\s\S]+)$/)
  if (login) {
    const value = login[1].trim()
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1)
    }
    return null
  }

  const heredoc = command.match(/^bash(?:\s+-s)?\s+<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n([\s\S]*)$/)
  if (!heredoc) return command
  const lines = heredoc[2].split('\n')
  if (lines.at(-1)?.trim() !== heredoc[1]) return null
  return lines.slice(0, -1).join('\n')
}

function pythonBodyIsReadOnly(body) {
  if (FORBIDDEN_PYTHON.some(pattern => pattern.test(body))) return false

  for (const match of body.matchAll(/^\s*import\s+([^#\n]+)$/gm)) {
    const modules = match[1].split(',').map(value =>
      value.trim().split(/\s+as\s+/i)[0].split('.')[0]
    )
    if (modules.some(module => !SAFE_PYTHON_MODULES.has(module))) return false
  }

  for (const match of body.matchAll(/^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/gm)) {
    if (!SAFE_PYTHON_MODULES.has(match[1].split('.')[0])) return false
  }

  const imports = body.match(/^\s*(?:from|import)\s+[^\n]+$/gm) || []
  const recognizedImports = [
    ...body.matchAll(/^\s*import\s+[^#\n]+$/gm),
    ...body.matchAll(/^\s*from\s+[A-Za-z_][A-Za-z0-9_.]*\s+import\s+[^\n]+$/gm)
  ]
  return imports.length === recognizedImports.length
}

function pythonHeredocInvocationIsReadOnly(command, body) {
  const words = shellWords(command)
  if (!words) return false
  while (words.length && ASSIGNMENT.test(words[0])) words.shift()
  const executable = words.shift()?.split('/').at(-1)
  if (!/^python3?$/.test(executable || '') || words[0] !== '-') return false
  return pythonBodyIsReadOnly(body)
}

function sanitizeVerifiedHeredocs(source) {
  const lines = source.split('\n')
  const output = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/^(.*?)(<<-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3\s*$/)
    if (!match) {
      output.push(line)
      continue
    }

    const command = match[1].trim()
    const stripTabs = match[2] === '<<-'
    const marker = match[4]
    const body = []
    let end = index + 1
    for (; end < lines.length; end += 1) {
      const candidate = stripTabs ? lines[end].replace(/^\t+/, '') : lines[end]
      if (candidate === marker) break
      body.push(lines[end])
    }
    if (end >= lines.length) return null
    if (!pythonHeredocInvocationIsReadOnly(command, body.join('\n'))) return null

    output.push('true')
    index = end
  }

  return output.join('\n')
}

function curlIsReadOnly(args) {
  const urls = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (/^\d*[<>]&\d+$/.test(arg)) continue
    if (arg === '--output' || arg === '-o') {
      if (args[index + 1] !== '/dev/null') return false
      index += 1
      continue
    }
    if (arg.startsWith('--output=')) {
      if (arg !== '--output=/dev/null') return false
      continue
    }
    if (arg === '--request' || arg === '-X') {
      if (!/^(?:GET|HEAD)$/i.test(args[index + 1] || '')) return false
      index += 1
      continue
    }
    if (/^--request=/.test(arg)) {
      if (!/^--request=(?:GET|HEAD)$/i.test(arg)) return false
      continue
    }
    if (arg === '--write-out' || arg === '-w') {
      if (/%output\{/.test(args[index + 1] || '')) return false
      index += 1
      continue
    }
    if (arg.startsWith('--write-out=')) {
      if (/%output\{/.test(arg)) return false
      continue
    }
    if (/^(?:-d|-F|-T|-K|-O|-c)$/.test(arg) ||
        /^--(?:alt-svc|config|cookie-jar|create-dirs|data(?:-[A-Za-z0-9_-]+)?|dump-header|etag-save|form(?:-[A-Za-z0-9_-]+)?|hsts|libcurl|output-dir|remote-header-name|remote-name|remove-on-error|stderr|trace|trace-ascii|upload-file)(?:=|$)/.test(arg)) {
      return false
    }
    if (/^-[^-]*[dFTKOc]/.test(arg)) return false
    if (/^https?:\/\//i.test(arg)) urls.push(arg)
  }

  return urls.length > 0 && urls.every(url =>
    /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(?:\d+|\$\{[A-Za-z_][A-Za-z0-9_]*\}))?(?:\/|$)/i.test(url)
  )
}

function commandIsReadOnly(words, raw) {
  while (words.length && ASSIGNMENT.test(words[0])) words.shift()
  if (!words.length) return true

  while (['if', 'elif', 'while', 'until', 'then', 'do', 'else'].includes(words[0])) {
    words.shift()
  }
  if (!words.length || CONTROL_ONLY.has(words[0])) return true
  if (words[0] === 'for') return true
  if (words[0] === '[[' || words[0] === '[' || words[0] === '((') return true

  const executable = words[0].split('/').at(-1)
  const args = words.slice(1)
  if (!executable || executable.includes('$')) return false
  if (READ_ONLY_COMMANDS.has(executable) || SHELL_LOCAL_COMMANDS.has(executable)) {
    if (executable === 'date' && args.some(arg => arg === '-s' || arg.startsWith('--set'))) return false
    if (executable === 'hostname' && args.some(arg => !arg.startsWith('-'))) return false
    if (executable === 'sort' && args.some(arg => arg === '-o' || arg.startsWith('--output'))) return false
    return true
  }
  if (executable === 'command') return args[0] === '-v' || args[0] === '-V'
  if (executable === 'curl') return curlIsReadOnly(args)
  if (executable === 'node') return args[0] === '--check' && args.length === 2
  if (executable === 'find') return !DANGEROUS_FIND.test(raw)
  if (executable === 'awk' || executable === 'gawk') return !DANGEROUS_AWK.test(raw)
  if (executable === 'git') {
    const gitArgs = [...args]
    while (gitArgs[0] === '-C' && gitArgs.length >= 2) gitArgs.splice(0, 2)
    while (gitArgs[0] === '--no-pager') gitArgs.shift()
    const subcommand = gitArgs[0] || ''
    return /^(?:status|log|diff|show|rev-parse|ls-files|ls-tree|ls-remote|cat-file|describe)$/.test(subcommand) ||
      (subcommand === 'branch' && gitArgs.includes('--show-current')) ||
      (subcommand === 'stash' && gitArgs[1] === 'list') ||
      (subcommand === 'remote' && (
        gitArgs.length === 1 ||
        gitArgs[1] === '-v' ||
        gitArgs[1] === 'show' ||
        gitArgs[1] === 'get-url'
      ))
  }
  if (executable === 'pm2') {
    return /^(?:status|list|ls|info|show|describe|jlist)$/.test(args[0] || '') ||
      (args[0] === 'logs' && args.includes('--nostream'))
  }
  if (executable === 'systemctl') {
    const action = args.find(arg => !arg.startsWith('-')) || ''
    return /^(?:status|show|is-active|is-failed|list-units|list-unit-files)$/.test(action)
  }
  if (executable === 'journalctl') {
    return !args.some(arg => /^(?:--flush|--relinquish-var|--rotate|--sync|--vacuum)/.test(arg))
  }
  if (executable === 'docker') {
    if (/^(?:ps|logs|images|inspect|info|version|stats)$/.test(args[0] || '')) return true
    if (args[0] === 'system' && args[1] === 'df') return true
    return /^(?:ls|inspect)$/.test(args[1] || '') && /^(?:container|image|network|volume)$/.test(args[0] || '')
  }
  if (executable === 'sqlite3') {
    const sqliteArgs = [...args]
    if (sqliteArgs[0] === '-readonly') sqliteArgs.shift()
    if (!sqliteArgs.length || sqliteArgs[0].startsWith('-')) return false
    sqliteArgs.shift()
    const sql = sqliteArgs.join(' ').trim()
    if (!sql || WRITE_SQL.test(sql)) return false
    if (sql.startsWith('.')) return READ_ONLY_SQLITE_DOT_COMMAND.test(sql)

    const statements = sql.split(';').map(value => value.trim()).filter(Boolean)
    return statements.length > 0 && statements.every(statement => {
      if (/^(?:select|with\b[\s\S]*\bselect|explain(?:\s+query\s+plan)?\s+select)\b/i.test(statement)) {
        return true
      }
      const pragma = statement.match(/^pragma\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?$/i)
      return Boolean(pragma && READ_ONLY_PRAGMA.test(pragma[1]))
    })
  }
  if (executable === 'tar') {
    const lists = args.some(arg => /^-[^-]*t/.test(arg) || arg === '--list')
    const mutates = args.some(arg => /^(?:--append|--concatenate|--create|--delete|--extract|--update)$/.test(arg) || /^-[^-]*[Acdrux]/.test(arg))
    return lists && !mutates
  }
  if (executable === 'unzip') return args.includes('-l') || args.includes('-Z')
  return false
}

function destructiveGitReason(args) {
  const gitArgs = [...args]
  while (gitArgs[0] === '-C' && gitArgs.length >= 2) {
    gitArgs.splice(0, 2)
  }
  while (gitArgs[0] === '--no-pager') gitArgs.shift()

  const subcommand = gitArgs.shift() || ''
  if (subcommand === 'clean') return 'git clean ist gesperrt'
  if (
    subcommand === 'reset' &&
    gitArgs.some(arg => arg === '--hard' || arg.startsWith('--hard='))
  ) {
    return 'git reset --hard ist gesperrt'
  }
  if (
    subcommand === 'push' &&
    gitArgs.some(arg =>
      arg === '-f' ||
      arg === '--force' ||
      arg.startsWith('--force=') ||
      arg === '--force-with-lease' ||
      arg.startsWith('--force-with-lease=') ||
      arg === '--delete' ||
      arg.startsWith('--delete=') ||
      arg.startsWith('+') ||
      arg.startsWith(':')
    )
  ) {
    return 'erzwungener oder löschender Git-Push ist gesperrt'
  }
  if (
    subcommand === 'branch' &&
    gitArgs.some(arg => arg === '-d' || arg === '-D' || arg === '--delete')
  ) {
    return 'Löschen von Git-Branches ist gesperrt'
  }
  if (
    subcommand === 'tag' &&
    gitArgs.some(arg => arg === '-d' || arg === '--delete')
  ) {
    return 'Löschen von Git-Tags ist gesperrt'
  }
  if (
    subcommand === 'worktree' &&
    ['remove', 'prune'].includes(gitArgs[0] || '')
  ) {
    return 'Entfernen von Git-Worktrees ist gesperrt'
  }
  if (
    (subcommand === 'update-ref' && gitArgs.includes('-d')) ||
    (subcommand === 'symbolic-ref' && gitArgs.includes('--delete'))
  ) {
    return 'Löschen von Git-Referenzen ist gesperrt'
  }
  return ''
}

function destructiveDockerReason(args) {
  const scope = args[0] || ''
  const action = args[1] || ''
  if (['rm', 'rmi'].includes(scope)) {
    return 'Docker-Entfernung ist gesperrt'
  }
  if (
    ['container', 'image', 'network', 'volume', 'system', 'builder', 'buildx']
      .includes(scope) &&
    ['rm', 'remove', 'prune'].includes(action)
  ) {
    return 'Docker-Entfernung oder Prune ist gesperrt'
  }
  if (
    scope === 'compose' &&
    ['down', 'rm'].includes(action)
  ) {
    return 'Docker-Compose-Entfernung ist gesperrt'
  }
  return ''
}

function destructiveSqlReason(executable, args) {
  if (!['sqlite3', 'psql', 'mysql', 'mariadb'].includes(executable)) {
    return ''
  }
  const sql = args.join(' ')
  if (/\b(?:delete\s+from|drop\s+(?:table|database|index|view|trigger)|truncate\s+(?:table\s+)?)\b/i.test(sql)) {
    return 'löschendes SQL ist gesperrt'
  }
  if (/\.\s*(?:shell|system)\b[\s\S]*\b(?:rm|rmdir|unlink|shred)\b/i.test(sql)) {
    return 'löschender SQL-Shell-Aufruf ist gesperrt'
  }
  return ''
}

function destructiveCommandReason(words, raw) {
  const normalized = [...words]
  while (normalized.length && ASSIGNMENT.test(normalized[0])) {
    normalized.shift()
  }
  while (
    ['if', 'elif', 'while', 'until', 'then', 'do', 'else'].includes(
      normalized[0]
    )
  ) {
    normalized.shift()
  }
  if (!normalized.length || CONTROL_ONLY.has(normalized[0])) return ''
  if (normalized[0] === 'for' || normalized[0] === '[[' || normalized[0] === '[') {
    return ''
  }

  while (normalized[0] === 'command' || normalized[0] === 'sudo') {
    const wrapper = normalized.shift()
    if (wrapper === 'sudo') {
      while (normalized[0]?.startsWith('-')) {
        const option = normalized.shift()
        if (/^(?:-u|-g|-h|-p|-C|--user|--group|--host|--prompt|--chdir)$/.test(option)) {
          normalized.shift()
        }
      }
    } else {
      while (normalized[0]?.startsWith('-')) normalized.shift()
    }
  }
  if (normalized[0] === 'env') {
    normalized.shift()
    while (
      normalized[0]?.startsWith('-') ||
      ASSIGNMENT.test(normalized[0] || '')
    ) {
      normalized.shift()
    }
  }

  const executable = normalized.shift()?.split('/').at(-1) || ''
  const args = normalized
  if (DESTRUCTIVE_EXECUTABLES.has(executable)) {
    return `${executable} ist als destruktiver Befehl gesperrt`
  }
  if (
    executable === 'find' &&
    args.some(arg =>
      arg === '-delete' ||
      ['-exec', '-execdir', '-ok', '-okdir'].includes(arg)
    ) &&
    /(?:-delete\b|-(?:exec|execdir|ok|okdir)\b[\s\S]*\b(?:rm|rmdir|unlink|shred)\b)/i.test(raw)
  ) {
    return 'löschendes find ist gesperrt'
  }
  if (
    executable === 'xargs' &&
    args.some(arg => DESTRUCTIVE_EXECUTABLES.has(arg.split('/').at(-1)))
  ) {
    return 'löschendes xargs ist gesperrt'
  }
  if (executable === 'git') return destructiveGitReason(args)
  if (executable === 'docker') return destructiveDockerReason(args)
  if (
    ['npm', 'pnpm', 'yarn'].includes(executable) &&
    ['remove', 'rm', 'uninstall'].includes(args[0] || '')
  ) {
    return 'Entfernen von Paketen ist gesperrt'
  }
  if (
    ['apt', 'apt-get', 'dnf', 'yum'].includes(executable) &&
    ['autoremove', 'purge', 'remove'].includes(args[0] || '')
  ) {
    return 'Entfernen von Systempaketen ist gesperrt'
  }

  const sqlReason = destructiveSqlReason(executable, args)
  if (sqlReason) return sqlReason

  if (
    ['bash', 'sh', 'zsh'].includes(executable) &&
    ['-c', '-lc'].includes(args[0] || '') &&
    args[1]
  ) {
    return classifyDestructiveTerminalCommand(args[1]).reason
  }
  if (
    ['python', 'python3', 'node', 'perl', 'ruby'].includes(executable) &&
    DESTRUCTIVE_INTERPRETER_SOURCE.test(raw)
  ) {
    return 'löschender Interpreter-Code ist gesperrt'
  }
  return ''
}

export function classifyDestructiveTerminalCommand(command) {
  const original = typeof command === 'string' ? command.trim() : ''
  if (!original) return { destructive: false, reason: '' }

  const unwrapped = unwrapBash(original)
  const source = unwrapped === null ? original : unwrapped
  const segments = splitCommands(source)

  if (segments?.length) {
    for (const segment of segments) {
      const words = shellWords(segment)
      if (!words) continue
      const reason = destructiveCommandReason(words, segment)
      if (reason) return { destructive: true, reason }
    }
  }

  if (NESTED_DESTRUCTIVE_COMMAND.test(source)) {
    return {
      destructive: true,
      reason: 'verschachtelter destruktiver Befehl ist gesperrt'
    }
  }
  if (DESTRUCTIVE_INTERPRETER_SOURCE.test(source)) {
    return {
      destructive: true,
      reason: 'löschender Interpreter-Code ist gesperrt'
    }
  }
  return { destructive: false, reason: '' }
}

export function isDestructiveTerminalCommand(command) {
  return classifyDestructiveTerminalCommand(command).destructive
}

export function classifyTerminalCommand(command, options = {}) {
  const original = typeof command === 'string' ? command.trim() : ''
  if (!original) return { readOnly: false, reason: 'Leerer oder ungültiger Befehl' }

  const unwrapped = unwrapBash(original)
  if (unwrapped === null) {
    return { readOnly: false, reason: 'Shell-Wrapper konnte nicht sicher analysiert werden' }
  }
  const source = sanitizeVerifiedHeredocs(unwrapped)
  if (source === null) {
    return { readOnly: false, reason: 'Nicht lesendes oder unklares Heredoc' }
  }

  const classifyNested = nested => classifyTerminalCommand(nested)
  if (!substitutionsAreReadOnly(source, classifyNested)) {
    return { readOnly: false, reason: 'Nicht lesende oder unklare Shell-Substitution' }
  }

  const segments = splitCommands(source)
  if (!segments?.length) {
    return { readOnly: false, reason: 'Shell-Struktur konnte nicht sicher analysiert werden' }
  }

  for (const segment of segments) {
    if (!redirectionsAreReadOnly(segment)) {
      return { readOnly: false, reason: 'Ausgabeumleitung kann Dateien verändern' }
    }
    const words = shellWords(segment)
    if (!words || !commandIsReadOnly([...words], segment)) {
      const allowed = options.allowedPrefixes || []
      const explicitlyAllowed = allowed.some(prefix =>
        typeof prefix === 'string' &&
        prefix.length >= 3 &&
        !NEVER_AUTO_APPROVE.test(prefix) &&
        segment.startsWith(prefix)
      )
      if (!explicitlyAllowed) {
        return { readOnly: false, reason: `Nicht als read-only erkannt: ${words?.[0] || 'Shell-Segment'}` }
      }
    }
  }

  return { readOnly: true, reason: 'Semantisch read-only; keine Freigabe erforderlich' }
}

export function isReadOnlyTerminalCommand(command, options = {}) {
  return classifyTerminalCommand(command, options).readOnly
}
