# Phase 4：Joint / Rig / Pose Test

場所：メイン画面 `sheet.html` の「6. Joint & Rig」→ 全画面の作業画面。コード：`src/rig.ts`（計算）、`src/rigUI.ts`（画面）→ `rig.js`、`rig.css`。
Phase 1〜3 のコードは変更していません（`fit.ts` の Silhouettes に `export` を付けただけ。動作は同じ）。`window.__sheet`・`window.__fit` を読むだけです。

## 使うメッシュ
5 のフィッティング結果（Fitted Mesh）。無ければ保存した Rig、それも無ければ Standard Base Mesh V1。頂点数・面・UV は V1 のまま。

## AUTO JOINT（17関節の3D位置）
- FRONT → x, y：SHEET 2 正面のマーカー
- SIDE → z, y：SHEET 2 側面のマーカー。体の中心の関節は SHEET 1 側面シルエットの断面の内側に収まっているか確認し、端に寄りすぎなら断面の中心へ
- TOP → x, z：肘・手首の前後位置は TOP（上から見た腕の断面の中心）
- 腕の関節は腕の太さの中心へ、膝・足首は脚の断面の中心へ寄せる
- 左右対称（ペアの高さ・中心からの距離の差が小さい）なら、体の中心面で左右をそろえる
- Visual Hull の外に出た関節は断面の中心へ戻し、それでも外なら親の関節の方へ戻す

## JOINT EDIT
関節の球をタップで選択。iPhone は選んだ球を指でドラッグ（画面に平行な面の上で動く）、または X/Y/Z の −／＋（0.005）とスライダー。PC は TransformControls。
関節をつかんでいる間はカメラ操作（OrbitControls）を止め、離したら戻す。「左右対称に動かす」で反対側も鏡に映して動く。
AUTO RIG 後に関節を動かすと、ウェイトを自動で計算し直す。

## Skeleton（V1 と同じ17ボーン・同じ順番）
Hips(HIPS) → Spine(SPINE) → Chest(CHEST) → Neck(NECK) → Head(HEAD)、Chest → UpperArm(SHOULDER) → LowerArm(ELBOW) → Hand(WRIST)、Hips → UpperLeg(HIP) → LowerLeg(KNEE) → Foot(ANKLE)。T ポーズで回転 0。

## AUTO RIG（スキンウェイト）
- 頂点を関節の鎖（胴：腰→背骨→胸→首→頭、腕：肩→肘→手首→指先、脚：股→膝→足首→足裏）に投影し、関節の前後でなめらかに受け渡す
- 使ってよいボーンを体の部位で制限：頭＝Head（あごの下だけ Neck と半々）、首＝胸・首・頭、腕・手＝その側の腕＋胸、脚・足＝その側の脚＋腰、胴＝胴・その側の上腕・脚の付け根
- 胴の頂点は体の中心面のどちら側かで、使える腕のボーンを決める（左腕のウェイトが右腕・頭に漏れない）。股の中心線で左右の脚を混ぜる
- 最大4ボーン、合計 1.0。左右への漏れ・頭への漏れの頂点数を表示

## POSE TEST
プリセット：T / A / ARM UP / ELBOW / WALK / SQUAT / RESET（T ポーズへ）。関節の球をタップ → そのボーンを X/Y/Z（−180〜180°、−／＋ は 5°）で回転。アニメーションではなく Rig の確認用。
WEIGHT VIEW：選んだボーンのウェイト（紺＝0 → 赤＝1）。

## 保存
SAVE RIG：端末の LocalStorage に保存（再読み込み後も「保存した Rig を復元」／形が無いときは開くと自動で復元）。Rig JSON：関節位置・ボーン階層・ボーン回転・スキンウェイト・形・Base Mesh バージョン（`E118-RIG-V1` / `E118-BASE-V1`）。
GLB：SkinnedMesh（メッシュ・UV・マテリアル・17ボーン・ウェイト）を GLTFExporter で書き出し、読み直して確認。
