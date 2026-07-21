import {
  executeMcpRegistryTool
} from './mcpRegistry.js'
import {
  connectGitHubMcpClient,
  GITHUB_MCP_SERVER
} from './githubMcpClient.js'

const DEFAULT_ALLOWED_REPOSITORY =
  'DraugHel/EchoLink'
const MAX_RESULT_CHARS = 60_000

const TOOL_MAP = Object.freeze({
  github_profile: 'get_me',
  github_get_file: 'get_file_contents',
  github_get_commit: 'get_commit',
  github_list_commits: 'list_commits',
  github_search_code: 'search_code',
  github_list_issues: 'list_issues',
  github_get_issue: 'issue_read',
  github_list_pull_requests: 'list_pull_requests',
  github_get_pull_request: 'pull_request_read',
  github_list_actions: 'actions_list',
  github_get_action: 'actions_get',
  github_get_job_logs: 'get_job_logs',
  github_latest_release: 'get_latest_release'
})

export const GITHUB_TOOL_NAMES = new Set(
  Object.keys(TOOL_MAP)
)

function functionTool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        ...parameters
      }
    }
  }
}

const repositoryProperties = {
  owner: {
    type: 'string',
    description:
      'GitHub repository owner, normally DraugHel'
  },
  repo: {
    type: 'string',
    description:
      'GitHub repository name, normally EchoLink'
  }
}

export const GITHUB_TOOLS = [
  functionTool(
    'github_profile',
    'Read the authenticated GitHub account profile through the official GitHub MCP server. This is read-only.',
    { properties: {} }
  ),
  functionTool(
    'github_get_file',
    'Read a file or directory from an allowed GitHub repository through the official GitHub MCP server. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        path: {
          type: 'string',
          description:
            'Repository-relative file or directory path. Omit for the repository root.'
        },
        ref: {
          type: 'string',
          description:
            'Optional branch, tag, or Git ref'
        },
        sha: {
          type: 'string',
          description:
            'Optional exact commit SHA; takes precedence over ref'
        }
      },
      required: ['owner', 'repo']
    }
  ),
  functionTool(
    'github_list_commits',
    'List commits from an allowed GitHub repository. Use this to inspect recent changes or history. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        sha: {
          type: 'string',
          description: 'Optional branch, tag, or SHA'
        },
        path: {
          type: 'string',
          description: 'Optional file path filter'
        },
        author: {
          type: 'string',
          description: 'Optional author username or email'
        },
        since: {
          type: 'string',
          description: 'Optional ISO date or timestamp lower bound'
        },
        until: {
          type: 'string',
          description: 'Optional ISO date or timestamp upper bound'
        },
        page: { type: 'integer', minimum: 1 },
        perPage: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      },
      required: ['owner', 'repo']
    }
  ),
  functionTool(
    'github_get_commit',
    'Read details for one commit from an allowed GitHub repository. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        sha: {
          type: 'string',
          description: 'Commit SHA, branch, or tag'
        },
        detail: {
          type: 'string',
          enum: ['none', 'stats', 'full_patch'],
          description:
            'Use full_patch only when the actual diff is needed because it can be large.'
        },
        page: { type: 'integer', minimum: 1 },
        perPage: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      },
      required: ['owner', 'repo', 'sha']
    }
  ),
  functionTool(
    'github_search_code',
    'Search code in the configured allowed GitHub repository. EchoLink automatically restricts the query to an allowed repository. This is read-only.',
    {
      properties: {
        query: {
          type: 'string',
          description:
            'GitHub code search query without secrets. A repo qualifier is added automatically when omitted.'
        },
        page: { type: 'integer', minimum: 1 },
        perPage: {
          type: 'integer',
          minimum: 1,
          maximum: 30
        }
      },
      required: ['query']
    }
  ),
  functionTool(
    'github_list_issues',
    'List issues from an allowed GitHub repository. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        state: {
          type: 'string',
          enum: ['open', 'closed']
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 10
        },
        since: {
          type: 'string',
          description: 'Optional ISO timestamp'
        },
        perPage: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        },
        after: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  ),
  functionTool(
    'github_get_issue',
    'Read one issue, its comments, labels, parent, or sub-issues from an allowed GitHub repository. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        issue_number: {
          type: 'integer',
          minimum: 1
        },
        method: {
          type: 'string',
          enum: [
            'get',
            'get_comments',
            'get_sub_issues',
            'get_parent',
            'get_labels'
          ]
        },
        page: { type: 'integer', minimum: 1 },
        perPage: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      },
      required: [
        'owner',
        'repo',
        'issue_number',
        'method'
      ]
    }
  ),
  functionTool(
    'github_list_pull_requests',
    'List pull requests from an allowed GitHub repository. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all']
        },
        base: { type: 'string' },
        head: { type: 'string' },
        sort: { type: 'string' },
        direction: {
          type: 'string',
          enum: ['asc', 'desc']
        },
        page: { type: 'integer', minimum: 1 },
        perPage: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      },
      required: ['owner', 'repo']
    }
  ),
  functionTool(
    'github_get_pull_request',
    'Read details, diff, files, commits, checks, reviews, or comments for one pull request. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        pullNumber: {
          type: 'integer',
          minimum: 1
        },
        method: {
          type: 'string',
          enum: [
            'get',
            'get_diff',
            'get_status',
            'get_files',
            'get_commits',
            'get_review_comments',
            'get_reviews',
            'get_comments',
            'get_check_runs'
          ]
        },
        page: { type: 'integer', minimum: 1 },
        perPage: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        },
        after: { type: 'string' }
      },
      required: [
        'owner',
        'repo',
        'pullNumber',
        'method'
      ]
    }
  ),
  functionTool(
    'github_list_actions',
    'List GitHub Actions workflows, runs, jobs, or artifacts in an allowed repository. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        method: {
          type: 'string',
          enum: [
            'list_workflows',
            'list_workflow_runs',
            'list_workflow_jobs',
            'list_workflow_run_artifacts'
          ]
        },
        resource_id: {
          type: 'string',
          description:
            'Workflow ID/file or run ID when required by the selected method'
        },
        page: { type: 'integer', minimum: 1 },
        per_page: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        },
        workflow_runs_filter: {
          type: 'object',
          additionalProperties: true
        },
        workflow_jobs_filter: {
          type: 'object',
          additionalProperties: true
        }
      },
      required: ['owner', 'repo', 'method']
    }
  ),
  functionTool(
    'github_get_action',
    'Read details for a GitHub Actions workflow, run, job, usage, or logs URL. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        method: {
          type: 'string',
          enum: [
            'get_workflow',
            'get_workflow_run',
            'get_workflow_job',
            'get_workflow_run_usage',
            'get_workflow_run_logs_url'
          ]
        },
        resource_id: {
          type: 'string',
          description:
            'Workflow ID/file, workflow run ID, or job ID'
        }
      },
      required: [
        'owner',
        'repo',
        'method',
        'resource_id'
      ]
    }
  ),
  functionTool(
    'github_get_job_logs',
    'Read GitHub Actions job logs from an allowed repository. This is read-only.',
    {
      properties: {
        ...repositoryProperties,
        job_id: { type: 'integer', minimum: 1 },
        run_id: { type: 'integer', minimum: 1 },
        failed_only: { type: 'boolean' },
        return_content: {
          type: 'boolean',
          description:
            'Set true to return log content instead of URLs'
        },
        tail_lines: {
          type: 'integer',
          minimum: 1,
          maximum: 1000
        }
      },
      required: ['owner', 'repo']
    }
  ),
  functionTool(
    'github_latest_release',
    'Read the latest release from an allowed GitHub repository. This is read-only.',
    {
      properties: repositoryProperties,
      required: ['owner', 'repo']
    }
  )
]

function allowedRepositories(env = process.env) {
  const raw = String(
    env.GITHUB_MCP_ALLOWED_REPOS ||
      DEFAULT_ALLOWED_REPOSITORY
  )

  const entries = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))

  return [...new Set(entries)]
}

function repositoryKey(owner, repo) {
  return `${String(owner || '').trim()}/${String(repo || '').trim()}`
    .toLowerCase()
}

function assertAllowedRepository(args, env) {
  if (!('owner' in args) && !('repo' in args)) {
    return
  }

  const key = repositoryKey(args.owner, args.repo)
  const allowed = allowedRepositories(env)
    .map(value => value.toLowerCase())

  if (!allowed.includes(key)) {
    const error = new Error(
      `GitHub-Repository nicht erlaubt: ${args.owner}/${args.repo}`
    )
    error.name = 'GitHubMcpRepositoryBlockedError'
    throw error
  }
}

function scopeCodeSearch(args, env) {
  const query = String(args.query || '')
    .trim()
    .slice(0, 256)

  if (!query) {
    throw new Error('GitHub-Code-Suchanfrage fehlt')
  }

  const allowed = allowedRepositories(env)
  const qualifiers = [...query.matchAll(
    /(?:^|\s)repo:([^\s]+)/gi
  )].map(match => match[1].toLowerCase())

  if (qualifiers.length > 0) {
    const allowedLower = allowed.map(
      value => value.toLowerCase()
    )

    if (
      qualifiers.some(
        value => !allowedLower.includes(value)
      )
    ) {
      const error = new Error(
        'GitHub-Code-Suche außerhalb der erlaubten Repositories blockiert'
      )
      error.name = 'GitHubMcpRepositoryBlockedError'
      throw error
    }

    return { ...args, query }
  }

  if (allowed.length !== 1) {
    throw new Error(
      'GitHub-Code-Suche braucht bei mehreren erlaubten Repositories einen repo:owner/repo-Filter'
    )
  }

  return {
    ...args,
    query: `${query} repo:${allowed[0]}`
  }
}

function cleanArgs(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .filter(([, item]) =>
        item !== undefined &&
        item !== null &&
        item !== ''
      )
  )
}

function resultText(result) {
  const text = (result?.content || [])
    .filter(item => item?.type === 'text')
    .map(item => String(item.text || ''))
    .join('\n')
    .trim()

  let output = text

  if (!output && result?.structuredContent) {
    output = JSON.stringify(
      result.structuredContent,
      null,
      2
    )
  }

  if (!output) {
    output = result?.isError
      ? 'GitHub MCP returned an error without details'
      : 'GitHub MCP returned no content'
  }

  return output.slice(0, MAX_RESULT_CHARS)
}

export async function executeGitHubTool(
  toolName,
  rawArgs,
  {
    signal,
    source = 'chat',
    env = process.env,
    connectFn = connectGitHubMcpClient,
    now = Date.now
  } = {}
) {
  const officialTool = TOOL_MAP[toolName]

  if (!officialTool) {
    const error = new Error(
      `Unbekanntes GitHub-Tool blockiert: ${toolName}`
    )
    error.name = 'GitHubMcpToolBlockedError'
    throw error
  }

  let args = cleanArgs(rawArgs)

  if (toolName === 'github_search_code') {
    args = scopeCodeSearch(args, env)
  } else {
    assertAllowedRepository(args, env)
  }

  if (
    toolName === 'github_get_job_logs' &&
    !args.job_id &&
    !(args.failed_only === true && args.run_id)
  ) {
    throw new Error(
      'GitHub-Job-Logs benötigen job_id oder failed_only=true zusammen mit run_id'
    )
  }

  const result = await executeMcpRegistryTool(
    GITHUB_MCP_SERVER,
    officialTool,
    args,
    {
      signal,
      env,
      connectFn,
      source,
      now
    }
  )

  return resultText(result)
}

export function githubAllowedRepositories(
  env = process.env
) {
  return allowedRepositories(env)
}
