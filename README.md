# 3D MODEL MAKER

iPhone の Safari だけで、画像からゲーム用の3Dモデル（GLB）を作る単体アプリ。完全クライアントサイド（GPU・サーバー・有料API不要）で、静的ホスティング（GitHub Pages 等）で動く。ゲーム本体（ELEMENT 118）とは別アプリ。


- 開く：`index.html`（`app.js` はビルド済み。そのまま配信するだけで動く）
- 開発：`npm install && npm run build`（`src/*.ts` → `app.js`）

## STEP 1–6（実装済み）
1. 種類8つ（アイテム／素材／元素／武器・道具／木・岩・植物／キャラクター／モンスター／建物・設備）＋正面画像（透明PNG推奨。単色背景は自動切り抜き）
2. 輪郭抽出
3. 立体化（キャラクターとアイテムで別アルゴリズム）
   - 人型（キャラクター・人型モンスター）：シルエットから頭・首・胴体・腕・脚の比率を推定し、頭・髪・顔・首・胴体・腰・上腕・前腕・手・太もも・すね・足のパーツを1体に組み立てる。画像は全面に貼らず、体の各部分から代表色を取り出してパーツごとのマテリアルにする（顔だけ頭の前面に限定して貼る）。設定画に複数の絵があっても全身像1体だけを使う。品質：軽量／標準／高品質。※AIではなく「画像解析＋プロシージャル生成」
   - アイテム：ふくらませる（石・鉱石）／押し出す（武器・道具・板状）
4. 厚み・丸み・凹凸＋高さ・幅・奥行き・回転・位置・色・金属感・粗さ・不透明度、質感プリセット（石・鉄・銅・木材・ガラス・シリカ・鉱石・結晶）
5. 360°プレビュー（1本指＝回転、ピンチ＝ズーム、正面／右／背面／左／上）
6. GLB 書き出し（テクスチャ・法線マップ内蔵、底辺中心が原点、正面＝+Z、実寸m）。Three.js の GLTFLoader でそのまま読める

アイテムIDの候補は `src/items.ts`（入力補助と実寸合わせ用。自由に編集）。

## Element 118 設計シート → 3D（sheet.html）
Element 118 Sheet V1 規格（`docs/SHEET_SPEC_V1.md`）の2枚の設計シートから3Dキャラクターを作る正式ルート。
1. SHEET 1（APPEARANCE / SHAPE）と SHEET 2（STRUCTURE / RIG）を選ぶ（「サンプルで試す」で `samples/` の見本を読み込める）
2. 解析：FRONT / RIGHT / BACK / LEFT / TOP / PARTS のシルエット、関節マーカー（色＋固定ID＋位置）→ 17関節の3D座標
3. 関節はFRONT・RIGHTの図の上で指でドラッグして修正
4. 3D生成：5方向シルエットから Visual Hull（形状測定用）。FRONT〜TOP のボタンで正投影に切り替え、元シルエットを半透明で重ねて一致度（IoU）を表示

実装済み：Phase 1（規格・読み込み・解析）、Phase 2（Visual Hull・重ね合わせ比較）、Standard Base Mesh V1（下記）
次：Phase 3 Visual Hull fitting（Base Mesh V1 の頂点位置だけを動かす）→ テクスチャ・GLB
すべてブラウザ内の画像解析＋幾何計算（AI・外部API・GPUサーバー不使用）。`sample.html` はサンプルシート生成用の開発ページ。

## Element 118 Standard Base Mesh V1（base.html）
全キャラ共通の人体メッシュ（`src/basemesh.ts`、固定データ `samples/e118_base_mesh_v1.glb`、仕様 `docs/BASE_MESH_V1.md`）。
閉じた1枚の四角形メッシュ（形の頂点 5,954／四角形 5,952）、UV 済み、SHEET 2 の17関節＝17ボーン、スキンウェイト済み。
確認画面：Solid / Wireframe / UV Checker / Skeleton / Skin Weight、FRONT〜TOP・FREE、T-POSE / ARMS DOWN / ELBOW 90 / KNEE 90 / HIP BEND / HEAD TURN、GLB 書き出し＋読み直し検証。

## 次のステップ（未実装）
三面図、基本形状の組み合わせ、キャラクター／モンスター／建物モード、自動ボーン。
