import { CUA_TOOL_PREFIX, OBSERVATION_TOOLS } from './results.js'

export class DesktopBudget {
  constructor({ maxDesktopCalls = 40, maxObservationCalls = 12, maxObservationElements = 150 } = {}) {
    this.maxDesktopCalls = maxDesktopCalls
    this.maxObservationCalls = maxObservationCalls
    this.maxObservationElements = maxObservationElements
    this.desktopCalls = 0
    this.observationCalls = 0
    this.exhausted = false
  }

  check(name, args = {}) {
    if (!name.startsWith(CUA_TOOL_PREFIX)) return undefined
    const tool = name.slice(CUA_TOOL_PREFIX.length)
    if (OBSERVATION_TOOLS.has(tool) && Number(args.max_elements) > this.maxObservationElements) {
      return `CONTEXT_BUDGET: max_elements must be <= ${this.maxObservationElements}; read only the current viewport or a narrower element set`
    }
    if (this.desktopCalls >= this.maxDesktopCalls) {
      this.exhausted = true
      return `CONTEXT_BUDGET: desktop call limit ${this.maxDesktopCalls} reached; stop using tools and report the partial result`
    }
    this.desktopCalls += 1
    if (OBSERVATION_TOOLS.has(tool)) {
      if (this.observationCalls >= this.maxObservationCalls) {
        this.exhausted = true
        return `CONTEXT_BUDGET: observation limit ${this.maxObservationCalls} reached; stop using tools and report the partial result`
      }
      this.observationCalls += 1
    }
    return undefined
  }
}
