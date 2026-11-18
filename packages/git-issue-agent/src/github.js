export const resultMarker = (repository, issueNumber) => `<!-- dsh-issue-agent:${repository}#${issueNumber} -->`

export class GitHubIssues {
  constructor(settings, fetchImpl = fetch) {
    this.settings = settings
    this.fetch = fetchImpl
  }

  async request(method, path, body) {
    const response = await this.fetch(`${this.settings.apiBase}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.settings.token}`,
        'user-agent': 'dsh-git-issue-agent',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`GitHub ${method} ${path}: ${response.status} ${text.slice(0, 300)}`)
    }
    return response.status === 204 ? null : response.json()
  }

  async listIssues() {
    const { repository, triggerLabel, maxIssuesPerPoll } = this.settings
    const query = new URLSearchParams({
      state: 'open',
      labels: triggerLabel,
      sort: 'created',
      direction: 'asc',
      per_page: String(maxIssuesPerPoll),
    })
    const issues = await this.request('GET', `/repos/${repository}/issues?${query}`)
    return issues.filter(issue => !issue.pull_request).sort((a, b) => a.number - b.number)
  }

  async hasResultComment(issueNumber) {
    const { repository } = this.settings
    const comments = await this.request(
      'GET',
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100`,
    )
    const marker = resultMarker(repository, issueNumber)
    return comments.some(comment => comment.body?.includes(marker))
  }

  comment(issueNumber, body) {
    return this.request(
      'POST',
      `/repos/${this.settings.repository}/issues/${issueNumber}/comments`,
      { body },
    )
  }
}

export function buildComment(record) {
  const result = record.result
  const lines = [
    resultMarker(record.repository, record.issue.number),
    `### DSH desktop agent · \`${result.status}\``,
    '',
    `- duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `- session: \`${result.sessionId}\``,
  ]
  if (result.desktopToolCalls !== undefined) lines.push(`- desktop calls: ${result.desktopToolCalls}`)
  if (result.groundingCalls) lines.push(`- grounding calls: ${result.groundingCalls}`)
  if (result.cleanup) lines.push(`- cleanup: \`${result.cleanup.status}\``)
  if (result.error) lines.push(`- error: \`${result.error.code}\` ${result.error.message ?? ''}`.trim())
  if (result.plan) lines.push('', '**CUA plan**', '', result.plan)
  lines.push('', '**Response**', '', result.answer?.trim() || 'Agent finished without a text response.')
  return lines.join('\n')
}
