// Phase 3 画面（SHEET → 3D のメイン画面に追加する部分）
// Phase 1/2 のコード（sheet.js）には手を入れず、公開されている window.__sheet（解析結果と3D画面）だけを読む。
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { SourceImage } from './mask';
import type { ViewId, Sheet1, Joints } from './sheetParse';
import type { HullResult } from './hull';
import { buildBaseMeshData, makeBaseGeometry, makeSkeleton, BONES_V1, topologyHash, BASE_MESH_VERSION } from './basemesh';
import { fitBaseMesh, type FitResult } from './fit';

interface SheetHook { state: { s1: Sheet1 | null; joints: Joints | null; hull: HullResult | null }; setView: (v: ViewId | 'home') => void; scene: THREE.Scene }
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const VIEW_IDS: ViewId[] = ['front', 'right', 'back', 'left', 'top'];
const VIEW_LABEL: Record<ViewId, string> = { front: 'FRONT', right: 'RIGHT', back: 'BACK', left: 'LEFT', top: 'TOP' };
const data = buildBaseMeshData();
const ok = (b: boolean) => b ? '<b class="ok">✓</b>' : '<b class="ng">✗</b>';

function hook(): SheetHook | null { return (window as unknown as { __sheet?: SheetHook }).__sheet ?? null; }

// ------------------------------------------------------------------ 表示物
const group = new THREE.Group(); group.name = 'phase3_fit';
const fitMat = new THREE.MeshStandardMaterial({ color: 0xe8c9a8, roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
let fitted: { mesh: THREE.SkinnedMesh; wire: THREE.LineSegments; skel: THREE.Group; res: FitResult } | null = null;
let added = false;

const edgeIndex: number[] = (() => {
  const seen = new Set<number>(), out: number[] = [];
  for (let k = 0; k < data.quads.length; k += 4) for (let j = 0; j < 4; j++) {
    const a = data.quads[k + j], b = data.quads[k + (j + 1) % 4], key = Math.min(a, b) * 1e7 + Math.max(a, b);
    if (!seen.has(key)) { seen.add(key); out.push(a, b); }
  }
  return out;
})();

function makeFitted(res: FitResult) {
  const geo = makeBaseGeometry({ ...data, positions: res.positions, normals: res.normals });
  const mesh = new THREE.SkinnedMesh(geo, fitMat);
  mesh.name = 'E118_Fitted_V1';
  const { bones, skeleton } = makeSkeleton({ ...data, joints: res.joints });
  mesh.add(bones[0]);
  mesh.bind(skeleton);
  mesh.userData.baseMesh = BASE_MESH_VERSION;
  return mesh;
}

function show(res: FitResult) {
  const h = hook()!;
  if (!added) { h.scene.add(group); added = true; }
  if (fitted) { group.clear(); fitted.mesh.geometry.dispose(); fitted.wire.geometry.dispose(); }
  const mesh = makeFitted(res);
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.shapeCount * 3), 3));
  wg.setIndex(edgeIndex);
  const wire = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x1a1208, transparent: true, opacity: 0.6 }));
  // 骨格：17ボーン（Base Mesh V1 と同じ構造）を関節の位置に
  const skel = new THREE.Group();
  const pts: number[] = [];
  BONES_V1.forEach(b => { if (b.parent >= 0) { const p = res.joints[b.joint], q = res.joints[BONES_V1[b.parent].joint]; pts.push(...p, ...q); } });
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x36e3c4, depthTest: false })); lines.renderOrder = 30; skel.add(lines);
  const sph = new THREE.SphereGeometry(0.011, 10, 8);
  BONES_V1.forEach(b => { const s = new THREE.Mesh(sph, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })); s.renderOrder = 31; s.position.set(...res.joints[b.joint]); skel.add(s); });
  group.add(mesh, wire, skel);
  fitted = { mesh, wire, skel, res };
  setStage(res.stages.length - 1);
  applyToggles();
}

function setStage(i: number) {
  if (!fitted) return;
  const st = fitted.res.stages[i];
  const pos = fitted.mesh.geometry.attributes.position as THREE.BufferAttribute;
  data.shapeIndex.forEach((s, k) => pos.setXYZ(k, st.pos[s * 3], st.pos[s * 3 + 1], st.pos[s * 3 + 2]));
  pos.needsUpdate = true;
  fitted.mesh.geometry.computeVertexNormals();
  fitted.mesh.geometry.computeBoundingSphere();
  (fitted.wire.geometry.attributes.position as THREE.BufferAttribute).copyArray(st.pos).needsUpdate = true;
  fitted.wire.geometry.computeBoundingSphere();
  $<HTMLSelectElement>('#fitStageSel').value = String(i);
}

// ------------------------------------------------------------------ 表示切替
const T = (id: string) => $<HTMLInputElement>(id);
function setSheetToggle(id: string, v: boolean) {
  const el = document.querySelector<HTMLInputElement>(id); if (!el || el.checked === v) return;
  el.checked = v;
  el.dispatchEvent(new Event('change')); el.dispatchEvent(new Event('input'));
}
let hullMatBackup: { transparent: boolean; opacity: number; depthWrite: boolean; color: number } | null = null;
function applyToggles() {
  const h = hook(); if (!h) return;
  setSheetToggle('#tOverlay', T('#fOrig').checked);
  const overlay = T('#fOverlay').checked;
  setSheetToggle('#tMesh', T('#fHull').checked || overlay);
  const hull = h.scene.getObjectByName('visual_hull') as THREE.Mesh | undefined;
  if (hull) {
    const m = hull.material as THREE.MeshStandardMaterial;
    if (overlay) {
      if (!hullMatBackup) hullMatBackup = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite, color: m.color.getHex() };
      m.transparent = true; m.opacity = 0.32; m.depthWrite = false; m.color.setHex(0x5aa9ff); m.needsUpdate = true;
      hull.renderOrder = 5;
    } else if (hullMatBackup) {
      m.transparent = hullMatBackup.transparent; m.opacity = hullMatBackup.opacity; m.depthWrite = hullMatBackup.depthWrite; m.color.setHex(hullMatBackup.color); m.needsUpdate = true;
      hull.renderOrder = 0; hullMatBackup = null;
    }
  }
  if (fitted) {
    fitted.mesh.visible = T('#fFit').checked || overlay;
    fitted.wire.visible = T('#fWire').checked;
    fitted.skel.visible = T('#fSkel').checked;
  }
  // SHEET 2 の関節・ボーン表示（Phase 2）は、骨格表示と重なるのでフィット結果の表示中は隠す
  setSheetToggle('#tJoint', !fitted);
  setSheetToggle('#tBone', !fitted);
}

// ------------------------------------------------------------------ 固定データ（samples/e118_base_mesh_v1.glb）の自動読み込み
let baseCheck: { ok: boolean; msg: string } | null = null;
async function loadFixedBase() {
  if (baseCheck) return baseCheck;
  try {
    const r = await fetch('./samples/e118_base_mesh_v1.glb', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const g = await new GLTFLoader().parseAsync(await r.arrayBuffer(), './');
    let sk: THREE.SkinnedMesh | null = null;
    g.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) sk = o as THREE.SkinnedMesh; });
    const geo = (sk as THREE.SkinnedMesh | null)?.geometry;
    if (!geo) throw new Error('SkinnedMesh なし');
    const idx = geo.index!.array, pos = geo.attributes.position.array, uv = geo.attributes.uv.array;
    let same = idx.length === data.index.length && pos.length === data.positions.length;
    for (let i = 0; same && i < idx.length; i++) if (idx[i] !== data.index[i]) same = false;
    for (let i = 0; same && i < pos.length; i++) if (Math.abs(pos[i] - data.positions[i]) > 1e-5) same = false;
    for (let i = 0; same && i < uv.length; i++) if (Math.abs(uv[i] - data.uvs[i]) > 1e-6) same = false;
    baseCheck = same ? { ok: true, msg: `Standard Base Mesh V1 を読み込みました（固定データと完全一致・指紋 ${topologyHash(data)}）` } : { ok: false, msg: '固定データと生成結果が一致しません' };
  } catch (e) {
    baseCheck = { ok: false, msg: '固定データを読めません：' + (e as Error).message };
  }
  return baseCheck;
}

// ------------------------------------------------------------------ フィット実行
function inputs() {
  const h = hook(); const st = h?.state;
  if (!st?.s1 || !st.joints || !st.hull) return null;
  const use: Record<string, boolean> = {};
  document.querySelectorAll<HTMLInputElement>('#useViews input').forEach(i => { use[i.dataset.v!] = i.checked; });
  const views: Partial<Record<ViewId, SourceImage>> = {};
  for (const id of VIEW_IDS) if (st.s1.views[id] && use[id] !== false) views[id] = st.s1.views[id]!.src;
  return { joints: st.joints, views, W: st.hull.W, D: st.hull.D };
}

async function runFit() {
  const inp = inputs();
  if (!inp) { $('#fitHint').textContent = '先に「3D生成（Visual Hull）」まで進めてください。'; return; }
  const btn = $<HTMLButtonElement>('#btnFit');
  btn.disabled = true; btn.textContent = 'フィット中…';
  await new Promise(r => setTimeout(r, 30));
  try {
    const bc = await loadFixedBase();
    const res = fitBaseMesh(inp);
    show(res);
    $('#fitBox').hidden = false;
    renderResult(res, bc);
    hook()!.setView('front');
    $('#fitHint').textContent = '';
  } catch (e) {
    $('#fitHint').textContent = 'フィットできません：' + (e as Error).message;
  } finally {
    btn.disabled = false; btn.textContent = 'Base Mesh V1 をフィット';
  }
}

function renderResult(res: FitResult, bc: { ok: boolean; msg: string }) {
  const rows = VIEW_IDS.filter(id => res.iou[id] !== undefined).map(id => {
    const p = res.iou[id]! * 100;
    return `<tr class="${p < 90 ? 'low' : ''}"><td>${VIEW_LABEL[id]}</td><td style="width:50%"><div class="bar"><i style="width:${p.toFixed(0)}%"></i></div></td><td>${p.toFixed(1)}%</td></tr>`;
  }).join('');
  const vals = VIEW_IDS.map(id => res.iou[id]).filter((v): v is number => v !== undefined);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length * 100 : 0;
  $('#fitIou').innerHTML = `<div class="cap">Fitted Mesh を各方向から見た影と、元の5方向シルエットの一致度。髪・帽子・リュックなど体以外の部分は体に含めないので、その分だけ下がります</div><table>${rows}<tr class="${avg < 90 ? 'low' : ''}"><td class="iouAvg">平均</td><td><div class="bar"><i style="width:${avg.toFixed(0)}%"></i></div></td><td class="iouAvg">${avg.toFixed(1)}%</td></tr></table>`;
  const s = res.stats;
  const geo = fitted!.mesh.geometry;
  const sameTopo = geo.attributes.position.count === data.stats.vertices && geo.index!.count === data.index.length;
  $('#fitChecks').innerHTML = [
    ['Base Mesh', `${ok(bc.ok)} ${bc.msg}`],
    ['頂点数・頂点番号・面', `${ok(sameTopo)} V1 と同一（${data.stats.vertices.toLocaleString()} 頂点 / ${data.stats.triangles.toLocaleString()} 三角形）`],
    ['UV・ボーン構造・ウェイト', `${ok(true)} V1 のまま（動かしたのは頂点の位置とボーンの位置だけ）`],
    ['ボーンの位置', `${ok(true)} SHEET 2 の17関節に合わせました`],
    ['表面のなめらかさ', (() => { const st = res.stages, r = st[st.length - 1].rough / st[1].rough; return `${ok(r < 1.4)} 凸凹の量：Base Mesh V1 の ${r.toFixed(2)} 倍（1.0 に近いほどなめらか。段階ごと：${st.slice(1).map(x => (x.rough / st[1].rough).toFixed(2)).join(' → ')}）`; })()],
    ['Visual Hull から大きくはみ出した頂点', `${ok(s.outsideAfter <= data.stats.shapeVertices * 0.02)} ${s.outsideAfter.toLocaleString()} 頂点（Visual Hull の角・段差に沿わせないため、0.006 までのはみ出しは許容）`],
    ['裏返った面', `${ok(s.flipped === 0)} ${s.flipped}`],
    ['体に含めなかった部分', s.clamped.length ? s.clamped.join('、') : 'なし'],
    ['計算時間', `${Math.round(s.ms)} ms`],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  $('#fitGlbCheck').hidden = true; $('#btnFitSave').hidden = true;
}

// ------------------------------------------------------------------ GLB
let lastGlb: ArrayBuffer | null = null;
async function exportFitted(): Promise<ArrayBuffer> {
  if (!fitted) throw new Error('フィット結果がありません');
  const m = makeFitted(fitted.res);
  m.material = new THREE.MeshStandardMaterial({ color: 0xe8c9a8, roughness: 0.7, metalness: 0 });
  (m.material as THREE.Material).name = 'E118_Fitted_V1';
  return await new GLTFExporter().parseAsync(m, { binary: true }) as ArrayBuffer;
}
async function verifyGlb(buf: ArrayBuffer) {
  const dv = new DataView(buf), n = dv.getUint32(12, true);
  const j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, n)));
  const prim = j.meshes?.[0]?.primitives?.[0] ?? {}, at = prim.attributes ?? {};
  const g = await new GLTFLoader().parseAsync(buf.slice(0), './');
  let sk: THREE.SkinnedMesh | null = null;
  g.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) sk = o as THREE.SkinnedMesh; });
  const s = sk as THREE.SkinnedMesh | null, geo = s?.geometry;
  let sameIdx = !!geo?.index && geo.index.count === data.index.length;
  for (let i = 0; sameIdx && i < data.index.length; i++) if (geo!.index!.array[i] !== data.index[i]) sameIdx = false;
  let sameUv = !!geo && geo.attributes.uv?.count === data.uvs.length / 2;
  for (let i = 0; sameUv && i < data.uvs.length; i++) if (Math.abs((geo!.attributes.uv.array as Float32Array)[i] - data.uvs[i]) > 1e-6) sameUv = false;
  let sameSkin = !!geo && geo.attributes.skinIndex?.count === data.skinIndex.length / 4;
  for (let i = 0; sameSkin && i < data.skinIndex.length; i++) if (geo!.attributes.skinIndex.array[i] !== data.skinIndex[i]) sameSkin = false;
  const names = s ? s.skeleton.bones.map(b => b.name).join() === BONES_V1.map(b => b.name).join() : false;
  const rows: [string, boolean, string][] = [
    ['Mesh', !!s, s ? `SkinnedMesh「${s.name}」` : 'なし'],
    ['頂点数・面（V1 と同じ並び）', sameIdx && geo!.attributes.position.count === data.stats.vertices, `${geo?.attributes.position.count.toLocaleString() ?? 0} 頂点 / ${((geo?.index?.count ?? 0) / 3).toLocaleString()} 三角形`],
    ['UV（V1 と同一）', sameUv && at.TEXCOORD_0 !== undefined, sameUv ? 'TEXCOORD_0 あり・V1 と一致' : '不一致'],
    ['Material', (j.materials?.length ?? 0) > 0, j.materials?.[0]?.name ?? 'なし'],
    ['Skeleton', names && (j.skins?.[0]?.joints?.length ?? 0) === 17, `${s?.skeleton.bones.length ?? 0} ボーン${names ? '（名前・順番も V1 と一致）' : ''}`],
    ['Skin Weight（V1 と同一）', sameSkin && at.WEIGHTS_0 !== undefined, sameSkin ? 'JOINTS_0 / WEIGHTS_0 あり・V1 と一致' : '不一致'],
    ['ファイルサイズ', true, `${(buf.byteLength / 1024).toFixed(0)} KB`],
  ];
  return { rows, pass: rows.every(r => r[1]) };
}

// ------------------------------------------------------------------ 起動
function init() {
  const h = hook();
  if (!h) { setTimeout(init, 200); return; }
  $('#btnFit').onclick = runFit;
  const stSel = $<HTMLSelectElement>('#fitStageSel');
  stSel.innerHTML = ['0. Base Mesh V1（そのまま）', '1. Joint alignment', '2. Body proportion', '3. Local body-part', '4. Visual Hull surface', '5. Smoothing / regularization（完成）']
    .map((l, i) => `<option value="${i}">${l}</option>`).join('');
  stSel.onchange = () => setStage(parseInt(stSel.value, 10));
  ['#fOrig', '#fHull', '#fFit', '#fOverlay', '#fWire', '#fSkel'].forEach(id => { T(id).onchange = applyToggles; });
  document.querySelectorAll<HTMLButtonElement>('#fitViews button').forEach(b => {
    b.onclick = () => h.setView(b.dataset.v === 'free' ? 'home' : b.dataset.v as ViewId);
  });
  $('#btnFitGlb').onclick = async () => {
    const btn = $<HTMLButtonElement>('#btnFitGlb');
    btn.disabled = true; btn.textContent = '書き出し中…';
    try {
      lastGlb = await exportFitted();
      const v = await verifyGlb(lastGlb);
      const t = $('#fitGlbCheck'); t.hidden = false;
      t.innerHTML = v.rows.map(([k, b, d]) => `<tr><th>${k}</th><td>${ok(b)} ${d}</td></tr>`).join('') +
        `<tr><th>判定</th><td>${v.pass ? '<b class="ok">合格：書き出した GLB を読み直して確認しました</b>' : '<b class="ng">不合格</b>'}</td></tr>`;
      $('#btnFitSave').hidden = false;
    } catch (e) { $('#fitHint').textContent = '書き出せません：' + (e as Error).message; }
    finally { btn.disabled = false; btn.textContent = 'Fitted Mesh を GLB で書き出して検証'; }
  };
  $('#btnFitSave').onclick = async () => {
    if (!lastGlb) return;
    const blob = new Blob([lastGlb], { type: 'model/gltf-binary' });
    const file = new File([blob], 'e118_fitted_body.glb', { type: 'model/gltf-binary' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'e118_fitted_body.glb'; a.click();
  };
  // Visual Hull ができたらこの欄を出す
  setInterval(() => {
    const ready = !!hook()?.state.hull;
    $('#secFit').hidden = !ready;
  }, 400);
  (window as unknown as { __fit: unknown }).__fit = { runFit, setStage, get result() { return fitted?.res; }, exportFitted, verifyGlb, applyToggles };
}
init();
