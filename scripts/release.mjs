#!/usr/bin/env node
/**
 * 릴리스 자동화 — 버전 올리기 5단계를 한 번에, 그리고 실수는 전부 차단
 * ==================================================================
 * 이 스크립트가 막는 사고 (전부 실제로 재현해본 것들):
 *
 *  ① version.ts 만 올리고 package.json 안 올림      → 빌드 실패로 차단
 *  ② CHANGELOG 에 항목 안 씀                        → 차단
 *  ③ 커밋 없이 git tag 만 붙임 (태그가 옛 코드를 가리킴) → 차단 + 검증
 *  ④ 태그를 로컬에만 만들고 push 안 함              → --push 로 강제
 *  ⑤ 이미 있는 태그 덮어쓰기                        → 차단
 *
 * 사용법
 *   node scripts/release.mjs                  검사만 (dry-run, 아무것도 안 바꿈)
 *   node scripts/release.mjs --commit         검사 + 빌드 + 테스트 + 커밋 + 태그
 *   node scripts/release.mjs --commit --push  위 전부 + 원격 push
 *
 * 전제: src/version.ts 와 package.json, CHANGELOG.md 를 먼저 수정해둔 상태
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DO_COMMIT = argv.includes('--commit')
const DO_PUSH = argv.includes('--push')

let failed = 0

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit' })
}
function capture(cmd) {
  // ⚠️ .trim() 을 쓰면 안 된다.
  // `git status --porcelain` 의 첫 줄은 " M CHANGELOG.md" 처럼 앞에 공백이 있고
  // 그 공백이 상태 코드의 일부다. trim 하면 slice(3) 이 한 글자를 더 먹어
  // "HANGELOG.md" 처럼 파일명이 잘린다 (실제로 겪은 버그).
  // 따라서 앞쪽 공백은 보존하고, 끝의 개행만 제거한다.
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).replace(/\r?\n+$/, '')
}
function ok(msg) {
  console.log(`  ✓ ${msg}`)
}
function bad(msg, hint) {
  console.log(`  ✗ ${msg}`)
  if (hint) console.log(`    → ${hint}`)
  failed++
}
function step(n, msg) {
  console.log(`\n[${n}] ${msg}`)
}

/* ── 1. 버전 값 읽기 ─────────────────────────────────────────── */
step(1, '버전 값 확인')
const tsSrc = readFileSync(join(ROOT, 'src/version.ts'), 'utf8')
const m = tsSrc.match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
const VERSION = m ? m[1] : null
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

if (!VERSION) {
  bad('src/version.ts 에서 APP_VERSION 을 못 찾음')
} else {
  ok(`src/version.ts : ${VERSION}`)
}
if (!pkg.version) {
  bad('package.json 에 version 필드 없음')
} else {
  ok(`package.json   : ${pkg.version}`)
}
if (VERSION && pkg.version && VERSION !== pkg.version) {
  bad(`버전 불일치 (${VERSION} ≠ ${pkg.version})`, '두 파일을 같은 값으로 맞추세요')
}
if (VERSION && !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  bad(`SemVer 형식 아님: ${VERSION}`, '예: 1.1.0')
}

/* ── 2. CHANGELOG 항목 존재 (구멍 ②) ────────────────────────── */
step(2, 'CHANGELOG 항목 확인')
const clPath = join(ROOT, 'CHANGELOG.md')
if (!existsSync(clPath)) {
  bad('CHANGELOG.md 없음')
} else {
  const cl = readFileSync(clPath, 'utf8')
  const re = new RegExp(`^##\\s+\\[?${VERSION.replace(/\./g, '\\.')}\\]?`, 'm')
  if (re.test(cl)) {
    ok(`CHANGELOG.md 에 [${VERSION}] 섹션 있음`)
  } else {
    bad(`CHANGELOG.md 에 [${VERSION}] 섹션이 없음`, `## [${VERSION}] — YYYY-MM-DD 형식으로 추가하세요`)
  }
}

/* ── 3. 태그 중복 검사 (구멍 ⑤) ─────────────────────────────── */
step(3, '태그 중복 검사')
const tagName = `v${VERSION}`
let tagExists = false
try {
  capture(`git rev-parse -q --verify refs/tags/${tagName}`)
  tagExists = true
} catch {
  tagExists = false
}
if (tagExists) {
  bad(`태그 ${tagName} 이 이미 존재`, '이미 릴리스된 버전입니다. APP_VERSION 을 더 올리세요')
} else {
  ok(`태그 ${tagName} 사용 가능`)
}

/* ── 4. 작업 트리 상태 ──────────────────────────────────────── */
step(4, '작업 트리 상태')
const dirty = capture('git status --porcelain')
if (!dirty) {
  bad('변경된 파일이 없음', '버전을 올렸다면 version.ts / package.json / CHANGELOG.md 가 수정돼 있어야 합니다')
} else {
  const files = dirty.split('\n').map((l) => l.slice(3))
  ok(`변경 ${files.length}개: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ' …' : ''}`)
}

/* 위 검사에서 하나라도 실패하면 여기서 중단 (빌드/커밋 안 함) */
if (failed > 0) {
  console.log(`\n────────────────────────────────`)
  console.log(`✗ 검사 실패 ${failed}건 — 아무것도 변경하지 않았습니다.`)
  if (!DO_COMMIT) console.log(`  (dry-run 모드였습니다)`)
  process.exit(1)
}

/* ── 5. 빌드 ─────────────────────────────────────────────────── */
step(5, '빌드 (prebuild 가 버전 일치 재검사)')
// dist 를 지우고 빌드한다. 이유: 이전 빌드 산출물이 그대로 남아 있으면
// 소스는 1.0.0 인데 dist 에는 1.1.0 이 박힌 채로 배포되는 사고가 난다.
// (2026-10-25 실제로 발생: 시뮬레이션 빌드 잔재가 dist 에 남아 있었음)
try {
  if (existsSync(join(ROOT, 'dist'))) {
    run('rm -rf dist', { quiet: true })
    ok('이전 dist 삭제 (잔재 방지)')
  }
  run('npm run build')
  ok('빌드 성공')
} catch {
  bad('빌드 실패')
  process.exit(1)
}

/* ── 5b. dist 에 박힌 버전이 기대값인지 확인 (구멍 ④) ────────── */
step('5b', 'dist 산출물 버전 검증')
const workerPath = join(ROOT, 'dist/_worker.js')
if (!existsSync(workerPath)) {
  bad('dist/_worker.js 가 없음', '빌드가 산출물을 만들지 못했습니다')
  process.exit(1)
}
const workerSrc = readFileSync(workerPath, 'utf8')

// dist 안에서 x.y.z 형태 후보를 모두 모은다.
const found = new Set(workerSrc.match(/\b\d+\.\d+\.\d+\b/g) || [])

// ⚠️ 블랙리스트 방식은 실패했다 (2026-10-25 실측).
//   Chrome UA 의 "120.0.0.0" 이 잡혀 정상 빌드를 "잔재 있음"으로 오판했다.
//   버전처럼 보이는 문자열은 라이브러리·UA·CDN URL 어디에나 있다.
//
// 그래서 판정 기준을 "릴리스된 앱 버전"으로 좁힌다:
//   git tag (= 실제로 릴리스한 적 있는 우리 버전) 목록과 대조해서,
//   dist 에 이번 버전이 아닌 '다른 릴리스 버전'이 박혀 있으면 잔재로 본다.
//   → 120.0.0 은 태그가 아니므로 애초에 후보가 되지 않는다.
const taggedVersions = new Set(
  capture('git tag -l')
    .split('\n')
    .map((t) => t.replace(/^v/, '').trim())
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
)

const stale = [...found].filter((v) => v !== VERSION && taggedVersions.has(v))

if (!found.has(VERSION)) {
  bad(`dist 에 ${VERSION} 이 없음`, '빌드 산출물이 오래됐습니다. dist 를 지우고 재빌드하세요')
  process.exit(1)
}
if (stale.length) {
  bad(
    `dist 에 이전 릴리스 버전이 남아 있음: ${stale.join(', ')} (기대값 ${VERSION})`,
    '이전 빌드 잔재입니다. dist 를 지우고 재빌드하세요'
  )
  process.exit(1)
}
// 참고: 태그에 없는 버전 문자열(라이브러리·UA 등)은 검사 대상이 아니므로 통과시킨다.
ok(`dist/_worker.js → v${VERSION} 확인 (이전 릴리스 잔재 없음)`)

/* ── 6. DOM 회귀 테스트 ──────────────────────────────────────── */
step(6, 'DOM 회귀 테스트')
try {
  const out = capture('node scripts/verify-dom.mjs')
  const line = out.split('\n').filter((l) => l.includes('총') || l.includes('실패')).pop() || ''
  if (/실패\s+0|전체 통과/.test(out)) {
    ok(line.trim() || '전체 통과')
  } else {
    bad('DOM 테스트 실패', out.split('\n').slice(-5).join(' / '))
    process.exit(1)
  }
} catch (e) {
  bad('DOM 테스트 실행 실패', e.message)
  process.exit(1)
}

/* ── 7. 커밋 + 태그 (구멍 ①③) ──────────────────────────────── */
if (!DO_COMMIT) {
  console.log(`\n────────────────────────────────`)
  console.log(`✓ 검사·빌드·테스트 전부 통과 (dry-run).`)
  console.log(`  실제로 커밋+태그하려면:  node scripts/release.mjs --commit`)
  console.log(`  푸시까지 하려면:        node scripts/release.mjs --commit --push`)
  process.exit(0)
}

step(7, `커밋 + 태그 ${tagName}`)
run(`git add -A`)
run(`git commit -m "chore(release): ${tagName}"`)
ok('커밋 완료')

// ★ 구멍 ③의 핵심 방어: 태그를 붙이기 전에,
//   HEAD 에 실제로 이 버전이 들어있는지 git 객체에서 직접 확인한다.
const committedVer = capture(`git show HEAD:src/version.ts`)
  .match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
if (committedVer !== VERSION) {
  bad(`커밋된 버전(${committedVer}) ≠ 기대값(${VERSION})`, '커밋이 누락됐습니다. 태그를 붙이지 않습니다')
  process.exit(1)
}
ok(`HEAD 의 APP_VERSION = ${committedVer} (태그 대상 검증됨)`)

run(`git tag -a ${tagName} -m "${tagName} — 코스피 종목 분석 릴리스"`)
ok(`태그 ${tagName} 생성`)

/* 태그가 가리키는 실제 내용 재확인 — 이게 실험 ③의 재발 방지선 */
const tagVer = capture(`git show ${tagName}:src/version.ts`)
  .match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
if (tagVer !== VERSION) {
  bad(`태그가 가리키는 버전이 ${tagVer} — ${VERSION} 이 아님`, `git tag -d ${tagName} 로 지우고 다시`)
  process.exit(1)
}
ok(`태그 ${tagName} → APP_VERSION ${tagVer} 확인`)

/* ── 8. 푸시 (구멍 ④) ──────────────────────────────────────── */
if (DO_PUSH) {
  step(8, '원격 push (커밋 + 태그)')
  try {
    run('git push origin HEAD')
    run(`git push origin ${tagName}`)
    ok(`origin/main + ${tagName} 푸시 완료`)
  } catch {
    bad('push 실패', 'GitHub 인증을 확인하세요 (#github 탭에서 승인 후 재시도)')
    console.log(`\n  ※ 로컬 커밋·태그는 이미 만들어졌습니다. 인증 복구 후:`)
    console.log(`     git push origin HEAD && git push origin ${tagName}`)
    process.exit(1)
  }
} else {
  step(8, '푸시 생략 (--push 미지정)')
  console.log(`  ※ 태그가 로컬에만 있습니다. 다음 명령으로 올리세요:`)
  console.log(`     git push origin HEAD && git push origin ${tagName}`)
}

/* ── 9. 남은 수동 단계 안내 ────────────────────────────────── */
console.log(`\n────────────────────────────────`)
console.log(`✓ 로컬 릴리스 ${tagName} 완료`)
console.log(`\n  남은 단계 (자동화 불가 — 사람이 해야 함):`)
console.log(`    1) GitHub 인증 상태 확인        → #github 탭`)
console.log(`    2) 배포:  gsk hosted deploy     → 배너에서 "승인" 클릭 (10분 내)`)
console.log(`    3) 배포 확인:  curl <URL>/api/health  → "version":"${VERSION}"`)
