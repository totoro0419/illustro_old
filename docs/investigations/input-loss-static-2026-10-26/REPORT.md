# Illustro — ペン離し後の指入力消失：静的解析報告

調査日：2026-10-26。対象：PR #64 のソース `eeea860a1997bbe613af4e07601d78e0a39eeceb`。

**判定：入力の受付・確定・表示経路と実装履歴から、複数の構造上の問題を特定した。ただし、実機で指の開始イベントが記録されなかった根本原因は未確定である。**

「確定待ちのフラグ」「仮線の重なり」「GPUをawaitしていること」「Androidのパームリジェクション」のいずれかを、そのまま今回の原因と認定できる証拠はない。この区別を崩して修正案を原因の説明に置き換えない。

## 1. 要求された五項目への回答

| 項目 | コードから確認できたこと | 今回の現象についての判定 |
|---|---|---|
| 指入力を妨げ得る処理・条件 | 入力を受けるWindowにも、分割されない確定計算・画像の取込み・メッセージの複製処理が残る。描画Workerには操作中の通知が届かず、GPU予算にも最初の一ジョブを例外扱いする箇所がある。詳細は§6。 | 構造は確認済み。これらによる実機の入力消失は未証明。 |
| ペンを離した直後に発生する理由 | `finishStroke → end → canonical record → logical commit → formal GPU jobs → picture publication` がこの時点で走る。終了形状の再計算・正式ジョブ・画像更新の負荷が重なる経路は存在する。 | 負荷の開始は説明できる。指イベントの欠落までの因果関係は未確定。 |
| 本線確定後に復帰する理由 | 正式ジョブ・表示待ちが解消し、仮線が退役し、`gpuFinishes` が減る。一方、この時点で指受付を再有効化する処理はない。 | 負荷や表示状態の変化との相関は説明可能。受付復帰の直接のトリガーは未確定。 |
| 根本原因と判断する根拠 | 同じdocumentで開始イベントが配信されたなら、`.surface` より先のWindow captureで観測される経路になっている。新規描画の制限条件は指の登録より後にある。 | アプリ内の描画待ち条件だけでは「開始ログなし・指0・長いJS停止の明確な記録なし」を同時に説明できない。単一原因の認定条件を満たさない。 |
| 静的解析で確定できないこと | 実機で通過したOS/Chromeの分岐、入力の宛先document、ブラウザー側の待ち・破棄、当該時点のCPU/GPU時間、実際に読み込まれた版とURL。 | いずれも未確定。ユーザーが指で操作した事実は否定しない。 |

## 2. 調査対象・方法・証拠の境界

### 2.1 版を固定する

| 対象 | 固定値・扱い |
|---|---|
| 主対象 | [PR #64][pr64] head `eeea860a1997bbe613af4e07601d78e0a39eeceb` |
| #64 の比較元 | #63 head `902d746465db1531f92b1fbe71befb5956d111a3` |
| 主対象のtree | `f5482000adb0b0b9fe171b65fe555fdfcd9e0370` |
| 公開用merge commit | `fad5caa8b57879f3552c83e8cf4e61e32f3cf82b`。GitHub上のcommit metadataでtreeが主対象と同一と確認。 |
| 取得時のmain | `bdc7135b51033982d90ea5dad104bb04fc107df2`。主対象と混同しない。 |
| 公開ファイルの読解 | `gh-pages` の `a3c416032d6d081f17155862ab791ff27e9d4d1a`。既存JS/CSSを文字列として読み、再生成していない。 |

公開snapshotのmain JSには上記merge SHA、`inputTrace`、`applyCooperatively`、`inputFirstProbe` が含まれる。drawing workerのbundleにも `gestureActive` の参照が残り、`navigationHold` はない。これは取得した公開ファイルとの整合確認であり、過去の実機キャッシュや読込版の証明ではない。ファイル名・ハッシュは [SOURCE_INVENTORY.md](SOURCE_INVENTORY.md) に記録した。

### 2.2 実施範囲

README・方針・正本索引・設計資料を先に確認し、その後、ソース全文または関連関数・呼出元を読解した。入力から画面反映までの現行経路、関連Core/persistence、UIの無効化条件、過去の差分、既存診断・既存検証スクリプトの実装を追跡した。Android/Chromiumについても固定revisionの一次ソースを読んだ。

実機接続、ブラウザー操作、アプリ起動、動作実験、ベンチマーク、テスト、build、依存関係の導入、検査機能の追加、製品コードの変更は実施していない。既存スクリプトの「読解」と「実行」を区別する。追加物はこの報告書と調査対象一覧だけである。

### 2.3 実機ログの来歴

ユーザーの確認事項と、[PR #64 の実機ログ要約コメント][log-comment]を前提にする。**元のAndroid実機JSONは、取得できたリポジトリ本文・PR本文・コメント内には見つからなかった。全イベント列を独立に再検算したという主張はしない。**

コメント記載値からの差分は次のとおり。単位はページ内時刻のms。

| 試行 | pen up | 本線完了に対応する記録 | 次のtouchstart | pen up→完了 | 完了→次の開始 |
|---|---:|---:|---:|---:|---:|
| 1 | 21659.7 | 21934.8（formal-confirmation） | 22273.7 | 275.1 | 338.9 |
| 2 | 26911.7 | 27217.4（status-write） | 27510.6 | 305.7 | 293.2 |
| 3 | 40560.0 | 40839.8（status-write） | 41149.1 | 279.8 | 309.3 |

同コメントは、本線完了前の `touchstart` / `pointerdown touch` がなく、同区間に `timer-stall` / `frame-gap` / `longtask` の明確な対応記録がなく、`save-prepare` は0.4〜1.3msと報告している。これを「ユーザーが触らなかった」「実機が正常だった」と読み替えない。また、完了後も次の開始ログまで約293〜339msあり、ログだけから物理的な復帰瞬間が本線完了と完全一致するとはいえない。

## 3. 先に確認した基本方針と設計構造

入口は [README][readme]、[IMPLEMENTATION_BASELINE][baseline]、[CANONICAL_INDEX.md][canonical] とJSON索引である。対象tree内のMarkdown 171文書について所在・分類・章立てを横断確認し、対象分野の正本と関連設計・調査本文を精読した。171文書すべての全文精読を意味しない。全README、方針文書と関連資料の一覧・読解範囲は別紙に示す。適用される `AGENTS.md` は取得したrepo内・親ディレクトリに見つからなかった。

基本方針から今回の判定に用いた事項は以下。

- `IMPLEMENTATION_BASELINE` §「高頻度操作の即時受付・確定待ち分離」は、GPU完了・正式登録・保存・履歴整理を操作受付の前提にしない、と定める。CIと実機受入を同一視しない。
- 正本索引の分類を優先し、旧資料の `PASS` / `LOCK` / 「完成」や過去の停止宣言を現行状態の証明にしない。`REDESIGN_PRINCIPLES`、`LEGACY_REFERENCE_POLICY`、`CREATION_PROXIMITY_PRINCIPLES` もこの位置づけで確認した。
- [ARCHITECTURE_V2][arch]、[BRUSH_RENDER_CONTRACT_V2][brush-contract]、`FEATURE_PERFORMANCE_RESOLUTION`、`INTERACTION_MODEL`、[canvas-navigation][nav-spec]から、入力・作品の正本・表示cache・保存を分ける構造を確認した。
- [M08_VIEW_PRESENTATION_BOUNDARY][m08]では、Coreの論理タイルは256px、表示・ブラシ側のタイルとは別の境界である。実コードでもCoreは256px、brush-rtは128px、表示転送atlas/groupは512pxである。これらを同じ「タイル」として負荷計算しない。
- `brush-foundation` / `brush-rt` のarchitecture・adoption/experience文書、M10のnavigation / presentation rebuild / preview関連資料、#64の `ROOT_CAUSE_PROTOCOL` も確認した。ただし、旧protocolの動作実験の指示は今回の静的解析限定の指示により実施しない。

実装の主要な所有境界は、Windowの `BrushSurface / CanvasNavigation / DrawingHost / Core / persistence coordinator`、drawing workerの `RealtimeSession / StrokeOverlay / GpuRenderer`、canonical workerの線再構築、presentation workerの正式画像と512px保持画像、history/persistence workerの保存処理である。Workerに移した処理があることと、Windowに同期処理がないことは同義ではない。

## 4. ペンを離してから完了表示までの実際の処理順

以下は通常の描画終了経路。並行する処理を一つの同期呼出し列と誤認しない。`await` はそのasync関数を中断し、Window全体のイベント受付を停止する命令ではない。

| 段階・実行場所 | 実際の呼出し・データ | 待機と入力への関係 | 根拠 |
|---|---|---|---|
| 1. Windowのcapture | `inputFreezeTrace` がpen `pointerup`を記録。その後 `.surface` captureの `BrushSurface.up`。 | #64のloggerはsurfaceより外側。 | [Trace 53–66][trace-input]、[BS 65–70][bs-init] |
| 2. Windowの描画解放 | `up → finishStroke`。`pointer / target / wrapOrigin / activeStrokeId / reservation` を即座にnullにして `session.end` を呼ぶ。 | 通常終了では `finishing=true` にしない。GPU完了前に描画pointer所有を解く。 | [BS 142–148][bs-finish] |
| 3. Windowのport | `DrawingSessionPort.end → flush → postMessage(samples) → call(end)`。portの `active` も即座にnull。 | 最終サンプルはオブジェクト複製で送る。返却Promiseを待つ間も新規イベントのhandlerは残る。 | [Host 232–243][host-port] |
| 4. drawing worker | `command('end') → RealtimeSession.end`。このworker内でrelease条件・局所builderを処理し、canonical workerへ終了を送る。 | `releaseInteractiveUntil=now+280` は正式描画の負荷制御用。指受付のタイマーではない。 | [DW 101–115][dw-end]、[Session 23–53][session-end] |
| 5. canonical worker | `builder.finish()`、`record()`を返す。強制入り抜き有効なら終了形状を再生成する経路がある。 | canonical処理は別worker。結果のrecordはdrawing workerを経由してWindowへ返る。 | [canonical worker][canonical-worker]、[Model 93–111][model-builder]、[Session 17–20][session-message] |
| 6. drawing worker→Window | sessionの終了record受信・staging・終了Promise解決。`finishPreview` は最終仮線の差替えを依頼する。 | 仮線のCPUラスタライズもdrawing worker内。物理的な指イベントを扱う場所ではない。 | [Session 17–20][session-message]、[Session 43–53][session-end]、[Overlay 138–221][overlay-work] |
| 7. Windowの正式登録準備 | `finishStroke.promise.then → wrappedCopies（seamless時のみ）→ StrokeHandoff.release → pump → controller.commitStroke → CoreStrokeDocumentPort.commitStroke`。 | 予約順にlogical commit。dirty計算等は一部分割されるが、分割されない部分がある。 | [BS 145–148][bs-finish]、[Handoff][handoff]、[Commit 16–49][commit-main] |
| 8. WindowのCore確定 | `shallowRecordGuard → dirtyTiles → 対象再検証 → transaction.recordRasterOperation → tx.commit → surface.withMutations / history.publish`。 | logicalな作品確定。GPU画素の完成とは別。原子的なtx部分は同期。 | [Commit 52–96][commit-dirty]、[Transaction][tx]、[Core commit][core-commit]、[Surface 52–65][core-surface] |
| 9. Windowの公開・UI・保護 | `publishStroke → port.commitRecord → postMessage(commit)`。すぐ `onCommitted → queueLatestCommit / renderLayers / updateHistoryButtons / updateQa`。 | `onCommitted` はGPU待ちの前。保存保護の受付もこの段階。 | [BS 150–152][bs-publish]、[Host 243][host-port]、[Main 163–167][main-commit] |
| 10. drawing workerの正式ジョブ | `command(commit) → session.commitRecord → document.append / end → renderer.markEnded / requestWork / frame → backend.render`。 | 一度に一つのGPU submission。`markEnded` が小分け制御を通常180msに設定する。 | [Session 70–77][session-commit]、[Renderer 358–428][renderer-frame] |
| 11. GPU完了・表示候補 | WebGLはfence + 待ち時間0のpoll、WebGPUはqueue完了Promise。jobをcompleteし、strokeのpresented状態・退役を更新する。 | この待ちはdrawing worker内。Windowのpointer handlerを外さない。GPU所要時間そのものは未測定。 | [GL 565–572][gl-wait]、[GPU 632–637][gpu-wait]、[Renderer 422–428][renderer-frame] |
| 12. drawing workerの画像公開 | `requestPublish → publish → captureTilePages / sink.snapshot → postMessage(picture)`。未ACK画像は一つ。 | worker内の `publishing / unacknowledged / coherent` は画像公開条件であり、DOM入力受付条件ではない。 | [DW 40–56][dw-publish]、[Tile pages 15–34][tile-capture]、[Worker sink 20–22][worker-sink] |
| 13. presentation worker | WindowがpageのImageBitmapをtransferし、workerが128px差分を512px groupへコピー、GPUへupload、group bitmapを返す。 | 通常紙の精密viewport image更新は120ms debounce。seamless/referenceは即時経路。指の受付を120ms止める処理ではない。 | [Host 124–143][host-picture]、[Presentation 10–60][presentation] |
| 14. Windowへの取込みとACK | `pendingDocumentInstall → DocumentPresentation.applyCooperatively → complete`。仮線bitmapはWindowの2D canvasへ `clearRect / drawImage`。最後に `pictureAck`。 | group間にtask境界がある。個々のimage transfer/drawは同期。通常紙は保持groupを使えるが精密imageにも別経路がある。 | [Host 32–103][host-display]、[Host 146–152][host-picture]、[Document presentation 27–37][document-install] |
| 15. 完了応答→status | `renderer.waitStroke → settlePictures → reply → BrushSurface.waitStroke.then → status`。finallyで `gpuFinishes.delete` とUI更新。 | 表示用ACK等の完了を確認する。statusは物理scanoutの検知ではなく、入力の再有効化でもない。 | [DW 100–115][dw-end]、[Renderer 431][renderer-wait]、[BS 150–152][bs-publish] |

`waitStroke`、`settlePictures`、`applyCooperatively` は非同期で循環を回すが、Window入力をGPUのPromiseにぶら下げる呼出しはない。drawing workerの `requestAnimationFrame` はそのworker内で `setTimeout(0)` に置換されている。Window側のrAFを置換していない。

## 5. 指入力を受信・無視・中断できる分岐の照合

### 5.1 受付の順序が重要

同じdocumentでの通常の配送順は、Window captureの診断 → `.surface` captureの `down` → 指の登録 → 新規描画の受付条件である。

`down` の119〜127行で指を `CanvasNavigation.touchDown` に登録し、その後132行で `pointer-active / cancelling / history / document-barrier / operationMode / fault / resource-limit` を判定する。**132行の条件は新しい一筆を止め得るが、先行する指のMap登録やWindow captureログを消す条件ではない。**

| 場所・条件 | 何が起きるか | 今回の三条件「指0・開始ログなし・完了後復帰」を説明できるか |
|---|---|---|
| `down` 113：view/session/preset未初期化 | handlerはreturn。 | 本線を描けている通常の一筆終了だけではこれらをnullにしない。Windowログにも作用しない。 |
| `down` 117：button/input/select/textarea/contenteditable/crop/no-input領域 | canvas操作として扱わない。 | 対象外領域なら操作できないが、同documentのWindow captureには開始が残る。 |
| `down` 118：eyedropper | 指を画面操作でなく色取得として扱う。 | 選択中なら操作意味が違う。通常pen upで自動的に有効になる経路はない。開始ログ欠落は説明しない。 |
| `down` 119–127：touch、penActive、fingerDrawing | Mapへ登録、必要なら直前の描画を終了/取消。指描画OFFなら1本でpan。ONなら1本は描画候補、2本はnavigation。 | `penActive` は指を捨てる条件ではない。pen upではpointerは先にnullになる。 |
| `down` 132：finishing/history/inputBarrier等 | 新規stroke開始をreturnする。pending上限64、formal command数100000、raw50000、保護queue128もここ。 | 指登録より後。開始ログ欠落とMap未登録の直接原因にはならない。 |
| `touchDown` 23–26 | 常にtouchesへset。2本でpairとbegin、panAllowedなら1本でもbegin。 | GPU・正式登録・保存状態を読まない。 |
| `move` 138–141 / `touchMove` 28–45 | 未登録IDのmoveはnavigationで扱わない。登録済みならviewを更新し、Hostで保持sceneをCSS transformする。 | 最初のdownが届かなければ、その後のmoveだけで復活しない。原因ではなく、開始欠落が無反応に繋がる伝播経路。 |
| `pointerup / pointercancel / lostpointercapture` | 指IDをMapから削除。描画pointer一致なら終了/取消。 | 本物のcancelがあれば局所の操作は中断するが、Windowのcancelログは別途観測対象。すべての開始が欠ける理由には単独でならない。 |
| `cancelStroke` 181 | 取消待ちの間だけfinishing=true。 | 通常の `finishStroke` では走らない。さらにtouch登録の前置条件でもない。 |
| `dispose / abort / initializeCurrentSurface` | work切替やgeometry等でlistener・viewを破棄/再初期化する。 | 通常のstroke確定では呼ばれない。 |

根拠：[BrushSurface 113–182][bs-input-all]、[CanvasNavigation 23–55][nav-input]。

### 5.2 DOM・capture・CSS・別document

- `.surface` が固定入力viewportで、canvasではなくその親にcapture listenerを置く。子canvasの差替えやCSS変形で通常の入力境界を失わない。[BS 33–70][bs-init]
- `ViewportScene`、`DocumentPresentation`、Hostの仮線canvasは `pointer-events:none`。黒い長方形等の表示不具合と、全入力が奪われることを同一視しない。[Scene][scene]、[Document presentation][document-install]、[Host 148][host-picture]
- `app.inert=true` はHome表示や作品切替保存、canvasの `pointerEvents='none'` はgeometry操作の限定経路にある。通常のpen up→正式完了の経路から設定されない。`surface.busy` はレイヤー追加やcheckpoint等には使うが、指のdownを止める前提にはしない。[Main 298–328][main-geometry]、[Main 754–760][main-switch]、[Home 158][home-inert]
- 子の `stopPropagation`、bubble listener、132行のreturnでは、それより先に走るWindow captureを取り消せない。ChromiumのDOM dispatcherでもWindowのcapture処理が祖先側の配送より先に呼ばれる（§9）。
- ただし、iframe内のイベントは親Window captureの配送経路に入らない。`captureTouch=isolated` が有効な旧診断URLでは、pen upで受信面iframeを有効化する実装がある。これは親ログ不在の説明になり得るため調べた。**#64の案内URLは `?inputTrace=1#home` であり、`touchProbe=1 / captureTouch=isolated` を含まない。該当iframeはこの案内URLでは起動しない。**実際に実機で開いたURL自体は元JSONに記録されておらず独立確認できない。[Probe 1–30][probe]、[Isolated frame 1–76][isolated]、[QA入口][qa-entry]

## 6. コード上で確認した構造上の問題

以下のF1〜F3は「その構造が存在すること」を確認した指摘である。実機でその分岐・負荷が入力消失を起こした証明とは分ける。

### F1. Windowには分割されない処理が残り、async化だけでは受付時間を保証しない

**F1-a：dirty計算の分割境界が内側の仕事量を上限化していない。**

`dirtyTiles` は64commandごとに3ms経過または256command分の進行でyieldを検討する。一方、`addBounds` の二重ループにはyieldがなく、1commandの境界矩形から最大65536個のCoreタイル候補を列挙できる。文書内へのfilterは列挙後の27行である。3msは中断期限ではなく「その地点まで来たときの判定値」であり、単一commandや64commandまでの処理を3ms以内に拘束しない。[Commit 65–96][commit-dirty]

その後の `transaction.recordRasterOperation` はcommandIndicesを複製・freezeし、`RasterSurfaceManifest.withMutations` でも複製・検証・既存mutationの集約を行う。原子的なcommit部分にはtask境界がない。Coreタイルは256pxであり、GPUの128pxジョブ数とは別である。[Transaction 33–38][tx]、[Surface 52–65][core-surface]

**F1-b：画像更新の一部が入力と同じWindowで同期実行される。**

`DocumentPresentation.applyCooperatively` は512px group間に `setTimeout(0)` を入れるが、group一つの `transferFromImageBitmap` 自体は同期呼出しである。Hostの仮線更新も、canvas寸法変更、`clearRect`、`drawImage` をWindowで行う。`picture` がasyncでも、各 `await` の前後の同期部分は入力handlerと同じスレッドを使う。[Document 27–37][document-install]、[Host 146–152][host-picture]

通常紙では#63の `inputFirstProbe=true` により保持groupが優先されるため、常に全viewport bitmapをWindowへuploadする、とはいえない。fallbackやseamless/reference等の別経路は残る。[Host 70–103][host-display]

**F1-c：メッセージ・seamless・保存の受付も無償ではない。**

Windowの `send/call` は `postMessage({method,args})` でsamplesを送り、配列をtransferする経路ではない。seamless有効時は `wrappedCopies` がWindowでrawを再投入し `CanonicalBuilder.finish()` を呼ぶ。通常紙ではこの再構築は実行しない。[Host 115–116][host-send]、[Host 237–243][host-port]、[Seamless 15–29][seamless]

`persistence.noteCommit` は復旧packetを取得してqueueへ入れ、後のidle/timer drainでpacketをworkerへ送る。`save-prepare:start/end` は主に `noteCommit` の範囲であり、後続のdrain・serializing・正式画像全体の時間ではない。ただし、今回報告された0.4〜1.3msはその同期区間を長時間停止の主犯とする説明に反する。Coreの正本はsemantic recordを保持しており、この通常経路を「毎回全画面ピクセルを同期保存する」と説明するのも誤り。[Coordinator 42–45, 118–126][persistence]、[Main 163–167][main-commit]

**現象との照合：** F1はイベント配送の遅延を起こし得る箇所を具体化する。しかし実際の所要時間は静的には出せず、長い一つのWindowタスクで275〜306ms全区間を塞いだならtimer/rAFの大きなgap等と整合させる必要がある。対応する明確な記録がないという前提に対し、F1の存在だけでその長時間停止を認定してはならない。短いタスクの反復、ブラウザー内部待ち、計測の欠落を追加仮定しない限り、今回の全現象を完結して説明しない。

### F2. 操作中情報が正式描画側へ伝わらず、gestureActiveの項は効果を持たない

現行の開始経路は `CanvasNavigation.begin → DrawingHost.beginViewportNavigation → ViewportScene.begin`。移動中はCSS matrixだけを更新する。drawing workerにnavigation開始/終了のmessageを送らない。workerの `command` にnavigation caseもない。[Navigation 15–26][nav-input]、[Host 186–210][host-nav]、[DW 101–139][dw-end]

しかし正式描画側には次が残っている。

```js
const interactiveFormal = this.tiledPresentation &&
  (this.gestureActive || active || performance.now() < (this.releaseInteractiveUntil ?? 0));
```

`GpuRenderer.gestureActive` を現行経路でtrueにする代入は見つからない。Windowの `CanvasNavigation.gestureActive` は別インスタンスのprivate状態であり、自動的に共有されない。したがって正式描画の小分け判断における `this.gestureActive` の項は、現行アプリの指操作を検知しない。[Renderer 412–418][renderer-frame]

履歴上、[commit `1a758474`][deleted-navigation] が2026-10-22に次のcaseを削除したことを確認した。

```js
case 'navigation': r.gestureActive = !!a; return;
```

Windowの新しい保持scene方式へ移行した後も、renderer側の参照だけが残った状態である。rendererに残る `setNavigationActive` も、現行のHost開始経路から呼ばれない。さらにrendererの `navigationActive` による早期returnは `!tiledPresentation` の条件付きで、現行drawing workerの `tiledPresentation:true` には適用されない。

一方、[M10_PRESENTATION_REBUILD 21–28行][rebuild-design]は、指操作中も正式描画を止めず、WindowのCSS移動を別経路にする設計を明記している。従って、通知の削除それ自体を意図しない不具合や「正式描画を停止すべきだった証拠」とは認定しない。確認したのは、rendererに残る操作中専用の負荷予算条件が現行アプリの操作状態を受け取らないことと、そのための制御上の制約である。

**確定する影響：** 指操作中という理由では `interactiveFormal` がtrueにならない。release期間やactive stroke等の別条件が切れると、指操作が続いていてもidle側の正式ジョブ予算になり得る。保持sceneのCSS移動そのものはこの通知を必要としないため、局所のview更新が必ず止まるという意味ではない。

**現象との照合：** 背景GPU負荷の制御不足としては成立する。しかし指の開始がWindowに届く前に働く条件ではなく、Window captureログ欠落を直接生む処理でもない。GPU/ブラウザー内部への影響を別途証明しない限り、今回の根本原因とは認定できない。また、最初の指downさえ届かない段階で「gestureActiveがtrueにならない」ことを循環論法で原因にしない。

### F3. 正式GPU仕事量の予算は厳密な上限ではない

現行のtiled描画は、interactive時にジョブ上限1、pixel-command予算65536を使う。しかし `boundedFormalJobs` のbreak条件は `out.length && cost + work > budget` であり、**最初の一ジョブは予算を超えても投入する**。[Renderer 412–418][renderer-frame]、[Renderer 654–657][bounded]

`TileDocument.peekMany` は非commitジョブのcommandを最大16個まとめる。非continuousブラシの一ジョブが16commandなら、関数内の見積り値は `128 × 128 × 16 = 262144` で65536を超える。これはこの関数のコストモデル上の計算であり、実GPU時間・実描画pixel数の測定値ではない。ジョブ内の再分割はここでは行わない。[TileDocument 243–273][tile-document]

正式描画・画像capture・別presentation workerのupload/presentationは同じ端末のブラウザー/GPU資源を利用する。Worker間でJavaScriptのevent loopを分離しても、物理GPU等まで独占的に分離したことにはならない。一方、共有資源があるという一般的事実だけでは、AndroidからDOMまでの指イベントが破棄されたことを証明できない。

`releaseInteractiveUntil` の280ms、`markEnded` の180ms、presentationの120msは入力禁止期間ではない。280msと実機ログの約275〜306msが近いことは、原因の証拠にならない。180msで再設定される別経路もある。いずれの値も指のMap登録やWindow loggerの条件には使われない。

## 7. 既存ログが測っているもの・測っていないもの

| 実装 | 読み取れること | 読み取れないこと |
|---|---|---|
| Window passive captureのtouch/pointer | 当該Windowまで配信されhandlerが動いた開始/終了/cancel。pending strokeで除外する条件はない。 | 端末が物理接触を検出した時刻、OS段階で落ちたイベント、別documentへの入力。 |
| `touchCount=e.touches.length` | 配信されたTouchEventのtouches数。 | OSの物理的な指本数を直接読んでいるわけではない。 |
| `pointerIds` | touchとpenのdownを両方数え、up/cancelで削除する。 | UIの「Pointer指」は純粋な指だけの数ではない。hoverも追跡しない。 |
| touchmove | touches数は更新する。 | log行は追加しない。pointermoveもこのloggerの収集対象ではない。 |
| 35ms timer | `elapsed-35 >= 45`、すなわち約80ms以上のtick間隔で `timer-stall`。 | 正常tickはevents配列に残らず、短いtask群・すべての待ち時間を復元できない。 |
| rAF | 100msを超えるcallback間隔で `frame-gap`。 | 物理的な画面提示、入力受付能力、GPU実行時間そのもの。 |
| PerformanceObserver | 対応環境でlongtask / event timing entryを受ける。 | API登録成功・対応可否をsnapshotに保存せず、例外はcatchする。eventsの `at` はobserver callbackの時刻で、実行区間はdetailsのstart/duration。 |
| status observer | 同じ文字列でなければ「線を作品に反映」等を `formal-confirmation` にする。 | 同じ完了文言を連続設定するとlastStatus一致で省略する。2/3試行の `status-write` と区別する必要がある。 |
| `status-write` | mainのstatus関数呼出し時刻。 | GPU完了や画面scanoutの直接計測ではない。 |
| events上限4000 | 現在保持している末尾ログ。 | shiftで消えた件数・欠落範囲を保存していない。 |
| snapshot | timeOriginと統計・events。 | URL、commit、OS/Chrome版、target/composedPath、物理接触、別frameの履歴、observer可用性。 |

根拠：[inputFreezeTrace 6–125][trace-all]。`clear()` はlogと一部の最大値を消すが、touchStarts等すべての状態を初期化する関数ではない。提示された集計値だけから特定の一筆の状態を復元しない。

診断は操作handlerを変更していないが、35msごとのDOMテキスト更新やイベント時renderはWindow上で実行する。「passive listenerだから負荷ゼロ」ともいえない。ただし、その負荷が今回の原因という測定証拠はない。

**証拠の強さ：** 同じdocument・有効なlogger・該当時間範囲の保持が成立するなら、Windowより下位のアプリhandlerの無視だけで開始ログまでなくなるとは説明できない。これは境界の絞込みであり、「OSまで絶対に届いていない」「Chromeまで一切届いていない」という証明ではない。

## 8. 過去PRとコード変更の比較

PR番号順をそのまま採用履歴とみなさず、固定head SHAが主対象の祖先かをGitの履歴で確認した。

| 変更・PR | 主対象との関係 | コードで確認した変化と意味 |
|---|---|---|
| #37 / #38 / #40 / #41 | 取得した各headは祖先。 | 即時操作、worker分離、保持sceneへ続く経路。#39の最新headは非祖先だが、その一部と同様の仕組みが後続に存在するかは個別のコードで判断する。 |
| `1a758474` | 祖先。 | 旧navigation caseを削除。rendererのgestureActive参照は現行に残る。F2の具体的な実装変化。 |
| [#49][pr49] `980eab54` | 祖先。 | `9503666c` にて仮線canvasのbitmaprendererを透明2D clear/drawに変更。黒い矩形対策であり、Window画像処理の配置を変えた。これが指消失の初発点とする実機証拠はない。 |
| #50 `798dd97b` / #51 `26580d3b` | いずれも非祖先。 | navigation優先・正式処理抑制等の別案。#51にあるnavigationHold等を現行の動作として説明してはならない。 |
| #52〜#55 | 取得した各headは非祖先。 | 排他モード、保持画像、入力先判定等の実装案。現行への適用をPRタイトルだけで仮定しない。 |
| [#56][pr56] `9d92ba2f` | 祖先。 | #49へ戻した系統。#49と#56の `brushSurface / brush-rt/src / strokeCommit` のdiffはない。touch probeが追加された。 |
| #57 `a8804cd7` / #58 `ec317525` | 祖先。 | 明示的に起動するtouch capture面・isolated iframeを追加。通常URLと診断URLを区別する。 |
| [#59][pr59] `7d0c8f5d` | 祖先。 | `4feb5547 / f861ff1a` でgroup間の協調的取込み・保持画像優先を導入。当初は診断側の条件付き。 |
| [#60][pr60] `6586b3f8` | 祖先。 | `b21f6be4` で正式登録準備をyield、`a0cd33ed` でcommand数進行の境界、`6586b3f8` でyield後の対象再検証を追加。F1-aの内側・原子的txの同期区間は残る。 |
| #61 `83b7c7f5` / #62 `1c684317` | 非祖先。 | 旧版起点の診断・ablation。これらの分岐・結果を現行版の実験結果に流用しない。 |
| [#63][pr63] `902d7464` | 比較元・祖先。 | `72c364cc` でsurface capture受信、厳密なcanvas/surface target一致条件を撤去。`74986fcd` で `inputFirstProbe=true` を通常経路にも適用。 |
| [#64][pr64] `eeea860a` | 主対象。 | #63との差分はtrace、mainへのmarker、QA protocol/入口、workflow。入力本体・GPU・描画Hostを修正したPRではない。 |

従って、#63以前の厳密target比較や、#51のnavigationHoldをそのまま今回の原因・対策として扱うことはできない。履歴はF2の変化やF1の残存を証明するが、**同じ条件の「最後に正常だった版」と「最初に失敗した版」の実機比較がないため、入力消失のfirst bad commitは確定しない。**

既存の別調査ブランチ `investigate/M10-input-loss-evidence-2026-10-26` の `13ed650a` と報告書も読解した。同ブランチのauditスクリプトは実行していない。その報告の結論や検証結果を今回の独立証明として再利用していない。

### 8.1 #63等の自動検証が今回の現象を保証しない理由

既存 `scripts/m10-live-touch-regression.mjs` はheadless Chrome / SwiftShaderを使い、`fingerDrawing` をONにし、合成touchで描画を開始し、formal gateで意図的に保留して別の合成touchを送る。子divを受信先にした条件も検査している。[Script 39–106][synthetic]

この実装を読む限り、固定viewportのcapture・子target・確定待ちでもlocal viewを更新できるかの確認にはなる。しかし、実ペンのUP/hoverから物理的な指への切替、Androidの入力フィルター、実GPU処理中の資源競合を通らない。意図的なgate待ちとGPUが実行中の状態も同一ではない。従来のPASSと今回の実機不合格は、この対象範囲の差を残したまま両立し得る。今回このスクリプトは実行していない。

## 9. OS・ブラウザーの一次ソースとの照合

OS由来という言葉だけで打ち切らず、DOMへ届く前に失われ得る分岐も静的に追った。以下の固定revisionは実機の搭載版を特定したものではない。端末固有driver/vendor変更やfeature flagも未確認であり、**存在する分岐を実機が通ったという主張はしない。**

### 9.1 AOSP：stylus優先・palm抑制は実在するが、正式描画完了とは結び付かない

固定revision：`4f463a6b1de9198963dc6aff74154a504ba3f8f6`。

[PreferStylusOverTouchBlocker.cpp 101–190][aosp-stylus]は、設定によりstylusのDOWNまたはHOVER_ENTERで優先状態を作り、既存touchをcancelし、active stylusがある間に始まったtouchデバイスのstreamを捨て得る。優先状態の解除はUPまたはHOVER_EXITの条件であり、Webアプリの正式描画完了ではない。混在toolを同じデバイスが送る条件ではこのblockerを適用しない分岐もある。

重要なのは、cancel対象のtouch deviceが登録されたstreamは、そのtouchのUPまで捨てる設計になっている点である。**ペンを離せば、すでに捨てた同じ指のstreamを自動的に再生する処理ではない。**本線確定と同時に、置いたままの同じ指が復活したという厳密な現象まで、このblockerだけでは説明しない。

[UnwantedInteractionBlocker.cpp][aosp-unwanted]にはpalmとして抑制したpointerを除外・cancelする分岐があり、設定によりstylus優先blockerを使わない経路もある。[TouchInputMapper.cpp 1701–1747][aosp-touch]は外部stylusとの情報結合のため初期touchを保留できるが、対応headerの値は72ms、別のtouch timeoutは20msである。固定したこの実装に、Illustroの本線確定を待つ約300msの一般規則はない。[TouchInputMapper.h 55–58][aosp-touch-h]

**照合：** JavaScriptが回り指0になる現象とは条件付きで両立する。一方、実機の入力デバイス構成、hoverの有無、接触した指が一度離れたか等は未確定であり、根本原因とは認定できない。

### 9.2 Chromium：DOMより前にも受信・消費・フィルターの境界がある

固定revision：`dddbf4af8531632185b2fc08ead7f06cdf13848e`。

| 一次ソース・箇所 | 確認した分岐 | 今回への制約 |
|---|---|---|
| [EventForwarder.java 252–269, 360–363][chrome-forward] | MotionEventの検証・転送前処理、stylus writing delegateによる消費。 | 実機でdelegateが動いていた証拠はない。 |
| [RenderWidgetHostViewAndroid 1596–1755][chrome-android] | redundant DOWN filter、stylus text selection、overscroll、Vizへのinput transfer、WebTouchへのroute。 | 親Windowに届く前の境界はあるが、対象での分岐条件は不明。 |
| [InputRouterImpl 643–669][chrome-router] | Browser側のfilterがeventを消費/破棄し、rendererへ転送しない条件。 | 「Windowログなし」だけでAndroidより上へ一度も来なかったとは断定できない。 |
| [PassthroughTouchEventQueue 426–506][chrome-queue] | handlerなし、ACK timeout中、既知pointer/移動等のfilter。 | 対象pageにはhandlerがある。各filterの適用状況は未確認。 |
| [PointerEventManager 610–695, 854–874][chrome-pointer] | target/frame判定、pointer dispatch、pointerごとのimplicit captureとUP/CANCEL後解放、TouchEventへの受渡し。 | penのcaptureがすべての新しいtouch IDをGPU完了まで捕まえる、という規則はない。 |
| [TouchEventManager 348–499][chrome-touch] | slop範囲moveの抑制、touch targetごとのdispatch。 | moveの間引きだけでは、両方の開始イベントがないことを説明しない。 |
| [EventDispatcher 308–348][chrome-dom] | Window captureを先に呼び、その後祖先経路へ配送。 | 同document内の子handlerが後からWindowログを消す説明に反する。 |

ACK timeoutについては、[TouchTimeoutHandler][chrome-timeout]に、timeout後のACK待ち中は後続eventをfilterする実装がある。しかし [InputRouterImpl 925–937][chrome-router-timeout] では、allowed/compositorの `touch-action:none` に応じtimeoutを無効化する。Illustroはsurfaceに `touchAction='none'` を設定するため、単に「Chromeの約300msのtimeoutだ」と断定できない。搭載版・touch-actionの伝播・該当時点のACK状態がわからない以上、この仮説も未確定である。

PointerEventManagerのprevented pointerdownに関係するqueueは互換mouse/gestureの抑制であり、一般にその後の全touch開始をGPU完了まで遮断する命令とは読めない。`preventDefault()` があるという理由だけで今回の消失を確定しない。

以上の入力層の分岐に、Illustroの `gpuFinishes / waitStroke / status / pictureAck` を直接参照する処理はない。「本線完了まで操作できない」という時間的関係をOS/Chrome側の原因へ結ぶには、共有資源・入力stream状態等の具体的な接続が必要であり、それは取得した静的資料では証明されない。

## 10. 競合する説明と反証・不足する接続

| 説明 | コード・ログと整合する部分 | 成立しない部分 / 未証明の接続 | 判定 |
|---|---|---|---|
| GPU完了までfinishing/inputBarrierが指をreturn | 新規strokeには停止条件がある。 | 通常終了でfinishingを立てず、指登録は条件より先。Window loggerにも条件がない。 | 通常経路の直接原因として不成立。 |
| 仮線canvasが全面を覆いイベントを奪う | 重なるDOM layerはある。 | pointer-events:none、固定surfaceのcapture、Window captureが先行。 | 現行の通常layerだけを原因にする説明は不成立。 |
| 子target / bubble stopで落ちる | 過去版には厳密target条件があった。 | #63で撤去済み。Window loggerはさらに外側。 | 主対象の直接原因として不成立。 |
| 一つの長いWindow処理が全期間を塞ぐ | F1の同期区間は存在。 | 明確な長いJS停止の対応記録がない前提と照合できていない。元JSONも未取得。 | 原因認定不可。 |
| WorkerのGPU待ちPromiseがWindowを直接止める | formal/pictureの待ちはある。 | Worker所有・非同期であり、DOM受付の待ち条件ではない。 | この形の説明は不成立。 |
| 操作通知の断絶・GPU予算超過がブラウザー入力を圧迫 | F2/F3はコードで確認。pen up後にformal負荷が始まり、終了後に減る。 | GPU等からブラウザー入力配送への因果経路・実時間がない。最初の開始ログ欠落を直接説明しない。 | 構造上の問題。今回の原因は未確定。 |
| stylus/palm抑制 | OSに実在し、JS継続・指0と両立し得る。 | 搭載版・入力構成・hover・同じ接触streamの条件が不明。本線完了とは直接連動しない。 | 候補。未確定。 |
| Chromeの入力filter / ACK待ち | DOM前の破棄経路は実在。 | 適用状態不明。touch-action:noneによるtimeout無効化もある。 | 候補。未確定。 |
| isolated iframeへ入力していた | 有効なら親のWindowログには出ない。 | #64案内URLでは起動しない。実際のURLは未記録。 | 条件付きの別経路。通常原因にしない。 |
| 完了statusが指入力を解除した | 見かけの時系列は近い。 | status経路に入力再有効化なし。完了ログは物理提示の検知でもない。 | 因果関係は証明されない。 |

## 11. 根本原因を確定しない理由と、今回確定した境界

今回確定したアプリ内の因果関係は次である。

1. ペンを離すとpointer所有は即座に解放され、record確定・Core登録・GPU正式描画・表示公開が進む。
2. 指のdownがsurfaceへ来れば、通常のtouch経路は正式描画待ちとは独立に指を登録する。moveはその登録を前提とし、未登録IDのmoveだけではnavigationを開始できない。
3. 完了時には正式ジョブ・表示待ち・仮線の状態が片付くが、指受付を復帰させる処理はない。
4. Window captureで開始が観測されないという前提が成立するなら、surface以降の待機フラグ・描画状態だけを原因にする説明では不足する。
5. 入力より前のOS/ブラウザー層には実在の抑制・filterがあるが、当該実機での適用は確定していない。F1〜F3との接続も未証明。

従って、**ソースから証明できた問題は「入力と確定負荷の分離に残る同期区間」「操作状態と描画制御の断絶」「厳密でないGPU仕事量上限」である。これらを実機の指入力消失そのものの根本原因と断定することはできない。** 未確定の接続を補って「原因を特定した」とは報告しない。

残る未確定事項を、実機が使えないという一般論でまとめず列挙する。

- 実際の接触開始が、driver、InputReader/InputDispatcher、Android→Chrome、Browser→renderer、対象documentのどの境界まで来たか。
- 当該実機に搭載されたOS/Chromeのrevision・設定・入力device構成と、hover/palm判定の状態。
- 消失中の接触が同じ指streamの継続か、離して再接触した新しいstreamか。
- 原JSONのURL/読込版・該当時間範囲・target/frame・observer可用性・ログ上限の影響。
- Window同期区間、メッセージ複製、GPU submission、image取込みの実際の占有時間と入力配送への影響。
- 「本線完了」「表示の見た目」「status」「実際の操作復帰」の各時刻の厳密な関係。
- 同一条件でのfirst good / first bad commit。

この報告は静的解析の到達点であり、機能合格・実機解決・根本原因確定の宣言ではない。修正・高速化・再構築・新規検査機能・動作実験は行っていない。

## 12. 参照資料

ファイル全体の所在、blob/hash、文書の章立て一覧、対象コード・公開bundle・外部一次ソースの固定値は [SOURCE_INVENTORY.md](SOURCE_INVENTORY.md) を参照。本文のソースリンクは調査対象SHAに固定している。

[aosp-stylus]: https://android.googlesource.com/platform/frameworks/native/+/4f463a6b1de9198963dc6aff74154a504ba3f8f6/services/inputflinger/PreferStylusOverTouchBlocker.cpp#101
[aosp-touch]: https://android.googlesource.com/platform/frameworks/native/+/4f463a6b1de9198963dc6aff74154a504ba3f8f6/services/inputflinger/reader/mapper/TouchInputMapper.cpp#1701
[aosp-touch-h]: https://android.googlesource.com/platform/frameworks/native/+/4f463a6b1de9198963dc6aff74154a504ba3f8f6/services/inputflinger/reader/mapper/TouchInputMapper.h#55
[aosp-unwanted]: https://android.googlesource.com/platform/frameworks/native/+/4f463a6b1de9198963dc6aff74154a504ba3f8f6/services/inputflinger/UnwantedInteractionBlocker.cpp#278
[arch]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/docs/architecture/ARCHITECTURE_V2.md
[baseline]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/docs/IMPLEMENTATION_BASELINE.md#L9-L20
[bounded]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/renderer.mjs#L654-L657
[brush-contract]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/docs/architecture/BRUSH_RENDER_CONTRACT_V2.md
[bs-finish]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/brushSurface.ts#L142-L148
[bs-init]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/brushSurface.ts#L33-L70
[bs-input-all]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/brushSurface.ts#L113-L182
[bs-publish]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/brushSurface.ts#L150-L154
[canonical]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/docs/CANONICAL_INDEX.md
[canonical-worker]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/canonical.worker.mjs
[chrome-android]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/content/browser/renderer_host/render_widget_host_view_android.cc#1596
[chrome-dom]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/third_party/blink/renderer/core/dom/events/event_dispatcher.cc#308
[chrome-forward]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/ui/android/java/src/org/chromium/ui/base/EventForwarder.java#252
[chrome-pointer]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/third_party/blink/renderer/core/input/pointer_event_manager.cc#610
[chrome-queue]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/components/input/passthrough_touch_event_queue.cc#426
[chrome-router]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/components/input/input_router_impl.cc#643
[chrome-router-timeout]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/components/input/input_router_impl.cc#925
[chrome-timeout]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/components/input/touch_timeout_handler.cc#1
[chrome-touch]: https://chromium.googlesource.com/chromium/src/+/dddbf4af8531632185b2fc08ead7f06cdf13848e/third_party/blink/renderer/core/input/touch_event_manager.cc#348
[commit-dirty]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/strokeCommit.ts#L52-L96
[commit-main]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/strokeCommit.ts#L16-L49
[core-commit]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/core/src/commit.ts
[core-surface]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/core/src/raster/surface.ts#L52-L65
[deleted-navigation]: https://github.com/totoro0419/illustro/commit/1a758474c4d8525005ba116fe9432c021c264294
[document-install]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/document-presentation.mjs#L1-L41
[dw-end]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/drawing.worker.mjs#L100-L141
[dw-publish]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/drawing.worker.mjs#L40-L71
[gl-wait]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/renderer.mjs#L565-L572
[gpu-wait]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/renderer.mjs#L632-L637
[handoff]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/strokeHandoff.ts
[home-inert]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/ui/homeShell.ts#L152-L161
[host-display]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/drawing-host.mjs#L32-L103
[host-nav]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/drawing-host.mjs#L186-L210
[host-picture]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/drawing-host.mjs#L124-L152
[host-port]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/drawing-host.mjs#L232-L244
[host-send]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/drawing-host.mjs#L115-L116
[isolated]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/isolatedTouchFrame.ts
[log-comment]: https://github.com/totoro0419/illustro/pull/64#issuecomment-6396897243
[m08]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/docs/architecture/M08_VIEW_PRESENTATION_BOUNDARY.md
[main-commit]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/main.ts#L163-L167
[main-geometry]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/main.ts#L298-L328
[main-switch]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/main.ts#L754-L760
[model-builder]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/model.mjs#L93-L111
[nav-input]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/canvasNavigation.ts#L15-L55
[nav-spec]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/docs/features/canvas-navigation.md
[overlay-work]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/stroke-overlay.mjs#L138-L221
[persistence]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/persistence/coordinator.ts#L42-L126
[pr49]: https://github.com/totoro0419/illustro/pull/49
[pr56]: https://github.com/totoro0419/illustro/pull/56
[pr59]: https://github.com/totoro0419/illustro/pull/59
[pr60]: https://github.com/totoro0419/illustro/pull/60
[pr63]: https://github.com/totoro0419/illustro/pull/63
[pr64]: https://github.com/totoro0419/illustro/pull/64
[presentation]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/presentation.worker.mjs#L10-L60
[probe]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/passiveTouchProbe.ts#L1-L35
[qa-entry]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/qa/m10-real-input/index.html
[readme]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/README.md
[rebuild-design]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/docs/research/M10_PRESENTATION_REBUILD_2026-10-21.md#L21-L28
[renderer-frame]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/renderer.mjs#L358-L428
[renderer-wait]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/renderer.mjs#L431-L432
[scene]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/viewport-scene.mjs
[seamless]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/seamlessStroke.ts#L15-L29
[session-commit]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/session.mjs#L70-L77
[session-end]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/session.mjs#L23-L53
[session-message]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/session.mjs#L17-L20
[synthetic]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/scripts/m10-live-touch-regression.mjs#L39-L106
[tile-capture]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/presentation-tiles.mjs#L15-L34
[tile-document]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/renderer.mjs#L243-L273
[trace-all]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/inputFreezeTrace.ts#L6-L125
[trace-input]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/apps/editor/src/inputFreezeTrace.ts#L53-L66
[tx]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/core/src/transaction.ts#L33-L38
[worker-sink]: https://github.com/totoro0419/illustro/blob/eeea860a1997bbe613af4e07601d78e0a39eeceb/packages/brush-rt/src/worker-stroke-sink.mjs#L20-L22

