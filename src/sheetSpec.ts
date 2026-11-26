// Element 118 Sheet V1 規格（docs/SHEET_SPEC_V1.md と同じ内容をコードにしたもの）
// 座標はすべてシート全体に対する割合（0〜1）。画像の解像度に依存しない。

export const SPEC_VERSION = 'E118-SHEET-V1';

export interface Cell { id: string; label: string; x0: number; y0: number; x1: number; y1: number }

/** 各セルの上端からこの割合はラベル用。解析では無視する */
export const LABEL_BAND = 0.07;

// ---------------------------------------------------------------- SHEET 1：APPEARANCE / SHAPE
export const SHEET1_CELLS: Cell[] = [
  { id: 'front', label: 'FRONT', x0: 0.0, y0: 0.06, x1: 0.25, y1: 0.72 },
  { id: 'right', label: 'RIGHT', x0: 0.25, y0: 0.06, x1: 0.5, y1: 0.72 },
  { id: 'back', label: 'BACK', x0: 0.5, y0: 0.06, x1: 0.75, y1: 0.72 },
  { id: 'left', label: 'LEFT', x0: 0.75, y0: 0.06, x1: 1.0, y1: 0.72 },
  { id: 'top', label: 'TOP', x0: 0.0, y0: 0.72, x1: 0.25, y1: 1.0 },
];
/** PARTS 欄（SHEET 1 の右下）。固定の6スロット、左から順番固定 */
export const PARTS_SLOTS = ['hair', 'hat', 'backpack', 'weapon', 'accessory', 'extra'] as const;
export const PARTS_LABELS: Record<(typeof PARTS_SLOTS)[number], string> = {
  hair: 'HAIR', hat: 'HAT', backpack: 'BACKPACK', weapon: 'WEAPON', accessory: 'ACCESSORY', extra: 'EXTRA',
};
/** パーツの固定ID（将来の拡張を含む全リスト。解析後に手動で付け替えるときの選択肢） */
export const PART_IDS_ALL = ['hair', 'head', 'face', 'hat', 'goggles', 'scarf', 'upper_cloth', 'lower_cloth', 'belt', 'backpack', 'shoes', 'weapon', 'accessory', 'extra'] as const;
export const PARTS_AREA = { x0: 0.25, y0: 0.72, x1: 1.0, y1: 1.0 };
export const partsCells = (): Cell[] => PARTS_SLOTS.map((id, i) => {
  const w = (PARTS_AREA.x1 - PARTS_AREA.x0) / PARTS_SLOTS.length;
  return { id, label: PARTS_LABELS[id], x0: PARTS_AREA.x0 + w * i, y0: PARTS_AREA.y0, x1: PARTS_AREA.x0 + w * (i + 1), y1: PARTS_AREA.y1 };
});

// ---------------------------------------------------------------- SHEET 2：STRUCTURE / RIG
export const SHEET2_CELLS: Cell[] = [
  { id: 'jointFront', label: 'T-POSE / JOINT MARKERS FRONT', x0: 0.0, y0: 0.06, x1: 0.4, y1: 1.0 },
  { id: 'jointRight', label: 'JOINT MARKERS RIGHT', x0: 0.4, y0: 0.06, x1: 0.6, y1: 1.0 },
  { id: 'bone', label: 'BONE REFERENCE', x0: 0.6, y0: 0.06, x1: 0.8, y1: 0.53 },
  { id: 'mesh', label: 'MESH REFERENCE', x0: 0.8, y0: 0.06, x1: 1.0, y1: 0.53 },
  { id: 'uv', label: 'UV REFERENCE', x0: 0.6, y0: 0.53, x1: 1.0, y1: 1.0 },
];

// ---------------------------------------------------------------- 関節マーカー
export type JointId =
  | 'HEAD' | 'NECK' | 'CHEST' | 'SPINE' | 'HIPS'
  | 'SHOULDER_L' | 'SHOULDER_R' | 'ELBOW_L' | 'ELBOW_R' | 'WRIST_L' | 'WRIST_R'
  | 'HIP_L' | 'HIP_R' | 'KNEE_L' | 'KNEE_R' | 'ANKLE_L' | 'ANKLE_R';

export interface MarkerGroup {
  key: string;
  rgb: [number, number, number];
  ids: JointId[]; // 1個（中心線上）または [_L, _R] の2個
  /** FRONT 図での高さの目安（足底0〜頭頂1）。誤検出の除外に使う */
  yRange: [number, number];
}

/** 左右の対は同じ色。左右は FRONT 図での位置で決める（キャラの左 = 画面の右） */
export const MARKERS: MarkerGroup[] = [
  { key: 'HEAD', rgb: [255, 0, 255], ids: ['HEAD'], yRange: [0.6, 1.0] },
  { key: 'NECK', rgb: [0, 255, 255], ids: ['NECK'], yRange: [0.45, 0.92] },
  { key: 'CHEST', rgb: [255, 255, 0], ids: ['CHEST'], yRange: [0.35, 0.85] },
  { key: 'SPINE', rgb: [255, 128, 0], ids: ['SPINE'], yRange: [0.25, 0.75] },
  { key: 'HIPS', rgb: [128, 0, 255], ids: ['HIPS'], yRange: [0.15, 0.65] },
  { key: 'SHOULDER', rgb: [255, 0, 0], ids: ['SHOULDER_L', 'SHOULDER_R'], yRange: [0.35, 0.9] },
  { key: 'ELBOW', rgb: [0, 255, 0], ids: ['ELBOW_L', 'ELBOW_R'], yRange: [0.25, 0.9] },
  { key: 'WRIST', rgb: [0, 0, 255], ids: ['WRIST_L', 'WRIST_R'], yRange: [0.15, 0.9] },
  { key: 'HIP', rgb: [0, 255, 128], ids: ['HIP_L', 'HIP_R'], yRange: [0.1, 0.6] },
  { key: 'KNEE', rgb: [255, 0, 128], ids: ['KNEE_L', 'KNEE_R'], yRange: [0.03, 0.4] },
  { key: 'ANKLE', rgb: [0, 128, 255], ids: ['ANKLE_L', 'ANKLE_R'], yRange: [-0.02, 0.2] },
];

/** RGB の距離（ユークリッド）がこれ以内なら、そのマーカー色とみなす。色の最小間隔は約127なので重ならない */
export const MARKER_TOLERANCE = 60;
/** 彩度（max−min）がこれ未満の画素はマーカーではない（灰色の体・アンチエイリアスの縁を除外） */
export const MARKER_MIN_CHROMA = 140;
/** マーカーの直径（キャラの身長に対する割合） */
export const MARKER_DIAMETER = 0.03;

/** 関節の親子関係（ボーン表示用。Phase 3 の Humanoid 骨格の元になる） */
export const BONES: [JointId, JointId][] = [
  ['HIPS', 'SPINE'], ['SPINE', 'CHEST'], ['CHEST', 'NECK'], ['NECK', 'HEAD'],
  ['CHEST', 'SHOULDER_L'], ['SHOULDER_L', 'ELBOW_L'], ['ELBOW_L', 'WRIST_L'],
  ['CHEST', 'SHOULDER_R'], ['SHOULDER_R', 'ELBOW_R'], ['ELBOW_R', 'WRIST_R'],
  ['HIPS', 'HIP_L'], ['HIP_L', 'KNEE_L'], ['KNEE_L', 'ANKLE_L'],
  ['HIPS', 'HIP_R'], ['HIP_R', 'KNEE_R'], ['KNEE_R', 'ANKLE_R'],
];

export const ALL_JOINTS: JointId[] = MARKERS.flatMap(m => m.ids);
export const markerOf = (id: JointId) => MARKERS.find(m => m.ids.includes(id))!;
export const rgbHex = (rgb: [number, number, number]) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
