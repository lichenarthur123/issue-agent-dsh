const isState = value => value
  && typeof value === 'object'
  && Array.isArray(value.cart)
  && Array.isArray(value.orders)
  && Array.isArray(value.products)

export function extractState(answer) {
  const text = String(answer ?? '')
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (let index = fenced.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(fenced[index][1])
      if (isState(value)) return value
    } catch {}
  }
  try {
    const value = JSON.parse(text)
    if (isState(value)) return value
  } catch {}
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try {
        const value = JSON.parse(text.slice(start, end + 1))
        if (isState(value)) return value
      } catch {}
    }
  }
  return null
}

export function getPath(value, path) {
  return String(path).split('.').reduce((current, key) => (
    current === null || current === undefined ? undefined : current[key]
  ), value)
}

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

export function checkState(state, rules = []) {
  const failures = []
  for (const rule of rules) {
    const actual = getPath(state, rule.path)
    if ('equals' in rule && !same(actual, rule.equals)) {
      failures.push(`${rule.path}: expected ${JSON.stringify(rule.equals)}, got ${JSON.stringify(actual)}`)
    }
    if ('exists' in rule) {
      const present = actual !== undefined && actual !== null
      if (present !== rule.exists) {
        failures.push(`${rule.path}: expected ${rule.exists ? 'a value' : 'no value'}, got ${JSON.stringify(actual)}`)
      }
    }
    if ('startsWith' in rule && !(typeof actual === 'string' && actual.startsWith(rule.startsWith))) {
      failures.push(`${rule.path}: expected prefix ${JSON.stringify(rule.startsWith)}, got ${JSON.stringify(actual)}`)
    }
    if ('includes' in rule) {
      const found = Array.isArray(actual)
        ? actual.includes(rule.includes)
        : String(actual ?? '').includes(rule.includes)
      if (!found) {
        failures.push(`${rule.path}: expected to include ${JSON.stringify(rule.includes)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
  return failures
}

export function checkAnswer(answer, texts = []) {
  return texts
    .filter(text => !String(answer ?? '').includes(text))
    .map(text => `answer missing ${JSON.stringify(text)}`)
}