import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('release smoke rejects a healthy but outdated backend and accepts the expected features with protected routes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'linkmai-feedback-smoke-'))
  try {
    writeFileSync(path.join(root, 'curl'), `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; output=$1 ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  */api/health) printf '%s' "$TASK_HEALTH_JSON" > "$output"; printf '200' ;;
  */api/auth/wechat/login) printf '{}' > "$output"; printf '400' ;;
  *) printf '{}' > "$output"; printf '401' ;;
esac
`, { mode: 0o755 })
    for (const [health, expected] of [
      [{ status: 'ok', database: 'ok' }, 1],
      [{ status: 'ok', database: 'ok', features: { paymentOrderHistory: false, contextualAgent: true } }, 1],
      [{ status: 'ok', database: 'ok', features: { paymentOrderHistory: true, contextualAgent: true } }, 0],
    ] as const) {
      const result = spawnSync('bash', [path.resolve(__dirname, 'smoke-production.sh'), 'https://api.example.test'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TASK_HEALTH_JSON: JSON.stringify(health) },
        encoding: 'utf8', timeout: 5000,
      })
      assert.equal(result.status, expected, result.stdout + result.stderr)
      if (expected === 0) assert.match(result.stdout, /GET \/api\/payment-orders -> 401/)
      else assert.match(result.stderr, /后端缺少订单列表/)
    }
    for (const [release, expected] of [
      [{ sha: 'older-sha', id: 'candidate-release' }, 1],
      [{ sha: 'candidate-sha', id: 'older-release' }, 1],
      [{ sha: 'candidate-sha', id: 'candidate-release' }, 0],
    ] as const) {
      const result = spawnSync('bash', [path.resolve(__dirname, 'smoke-production.sh'), 'https://api.example.test'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`,
          TASK_HEALTH_JSON: JSON.stringify({ status: 'ok', database: 'ok', release,
            features: { paymentOrderHistory: true, contextualAgent: true } }),
          LINKMAI_EXPECTED_SHA: 'candidate-sha', LINKMAI_EXPECTED_RELEASE_ID: 'candidate-release' },
        encoding: 'utf8', timeout: 5000,
      })
      assert.equal(result.status, expected, result.stdout + result.stderr)
      if (expected === 0) assert.match(result.stdout, /smoke tests 通过/)
      else assert.match(result.stderr, /release\/SHA 与候选版本不匹配/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
