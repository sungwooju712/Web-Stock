#!/usr/bin/env node
/**
 * 버전 일치 검사
 * ------------------------------------------------------------------
 * src/version.ts 의 APP_VERSION 과 package.json 의 version 이
 * 같은지 확인한다. 다르면 exit 1.
 *
 * 사용: npm run version:check
 *      (빌드 전 prebuild 훅에 넣어도 좋다)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

// version.ts 에서 APP_VERSION = '1.0.0' 추출
const ts = read('src/version.ts')
const m = ts.match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
if (!m) {
  console.error('✗ src/version.ts 에서 APP_VERSION 을 찾지 못했습니다.')
  process.exit(1)
}
const tsVersion = m[1]

// package.json 에서 version 추출
const pkg = JSON.parse(read('package.json'))
const pkgVersion = pkg.version

console.log(`  src/version.ts : ${tsVersion}`)
console.log(`  package.json   : ${pkgVersion ?? '(없음)'}`)

if (!pkgVersion) {
  console.error('✗ package.json 에 version 필드가 없습니다.')
  process.exit(1)
}

if (tsVersion !== pkgVersion) {
  console.error(`\n✗ 버전 불일치: ${tsVersion} (version.ts) ≠ ${pkgVersion} (package.json)`)
  console.error('  두 곳을 같은 값으로 맞춰주세요.')
  process.exit(1)
}

// SemVer 형식 검사
if (!/^\d+\.\d+\.\d+$/.test(tsVersion)) {
  console.error(`\n✗ SemVer 형식이 아닙니다: ${tsVersion} (예: 1.0.0)`)
  process.exit(1)
}

console.log(`\n✓ 버전 일치: v${tsVersion}`)
