const HELPER_URL = 'http://127.0.0.1:47631/notify'

/**
 * notify-helper.ps1에 Windows 알림과 작업표시줄 깜빡임을 부탁합니다.
 * 응답을 읽을 필요가 없어서 no-cors로 보내고, 프로그램이 꺼져 있으면 조용히 넘어갑니다.
 */
export function notifyDesktop(title: string, message: string): void {
  fetch(HELPER_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ title, message }),
  }).catch(() => {})
}
