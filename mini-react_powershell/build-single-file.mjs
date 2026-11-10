// dist의 결과를 HTML 파일 하나로 합칩니다. 서버 없이 더블클릭으로 열기 위해서입니다.
// 파일을 직접 열면 브라우저가 외부 모듈 스크립트를 막기 때문에, 내용을 HTML 안에 넣습니다.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fromRoot = (path) => fileURLToPath(new URL(path, import.meta.url))

const SCRIPT_TAG = /\s*<script type="module" crossorigin src="\/(assets\/[^"]+\.js)"><\/script>/
const STYLE_TAG = /<link rel="stylesheet" crossorigin href="\/(assets\/[^"]+\.css)">/
const ICON_TAG = /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/
const STYLE_ICON = /url\(["']?\/favicon\.svg["']?\)/

function matchOrThrow(html, pattern, name) {
  const match = html.match(pattern)
  if (!match) throw new Error(`dist/index.html에서 ${name} 태그를 찾지 못했습니다. npm run build를 먼저 실행하세요.`)
  return match
}

const html = await readFile(fromRoot('./dist/index.html'), 'utf8')
const [, scriptPath] = matchOrThrow(html, SCRIPT_TAG, '스크립트')
const [, stylePath] = matchOrThrow(html, STYLE_TAG, '스타일')
matchOrThrow(html, ICON_TAG, '아이콘')

const [script, style, icon] = await Promise.all([
  readFile(fromRoot(`./dist/${scriptPath}`), 'utf8'),
  readFile(fromRoot(`./dist/${stylePath}`), 'utf8'),
  readFile(fromRoot('./dist/favicon.svg')),
])

// 글자 </script>가 있으면 HTML 파서가 그 자리에서 태그를 끝내므로 끊어 둡니다.
const safeScript = script.replaceAll('</script', '<\\/script')
const iconUrl = `data:image/svg+xml;base64,${icon.toString('base64')}`

// 머리글 아이콘도 같은 그림입니다. 파일 하나로 열면 /favicon.svg 경로가 없으므로 안에 넣습니다.
if (!STYLE_ICON.test(style)) throw new Error('스타일에서 머리글 아이콘을 찾지 못했습니다.')
const safeStyle = style.replaceAll('</style', '<\\/style').replace(STYLE_ICON, () => `url("${iconUrl}")`)

// 함수로 감싸 최상위 변수가 location 같은 브라우저 전역 이름과 충돌하지 않게 합니다.
const inlineScript = `<script>(() => {\n${safeScript}\n})()</script>`

// 번들에는 $가 많습니다. 문자열로 치환하면 $&가 특수 기호로 해석되므로 함수로 넘깁니다.
const output = html
  .replace(SCRIPT_TAG, () => '')
  .replace(STYLE_TAG, () => `<style>\n${safeStyle}\n</style>`)
  .replace(ICON_TAG, () => `<link rel="icon" type="image/svg+xml" href="${iconUrl}" />`)
  .replace('</body>', () => `  ${inlineScript}\n  </body>`)

await writeFile(fromRoot('./mini-react.html'), output)
console.log(`mini-react.html을 만들었습니다. (${Math.round(output.length / 1024)}KB)`)
