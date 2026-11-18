import { defineTool } from '@deepseek-ai/dsh-tools'
import { log, logModelEnd, logModelStart } from './log.js'
import { captureWindow } from './window.js'

const GROUNDING_PROMPT = `You are a GUI agent. You are given a task and your action history, with screenshots. You need to perform the next action to complete the task.

## Output Format

Action: ...

## Action Space
click(point='<point>x1 y1</point>')

## User Instruction
`

export function parseGroundingPoint(text, width, height) {
  const match = /<point>\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*<\/point>/i.exec(text)
    ?? /(?:point|start_box)\s*=\s*['"]?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)['"]?/i.exec(text)
  if (!match) throw new Error('grounder returned no click point')
  const x = Math.round(Number(match[1]))
  const y = Math.round(Number(match[2]))
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error(`grounder point (${x},${y}) is outside ${width}x${height}`)
  }
  return { x, y, width, height }
}

const DROPDOWN_RULE = 'If a dropdown menu or popup is open, click the matching option inside that menu or popup; never click identical text elsewhere on the page, in cards, or in filter chips.'

function cropAround(anchor) {
  const width = anchor.width ?? 1568
  const height = anchor.height ?? 980
  const w = Math.min(720, width)
  const h = Math.min(520, height)
  const x1 = Math.max(0, Math.min(Math.round(anchor.x - w / 2), width - w))
  const y1 = Math.max(0, Math.min(Math.round(anchor.y - 100), height - h))
  return { x1, y1, x2: x1 + w, y2: y1 + h }
}

export async function groundUi(ctx, agent, settings, { pid, window_id, instruction, context = '', anchor = null, reference = null }, signal) {
  log.ground(instruction)
  const crop = anchor ? cropAround(anchor) : null
  if (crop) log.ground(`crop=(${crop.x1},${crop.y1})-(${crop.x2},${crop.y2}) around the open dropdown`)
  let usedZoom = Boolean(crop)
  let stored = await captureWindow(ctx, agent, { pid, window_id, maxElements: 1, crop })
  if (usedZoom && (!stored.ref.width || !stored.ref.height)) {
    log.ground('zoom returned no dimensions; falling back to the full screenshot')
    usedZoom = false
    stored = await captureWindow(ctx, agent, { pid, window_id, maxElements: 1 })
  }
  if (!stored.ref.width || !stored.ref.height) throw new Error('window screenshot dimensions are unavailable')
  const text = `${instruction}${context ? `\ncontext: ${context}` : ''}\n${DROPDOWN_RULE}${reference
    ? `\nreference_point: (${reference.x},${reference.y}). The target is near this reference point; choose the closest matching element to it and never pick a same-named element far away.`
    : ''}`

  const ask = async image => {
    const startedAt = logModelStart(settings.grounder, {
      parts: {
        sys: Buffer.byteLength(GROUNDING_PROMPT),
        user: Buffer.byteLength(text),
        image: image.data?.byteLength ?? 0,
      },
    })
    const response = await fetch(`${settings.grounder.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: settings.grounder.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `${GROUNDING_PROMPT}${text}` },
            { type: 'image_url', image_url: { url: `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}` } },
          ],
        }],
        max_tokens: 100,
        temperature: 0,
      }),
      signal,
    })
    if (!response.ok) throw new Error(`grounder HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const payload = await response.json()
    const content = payload.choices?.[0]?.message?.content ?? ''
    logModelEnd(settings.grounder, startedAt, payload.usage, content)
    try {
      return parseGroundingPoint(content, image.ref.width, image.ref.height)
    } catch (error) {
      if (!usedZoom) throw error
      log.ground(`${error.message}; retrying with the full screenshot`)
      usedZoom = false
      const full = await captureWindow(ctx, agent, { pid, window_id, maxElements: 1 })
      return parseGroundingPoint(content, full.ref.width, full.ref.height)
    }
  }

  let point = await ask(stored)
  if (reference && !usedZoom) {
    const distance = Math.hypot(point.x - reference.x, point.y - reference.y)
    if (distance > 450) {
      log.ground(`point is ${Math.round(distance)}px from the reference; retrying with a zoom crop`)
      usedZoom = true
      stored = await captureWindow(ctx, agent, { pid, window_id, maxElements: 1, crop: cropAround(reference) })
      point = await ask(stored)
    }
  }
  log.ground(`point=(${point.x},${point.y}) window=${point.width}x${point.height}${usedZoom ? ' from_zoom' : ''}`)
  if (usedZoom) return { ...point, fromZoom: true }
  if (settings.grounding) {
    settings.grounding.lastPoint = { x: point.x, y: point.y, width: point.width, height: point.height }
  }
  return point
}

export function registerGrounder(ctx, settings) {
  ctx.tools.register(defineTool({
    name: 'desktop_ground_ui',
    description: 'Use UI-TARS to locate a GUI target in one exact window when AX cannot identify a reliable click target. Returns window-local screenshot pixel coordinates; does not click.',
    parameters: {
      pid: { type: 'integer', required: true, description: 'Target application process ID' },
      window_id: { type: 'integer', required: true, description: 'Target window ID' },
      instruction: { type: 'string', required: true, description: 'Short target description, such as: 点击计算器上的等于按钮' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('desktop_ground_ui requires an agent')
      return groundUi(ctx, exec.agent, settings, args, exec.signal)
    },
  }))
}
