/**
 * 内置残局闯关数据（30 关）
 * 直接引用自原开源项目 Chess-Chess 残局库（DB/KaiJuKu.db · CanJuKu 表）
 * FEN 说明：行从上到下以 / 分隔，小写=黑方，大写=红方，数字=连续空格；
 * 原始数据无先后手段，按残局惯例红方先行（引擎 createFromFen 默认红先）。
 */

export interface EndgameLevel {
  /** 原项目残局库 rowid */
  id: number;
  name: string;
  comment: string;
  fen: string;
}

export const BUILTIN_ENDGAMES: EndgameLevel[] = [
  { id: 1, name: '钓鱼马', comment: '用马在对方三·三或七·三位置上“照将”，或者控制对方将的活动，然后借马之力，用车或兵将死对方。', fen: '2b1ka3/4aP3/4b1N2/9/9/7R1/9/6r1B/2ppA2n1/2BAK4' },
  { id: 2, name: '拔簧马', comment: '车借用马的力量，进行抽将得子，直到将死对方。', fen: '3a1k3/4a4/b3c3b/6N2/2r6/6R2/6c2/4C4/3pA4/4KA3' },
  { id: 3, name: '立马车', comment: '运用车、马联攻，巧妙构成杀局的一种常用杀法。利用对方主将不归位的弱点，用马控制其进退的路线，用车发动猛攻，迫使投子认输。', fen: '5a3/4a4/3k5/9/9/6N2/1R7/4p4/8n/3AKA2r' },
  { id: 31, name: '白马现蹄', comment: '运用弃车引离战术，造成对方九宫士角的防守据点失控，使处在对方下二路横线上的马，能够“挂角照将”而构成的巧妙杀法，称为“白马现蹄”杀法。', fen: '4ka3/1N1ca4/4b4/3R5/6b2/9/4p4/4B4/4Arr2/R2AK1B2' },
  { id: 32, name: '双马饮泉', comment: '一方双马相依，左右盘旋，用一马控制住对方将门，另一马借抽将之机，跳到“九宫”另一侧将死对方。', fen: '4kab2/1N2a4/4b4/3N5/6n2/6B2/1n7/4B4/4Ap3/3AK4' },
  { id: 33, name: '卧槽马', comment: '用马在对方底象的前一格位置上“卧槽”，使对方将不安于位，然后用其他子力趁势把对方将死。', fen: '4kab2/3Pa4/2n1b1R2/9/6pN1/9/6C2/9/4rp3/3K5' },
  { id: 34, name: '挂角马', comment: '用马在对方九宫的任何一个士角位置上“将军”，使对方将不安于位，然后运用其他子力把对方将死。', fen: '1n1ak4/4a1P2/1c2b3b/1NC6/9/9/9/9/9/2BAKAB2' },
  { id: 35, name: '侧面虎(高钓马)', comment: '用马在对方三．四或七．四位置上，限制将的活动，然后用其他子力将死对方。', fen: 'N2ak1bR1/4a4/4b4/9/6p2/2P6/2r6/4B4/3pA4/1cBAK4' },
  { id: 36, name: '八角马', comment: '用马在对方九宫的任何一个士角位置上，与对方将形成对角，使其失去活动自由，然后用其他子力将死对方，也称“八角定将”杀法。', fen: '3a1k3/N5P2/3a4c/4n4/9/1C7/9/9/2p1A1p2/3K1A3' },
  { id: 37, name: '马后炮', comment: '马与对方将在同一条直线或横线上，中间空一格，限制将不能左右活动，然后以马为炮架，用炮紧跟其后将死对方。', fen: '2bak4/4a4/4b4/9/4N4/4C4/3n5/B3B4/3pA4/c3KA3' },
  { id: 38, name: '空头炮', comment: '炮与对方将在同一条直线上，使其士象不能正常卫护将，然后借炮之威，用其他子力抽将或一举杀死对方。', fen: '3ak1b2/4aR3/4b4/4p4/9/4C4/R3c1r1r/4C1n1B/4A4/1cBAK4' },
  { id: 39, name: '天地炮', comment: '一炮在中路，一炮在底路，分别牵制对方的防守子力，然后用其他子力配合攻杀而将死对方。', fen: '1r2ka3/4a4/b3c4/n8/6b2/2PR5/4C4/Bp2C4/4A4/c2K1AB2' },
  { id: 40, name: '夹车炮', comment: '双炮集于一翼，与车相呼应，在对方侧翼底路三条横行在线交替“将军”而获胜。又称二路夹車炮、三蝶穿花。', fen: '3a1k2C/2c1a4/6C2/9/1r7/7R1/9/9/c3A4/3K1A3' },
  { id: 41, name: '车炮抽杀', comment: '一方的车炮在对方中路、底线或其他线路，车借炮力，形成抽将得子。而在一些特定的形势下，运用技巧可以直接取得胜利，这种情况经常能够遇到，非常实用。', fen: 'C3ka3/1RR1a4/b3c4/9/9/9/7r1/9/4A1r2/3A1K3' },
  { id: 42, name: '重炮', comment: '双炮重叠在一条直线上，一炮在前充当炮架，一炮在后“将军”，或一炮在前“将军”，一炮在后控制，一举将死对方。', fen: '2b1kac2/3Pa2c1/9/4p4/2b6/6B2/4C4/4C4/5p3/3AKAB2' },
  { id: 43, name: '炮碾丹砂', comment: '一方用炮侵入对方底线，借助车的力量，辗转扫荡对方士、象或其他子力，从而将死对方。', fen: '1nbak4/4a2Rc/4b4/9/9/9/2C3C2/6n2/2r2p3/3AKA3' },
  { id: 44, name: '闷宫杀法', comment: '利用对方双士自阻将易受“背攻”的弱点，用单炮把对方将将死在九宫原位。', fen: '4ka3/4a4/4b1n2/4c1C2/6b2/2B3B2/9/3A4C/2p1A4/3K5' },
  { id: 45, name: '困毙', comment: '在残局中，利用围困、控制、调停等战术技巧，封闭对方的全盘子力，使其无一应着可走而认输。', fen: '4ra3/4a4/1P1k3N1/9/9/9/9/9/9/4K4' },
  { id: 46, name: '闷杀', comment: '利用弃子攻击手段，堵塞对方将的活动通道，或者通过“照将”造成对方攻击性子力自堵将，而一举将死对方。', fen: '2bak4/4aP1C1/4n2R1/6p2/9/9/4P1r2/9/4p4/3K5' },
  { id: 47, name: '二鬼拍门', comment: '用双车(兵)侵入九宫禁区，分别锁住对方将肋道，然后配合其他子力搏士杀将获胜。', fen: '3ak4/2P1a1P2/4b4/c8/6b2/8R/2r6/4B4/1p2A4/2B1KA3' },
  { id: 48, name: '送佛归殿', comment: '兵借助其他子力的力量，步步“将军”，把对方将逼回原始位置而取胜，也称为“小鬼推磨”杀法。', fen: '3k1a3/2P1c4/2R1b4/9/2bP5/9/n8/9/4p4/3K5' },
  { id: 49, name: '海底捞月', comment: '在无法攻破对方正面防御时，借助帅对中线的控制力，把子力运动到对方底线，在其将的背后发起攻势而取胜。', fen: '3k5/9/9/9/4R4/3r2C2/9/9/9/4K4' },
  { id: 50, name: '白脸将', comment: '根据帅、将不能在同一直线上直接对面的规则，一方用“将军”手段，致使对方因不能形成帅、将对面而被将死的杀法，成为“对面笑”杀法。', fen: '5a3/3ka4/bP7/9/9/9/6p1r/C8/5p3/R3K4' },
  { id: 51, name: '双照将', comment: '一方走出一步棋，可使己方两个棋子同时“将军”，并将死对方。(若三个棋子同时“将军”，称为“三照将”。)', fen: '3k1a3/2P6/b2a5/9/2b6/9/1N3C3/6n2/5p3/4K1c2' },
  { id: 52, name: '三子归边', comment: '集结三个不同兵种的子力，如车马炮或车马兵或车炮兵或马炮兵等，到对方九宫侧同翼联合作战而将死对方。', fen: '2ra1kb2/4a4/4b4/8C/2c3p2/7RN/9/4nA3/4Ap3/3K5' },
  { id: 53, name: '臣压君', comment: '一方的帅(将)被自己的棋子所堵塞，而造成被另一方将死。它是比较常见的杀法。朋友们一定要掌握。', fen: '2b1k4/R3a2R1/b3r4/9/9/9/9/5A3/4A4/4K4' },
  { id: 54, name: '铁门栓', comment: '在其他子力配合下，用车或兵直插对方将门之肋道一举获胜。这种杀法多用于车炮联合作战，攻杀凌厉，常令对方束手无策。', fen: '4ka3/3Pa4/8b/7Cp/9/9/9/9/9/4K4' },
  { id: 55, name: '大胆穿心', comment: '在其他子力的配合下，一方用车强行杀去对方中心士，摧毁对方防线，再用其他子力将死对方。这种杀法速战速决，是弃子攻杀技巧的一种典型用法。', fen: '2b1ka3/1R2aP1n1/6R2/9/9/2r3C2/9/6p2/3rA4/5K3' },
  { id: 56, name: '双车错杀', comment: '运用双车交替“将军”，把对方将死。这种杀法是在对方缺士或主将受攻时使用。迅猛无比，其势难当。', fen: '3k5/4a4/b7b/9/9/9/9/4B1n2/2r1A1r2/1RB1KA1R1' },
  { id: 57, name: '掀棋盘', comment: '这是最厉害的一招，其他绝杀都是渣渣，什么特大、名家均不是对手，不过他和武林秘籍”七伤拳“类似，应用时有一定的反伤，谨慎使用，并做好自身防护。', fen: '2b1ka3/4a4/4b4/9/9/9/9/4B4/4A4/3AK1B2' },
];

/** 闯关序号（第 N 关）= 数组下标 + 1 */
export function getEndgameLevel(index: number): EndgameLevel | null {
  if (index < 0 || index >= BUILTIN_ENDGAMES.length) return null;
  return BUILTIN_ENDGAMES[index];
}

/**
 * 校验自定义残局 FEN 字符串
 * 返回 null 表示合法，否则返回错误描述
 *
 * 格式：棋盘部分（10 行 / 分隔，小写=黑 大写=红 数字=空格），可附先后手（w=红先 b=黑先，默认红先）
 * 校验项：行数/列数、字符集、每类棋子数量上限、将帅唯一且在九宫、无飞将、兵卒不在本方底线
 */
export function validateEndgameFen(fen: string): string | null {
  const trimmed = fen.trim();
  if (!trimmed) return 'FEN 不能为空';

  const parts = trimmed.split(/\s+/);
  if (parts.length > 2) return '格式错误：棋盘与先后手之间最多一个空格';
  if (parts.length === 2 && parts[1] !== 'w' && parts[1] !== 'b') {
    return '先后手段只能是 w（红先）或 b（黑先）';
  }

  const rows = parts[0].split('/');
  if (rows.length !== 10) return `棋盘应为 10 行（当前 ${rows.length} 行）`;

  const VALID: Record<string, number> = {
    k: 1, a: 2, b: 2, n: 2, r: 2, c: 2, p: 5,
    K: 1, A: 2, B: 2, N: 2, R: 2, C: 2, P: 5,
  };
  const counts: Record<string, number> = {};
  // 记录将/帅位置用于九宫与飞将校验
  let redKingCol = -1, redKingRow = -1, blackKingCol = -1, blackKingRow = -1;
  const board: string[][] = [];

  for (let r = 0; r < 10; r++) {
    const cells: string[] = [];
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '9') {
        for (let n = 0; n < parseInt(ch); n++) cells.push('');
      } else if (VALID[ch] !== undefined) {
        counts[ch] = (counts[ch] || 0) + 1;
        cells.push(ch);
      } else {
        return `包含非法字符 "${ch}"（第 ${r + 1} 行）`;
      }
    }
    if (cells.length !== 9) return `第 ${r + 1} 行应为 9 列（当前 ${cells.length} 列）`;
    board.push(cells);
    for (let c = 0; c < 9; c++) {
      const cell = cells[c];
      if (cell === 'K') { redKingCol = c; redKingRow = r; }
      if (cell === 'k') { blackKingCol = c; blackKingRow = r; }
    }
  }

  for (const ch of Object.keys(counts)) {
    if (counts[ch] > VALID[ch]) return `棋子 "${ch}" 数量超出上限（${VALID[ch]} 个）`;
  }
  if (!counts['K']) return '缺少红方帅（K）';
  if (!counts['k']) return '缺少黑方将（k）';

  // 九宫限制
  if (redKingCol < 3 || redKingCol > 5 || redKingRow < 7 || redKingRow > 9) {
    return '红帅必须位于九宫内（列 3-5，行 7-9）';
  }
  if (blackKingCol < 3 || blackKingCol > 5 || blackKingRow < 0 || blackKingRow > 2) {
    return '黑将必须位于九宫内（列 3-5，行 0-2）';
  }

  // 飞将：将帅同列且中间无子
  if (redKingCol === blackKingCol) {
    let blocked = false;
    for (let r = blackKingRow + 1; r < redKingRow; r++) {
      if (board[r][redKingCol] !== '') { blocked = true; break; }
    }
    if (!blocked) return '将帅不能直接照面（飞将）';
  }

  // 兵卒不能位于本方半场后方（兵只能向前/过河后平移，永不后退）：
  // 红兵从第 6 行出发向上，不可能出现在 7-9 行；黑卒从第 3 行出发向下，不可能出现在 0-2 行
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      if (board[r][c] === 'P' && r >= 7) return '红兵位置不合法：不能位于己方底线及后方区域';
      if (board[r][c] === 'p' && r <= 2) return '黑卒位置不合法：不能位于己方底线及后方区域';
    }
  }

  // 士/仕：只能位于九宫内的斜线位（士角）
  const ADVISOR_POINTS: Record<string, string[]> = {
    a: ['0,3', '0,5', '1,4', '2,3', '2,5'],
    A: ['7,3', '7,5', '8,4', '9,3', '9,5'],
  };
  // 象/相：不能过河，且只能落在本方 7 个象位
  const ELEPHANT_POINTS: Record<string, string[]> = {
    b: ['0,2', '0,6', '2,0', '2,4', '2,8', '4,2', '4,6'],
    B: ['5,2', '5,6', '7,0', '7,4', '7,8', '9,2', '9,6'],
  };
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = board[r][c];
      if (ADVISOR_POINTS[cell] && !ADVISOR_POINTS[cell].includes(`${r},${c}`)) {
        return cell === 'a' ? '黑士位置不合法：只能在九宫士角（斜线位）' : '红仕位置不合法：只能在九宫士角（斜线位）';
      }
      if (ELEPHANT_POINTS[cell] && !ELEPHANT_POINTS[cell].includes(`${r},${c}`)) {
        return cell === 'b' ? '黑象位置不合法：不能过河，且只能落在象位' : '红相位置不合法：不能过河，且只能落在相位';
      }
    }
  }

  return null;
}
