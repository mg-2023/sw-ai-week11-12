/* 오목 데모 앱 — 상태는 루트 App 에만, 자식은 props 만 받는 순수 함수 (과제 제약) */
(function (root) {
  'use strict';

  const { h, useState, useMemo, useEffect } = root.MiniReact;
  const doc = root.document;

  const SIZE = 15;
  const NAME = { B: '흑돌', W: '백돌' };
  const STARS = new Set([3 * SIZE + 3, 3 * SIZE + 11, 7 * SIZE + 7, 11 * SIZE + 3, 11 * SIZE + 11]);
  const SAVE_DELAY = 600;

  const Omok = { App: null, SIZE, tick: () => {}, cause: '처음 그리기', setCause };
  root.Omok = Omok;

  /* 패널에 보일 "이번 갱신을 일으킨 동작" 이름을 정하는 함수 (엔진과 무관한 측정용 표시) */
  function setCause(name) {
    Omok.cause = name;
  }

  /* 빈 바둑판(225칸, 칸마다 null · 'B' · 'W')을 만드는 함수 */
  function emptyBoard() {
    return Array(SIZE * SIZE).fill(null);
  }

  /* i 번 칸에 둔 돌로 다섯 줄이 생겼으면 그 칸 번호들을, 아니면 null 을 돌려주는 함수 */
  function findWin(board, i) {
    const color = board[i];
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const line = [i];
      for (const s of [1, -1]) {
        let cx = x + dx * s;
        let cy = y + dy * s;
        while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy * SIZE + cx] === color) {
          line.push(cy * SIZE + cx);
          cx += dx * s;
          cy += dy * s;
        }
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  /* 초를 mm:ss 글자로 바꾸는 함수 */
  function clock(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  /* 칸 번호를 (가로, 세로) 좌표 글자로 바꾸는 함수 */
  function coord(i) {
    return `${(i % SIZE) + 1}, ${Math.floor(i / SIZE) + 1}`;
  }

  /* ms 뒤에 끝나는 약속을 돌려주는 함수 (모의 서버 저장용) */
  function wait(ms) {
    return new Promise((resolve) => root.setTimeout(resolve, ms));
  }

  // ───────── 자식 컴포넌트 : props 만 받는다 ─────────

  /* 플레이어 한 명의 돌 · 이름 · 시간 · 상태를 그리는 자식 */
  function PlayerCard({ color, seconds, active, winner }) {
    const state = winner === color ? '승리' : active ? '생각 중' : '대기 중';
    return h('div', { class: 'player' + (active ? ' active' : '') + (winner === color ? ' won' : '') },
      h('span', { class: 'stone ' + color }),
      h('div', { class: 'player-text' },
        h('strong', null, NAME[color]),
        h('span', { class: 'player-state' }, state)),
      h('span', { class: 'player-time' }, clock(seconds)));
  }

  /* 차례 · 상태 · 전체 시간과 게임 버튼을 그리는 자식 */
  function GameInfo({ turn, status, total, canUndo, onUndo, onNewGame, onResetAll }) {
    return h('section', { class: 'box' },
      h('h2', null, '게임 정보'),
      h('dl', { class: 'info' },
        h('dt', null, '현재 차례'), h('dd', null, h('span', { class: 'stone small ' + turn }), NAME[turn]),
        h('dt', null, '게임 상태'), h('dd', { class: 'status' }, status),
        h('dt', null, '전체 시간'), h('dd', null, clock(total))),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', onClick: onNewGame }, '새 게임'),
        h('button', { type: 'button', class: 'btn', onClick: onUndo, disabled: !canUndo }, '무르기'),
        h('button', { type: 'button', class: 'btn ghost', onClick: onResetAll }, '전체 초기화')));
  }

  /* 바둑판 한 칸(교차점)을 그리는 자식 */
  function Cell({ i, stone, last, win, locked, onPlace }) {
    const cls = 'cell' + (STARS.has(i) ? ' star' : '') + (last ? ' last' : '') + (win ? ' win' : '');
    return h('button', {
      type: 'button',
      class: cls,
      'data-i': i,
      'aria-label': `(${coord(i)}) ${stone ? NAME[stone] : '빈 칸'}`,
      disabled: locked || stone !== null,
      onClick: onPlace,
    }, stone ? h('span', { class: 'stone ' + stone }) : null);
  }

  /* 15×15 바둑판을 그리는 자식 */
  function Board({ board, last, winSet, locked, onPlace }) {
    return h('div', { class: 'board' },
      h('div', { class: 'grid' }),
      h('div', { class: 'cells' }, board.map((stone, i) => h(Cell, {
        i, stone, last: i === last, win: winSet.has(i), locked, onPlace,
      }))));
  }

  /* 둔 수 목록(기보)을 그리고, 누르면 그 수까지 돌아가게 하는 자식 */
  function MoveList({ history, moveIndex, onJump }) {
    const items = history.slice(1).map((step, n) => {
      const no = n + 1;
      const color = n % 2 === 0 ? 'B' : 'W';
      const cls = 'move' + (no === moveIndex ? ' current' : '') + (no > moveIndex ? ' future' : '');
      return h('li', null,
        h('button', { type: 'button', class: cls, 'data-to': no, onClick: onJump },
          h('span', { class: 'move-no' }, no),
          h('span', { class: 'stone small ' + color }),
          h('span', null, `(${coord(step.move)})`)));
    });
    return h('section', { class: 'box moves' },
      h('h2', null, '기보 ', h('small', null, `${moveIndex}수`)),
      items.length === 0
        ? h('p', { class: 'empty' }, '아직 둔 수가 없습니다')
        : h('ol', null, items),
      h('button', { type: 'button', class: 'btn', 'data-to': 0, onClick: onJump, disabled: moveIndex === 0 }, '처음으로'));
  }

  /* 모의 서버 저장 버튼과 결과를 그리는 자식 */
  function SaveBox({ saving, savedAt, onSave }) {
    const note = saving ? '저장 중…' : savedAt === null ? '저장한 적 없음' : `${savedAt}수까지 저장됨`;
    return h('section', { class: 'box save' },
      h('button', { type: 'button', class: 'btn', onClick: onSave, disabled: saving }, '기보 저장 (모의 서버)'),
      h('p', { class: 'save-note' }, note));
  }

  // ───────── 루트 : 모든 상태와 Hook 은 여기에만 ─────────

  /* 오목 상태(판 기록 · 현재 수 · 시간 · 저장)를 모두 가진 루트 */
  function App() {
    const [history, setHistory] = useState(() => [{ board: emptyBoard(), move: null }]);
    const [moveIndex, setMoveIndex] = useState(0);
    const [times, setTimes] = useState({ B: 0, W: 0 });
    const [total, setTotal] = useState(0);
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState(null);

    const current = history[moveIndex];
    const turn = moveIndex % 2 === 0 ? 'B' : 'W';
    const winLine = useMemo(() => (current.move === null ? null : findWin(current.board, current.move)), [current]);
    const winSet = useMemo(() => new Set(winLine || []), [winLine]);
    const winner = winLine ? current.board[current.move] : null;
    const full = moveIndex === SIZE * SIZE;
    const over = winner !== null || full;
    const status = winner ? `${NAME[winner]} 승리` : full ? '무승부' : '진행 중';

    useEffect(() => {
      doc.title = winner ? `${NAME[winner]} 승리 — 미니 리액트 오목` : `${NAME[turn]} 차례 — 미니 리액트 오목`;
    }, [turn, winner]);

    // 1초마다 setter 두 개 — 엔진 이벤트 밖(타이머)에서 부르는 갱신의 예
    useEffect(() => {
      if (over) { Omok.tick = () => {}; return undefined; }
      Omok.tick = () => {
        setCause('타이머 1초');
        setTimes((t) => ({ ...t, [turn]: t[turn] + 1 }));
        setTotal((s) => s + 1);
      };
      const id = root.setInterval(() => Omok.tick(), 1000);
      return () => root.clearInterval(id);
    }, [turn, over]);

    /* 누른 칸에 돌을 두는 함수 (판 기록과 현재 수 — setter 두 개) */
    const place = (e) => {
      const i = Number(e.currentTarget.dataset.i);
      if (over || current.board[i] !== null) return;
      setCause('착수');
      const board = current.board.slice();
      board[i] = turn;
      setHistory((list) => list.slice(0, moveIndex + 1).concat({ board, move: i }));
      setMoveIndex(moveIndex + 1);
    };
    /* 한 수 무르는 함수 */
    const undo = () => {
      setCause('무르기');
      setMoveIndex((m) => Math.max(0, m - 1));
    };
    /* 기보의 그 수로 돌아가는 함수 */
    const jump = (e) => {
      setCause('기보 이동');
      setMoveIndex(Number(e.currentTarget.dataset.to));
    };
    // 새 게임 · 전체 초기화는 moveIndex 를 먼저 0 으로 바꾼다.
    // 배칭이 없는 엔진(v0)은 setter 마다 렌더하므로, history 를 먼저 비우면
    // "기록은 1개인데 현재 수는 5" 인 중간 상태로 렌더하다 history[5] 가 없어 터진다.
    /* 판만 새로 시작하는 함수 (setter 두 개) */
    const newGame = () => {
      setCause('새 게임');
      setMoveIndex(0);
      setHistory([{ board: emptyBoard(), move: null }]);
    };
    /* 판 · 시간 · 저장 표시까지 모두 처음으로 돌리는 함수 (setter 다섯 개) */
    const resetAll = () => {
      setCause('전체 초기화');
      setMoveIndex(0);
      setHistory([{ board: emptyBoard(), move: null }]);
      setTimes({ B: 0, W: 0 });
      setTotal(0);
      setSavedAt(null);
    };
    /* 모의 서버에 저장하는 함수 — await 뒤의 setter 두 개는 엔진 이벤트 밖이다 */
    const save = async () => {
      const at = moveIndex;
      setCause('저장 시작');
      setSaving(true);
      await wait(SAVE_DELAY);
      setCause('저장 끝 (await 뒤)');
      setSaving(false);
      setSavedAt(at);
    };

    return h('div', { class: 'layout' },
      h('aside', { class: 'side' },
        h('section', { class: 'box' },
          h('h2', null, '플레이어'),
          h(PlayerCard, { color: 'B', seconds: times.B, active: !over && turn === 'B', winner }),
          h(PlayerCard, { color: 'W', seconds: times.W, active: !over && turn === 'W', winner })),
        h(GameInfo, { turn, status, total, canUndo: moveIndex > 0, onUndo: undo, onNewGame: newGame, onResetAll: resetAll })),
      h('div', { class: 'center' },
        h(Board, { board: current.board, last: current.move, winSet, locked: over, onPlace: place })),
      h('aside', { class: 'side' },
        h(MoveList, { history, moveIndex, onJump: jump }),
        h(SaveBox, { saving, savedAt, onSave: save })));
  }

  Omok.App = App;
  Omok.findWin = findWin;
})(globalThis);
