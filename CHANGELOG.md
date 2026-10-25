# 변경 이력 (CHANGELOG)

이 프로젝트는 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따릅니다.

| 규칙 | 의미 |
|---|---|
| `v1.0.x` | 기존 기능의 **버그 수정**만 (동작 변화 없음) |
| `v1.1.0` | **기능 추가** (새 화면·새 지표·새 다운로드 등) |
| `v2.0.0` | 기존 동작이 **깨지는** 구조 변경 |

버전 값의 단일 출처는 **`src/version.ts`** 이며, `package.json` 의 `version` 과 항상 일치해야 합니다.
불일치 시 `npm run version:check` 가 실패합니다.

---

## [1.0.0] — 2026-10-24 · 첫 공식 릴리스 (동결)

지금까지 만든 모든 기능을 **v1.0.0으로 확정**합니다. 이후 추가되는 자료는 v1.1.0부터 쌓입니다.

### 스크리너 (조건검색)
- 코스피 전 종목 **942개** 스냅샷 기반 조건검색
- 시가총액 · 부채비율 · 영업이익률 · PER · ROE · 배당수익률 필터
- 분기 실적 5종 지표 (매출 YoY/QoQ, 영업이익 YoY/QoQ, 영업이익 연속 흑자)
- 업종 패싯 · 정렬 · 즐겨찾기 · 메모 · CSV 내보내기
- 종목 상세 드로어 (연간 + 분기 실적)

### 주요 종목 분석 뷰
- **종목 추가 / 삭제** — 코스피 종목 자동완성 검색, 칩·카드 양쪽에서 삭제
- **최대 8종목** 동시 비교 (8색 팔레트 자동 배정)
- `localStorage`에 선택 종목 저장 → 재방문 시 복원
- "기본 4종목으로" 원클릭 복원
- 최소 1종목 보존 가드 (실수로 전부 삭제 방지)

### 차트 / 표
- 종가 추이 라인 차트 (일별)
- 월별 종가 막대 차트 (46개월)
- 연간 종가 막대 차트 (4개년)
- 요약표 · 월별표 · 연간표 — **종목 수에 따라 헤더·행 자동 확장**
- 기간 최고가 / 최저가 / 장중 고가 및 발생일

### 다운로드
- **보고서 HTML** (인쇄 → PDF 가능)
- **엑셀 5시트**: `한장보고` · `전체보고` · `일일종가` · `월별종가` · `연간데이터`

### 운영 / 브랜드
- 브랜드명 **"코스피 종목 분석"** 전면 통일 (title · h1 · 푸터 · 파비콘 · 보고서 · 엑셀 · 파일명)
- 만든 사람 크레딧 카드 (최미경)
- **MIT 라이선스**
- GitHub 공개 저장소: <https://github.com/sungwooju712/Web-Stock>
- **버전 표기 시스템** 도입 — 푸터 배지 + `/api/health` + `/api/meta` + `/api/prices`
- **코스피 전용 정책** 4중 방어 (수집기 ×2 · 런타임 화이트리스트 · 종목 조회 API)

### 검증
- jsdom 실제 DOM 하네스 **32개 검증 전부 통과**
  (`node scripts/verify-dom.mjs`)
- 엑셀 원본 대조: 삼성전자 213,500 / SK하이닉스 1,263,000 / 2023년말 대비 +171.97% / +792.58%

---

## [Unreleased] — 다음 릴리스 (v1.1.0 예정)

추가 요청이 들어오면 여기에 먼저 적고, 완료 시 `[1.1.0]` 으로 옮깁니다.

- (아직 없음)

---

## 버전 올리는 방법 (개발자용)

> ⚠️ **수동 5단계에는 구멍이 3개 있습니다** (2026-10-25 실제 재현 결과)
> ① `git commit` 없이 `git tag` 만 붙이면 → **태그가 옛 코드를 가리킴**
>    (`git show v1.1.0-demo:src/version.ts` → `APP_VERSION = '1.0.0'` 로 확인됨)
> ② `git push origin vX.Y.Z` 를 빼먹으면 → 태그가 **로컬에만** 남음
> ③ `CHANGELOG.md` 를 안 써도 → **아무도 막지 않음**
>
> 그래서 **`scripts/release.mjs`** 를 만들었습니다. 이걸 쓰세요.

### ✅ 권장 — 한 줄 릴리스

```bash
# 먼저 세 파일 수정
#   1) src/version.ts   APP_VERSION = '1.1.0'
#   2) package.json     "version": "1.1.0"
#   3) CHANGELOG.md     ## [1.1.0] — YYYY-MM-DD  섹션 추가

npm run release            # 검사만 (dry-run)
npm run release:commit     # 검사 + 빌드 + DOM 32개 + 커밋 + 태그
npm run release:push       # 위 전부 + 원격 push
```

`release.mjs` 가 자동으로 막는 것:

| # | 검사 | 실패 시 |
|---|---|---|
| 1 | `version.ts` ↔ `package.json` 일치 + SemVer 형식 | 빌드조차 안 함 |
| 2 | `CHANGELOG.md` 에 `[해당 버전]` 섹션 존재 | 중단 |
| 3 | 태그 중복 (`vX.Y.Z` 이미 존재?) | 중단 |
| 4 | 작업 트리에 변경사항 있는지 | 중단 |
| 5 | 빌드 (prebuild 가 1번 재검사) | 중단 |
| 6 | DOM 회귀 테스트 32개 | 중단 |
| 7 | 커밋 후 `git show HEAD:src/version.ts` 로 실제 버전 재확인 | **태그 안 붙임** |
| 8 | 태그 생성 후 `git show vX.Y.Z:src/version.ts` 재확인 | 실패 처리 |
| 9 | `--push` 없으면 "태그가 로컬에만 있음" 경고 | 경고 |

### 수동으로 할 경우 (스크립트 없이)

```bash
1. src/version.ts     APP_VERSION 수정
2. package.json       version 수정 (같은 값)
3. CHANGELOG.md       새 항목 추가
4. npm run version:check          # 일치 확인
5. npm run build                  # prebuild 재검사
6. node scripts/verify-dom.mjs    # 32개 검증
7. git add -A && git commit -m "chore(release): v1.1.0"   # ← 이 줄 필수
8. git tag -a v1.1.0 -m "v1.1.0"
9. git show v1.1.0:src/version.ts | grep APP_VERSION     # ← 태그 대상 검증
10. git push origin HEAD && git push origin v1.1.0       # ← 태그 push 필수
11. gsk hosted deploy            # 배너에서 승인 (10분 내)
12. curl <URL>/api/health        # {"version":"1.1.0"} 확인
```
