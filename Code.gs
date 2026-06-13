/**
 * 日本株 ADR ADR-東証 Top 10（Google Apps Script / スタンドアロン）
 *
 * Apps Script:
 *   https://script.google.com/home/projects/1BOpPAteTdkKriIfgG--FDNr2KaEB1-7-pnfrpkSjORx5ZqN0nAyK-AG9/edit
 *
 * データソース:
 *   - 一覧: nikkei225jp.com/_data/_nfsWEB/adr/_adr_all.js
 *   - ハイブリッド: 一覧が日付グレーアウトの銘柄のみ個別 JSON で ADR 終値を補完
 *   - https://nikkei225jp.com/adr/
 *
 * clasp push:
 *   clasp push
 *
 * 初回セットアップ（Apps Script エディタから実行）:
 *   1. setupProperties()  … SLACK_WEBHOOK_URL を設定
 *   2. testSlackNotification()  … テスト通知
 *   3. installDailyTrigger()  … 毎日 JST 6:05 自動通知
 *
 * 実行フロー:
 *   一覧取得 → stale 銘柄のチャート JSON を全件取得（時間超過時は自動続行）
 *   → 全件完了後に Slack 通知（途中通知なし）
 */

const PIPELINE = {
  PENDING: 'ADR_PIPELINE_PENDING',
  QUOTES: 'ADR_PIPELINE_QUOTES',
  OPTIONS: 'ADR_PIPELINE_OPTIONS',
  SESSION_KEY: 'ADR_PIPELINE_SESSION_KEY',
};

const CONFIG = {
  TRIGGER_HOUR_JST: 6,
  TRIGGER_MINUTE_JST: 5,
  MIN_ACTIVE_ROWS: 30,
  /** ADR終了直前の更新のみ採用（終了の何分前まで） */
  ADR_QUOTE_MAX_AGE_MINUTES: 120,
  /** 終了時刻後のデータ取り込み猶予（分） */
  ADR_QUOTE_GRACE_MINUTES: 10,
  DATA_BASE_URL: 'https://nikkei225jp.com',
  DATA_REFERER: 'https://nikkei225jp.com/adr/',
  PATH_ADR_ALL: '/_data/_nfsWEB/adr/_adr_all.js',
  PATH_ADR_CHART: '/_data/_nfsWEB/adr/',
  /** 一覧 [13]=MM/DD 不一致時に個別チャート JSON で補完 */
  HYBRID_CHART_ENABLED: true,
  HYBRID_FETCH_CHUNK_SIZE: 10,
  /** HTTP Range で末尾のみ取得（フル ~86KB/銘柄を避ける） */
  HYBRID_RANGE_TAIL_BYTES: 25000,
  /** パース対象の末尾バイト数（Range 取得分をそのまま走査） */
  HYBRID_CHART_TAIL_BYTES: 25000,
  /** 1 回の実行でチャート取得に使う時間（ms）。超過分は続行トリガーへ */
  PIPELINE_EXECUTION_BUDGET_MS: 270000,
  /** 続行トリガーまでの待機（ms） */
  PIPELINE_CONTINUE_DELAY_MS: 30000,
  ADR_PAGE_URL: 'https://nikkei225jp.com/adr/',
};

/**
 * 初回のみ Apps Script エディタから実行してください。
 * SLACK_WEBHOOK_URL を ADR 用チャンネルの Webhook に差し替えてから Run。
 */
function setupProperties() {
  PropertiesService.getScriptProperties().setProperties({
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/xxx/xxx/xxx',
  });
  Logger.log('スクリプトプロパティを保存しました');
}

function installDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('runAfterAdrClose')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.TRIGGER_HOUR_JST)
    .nearMinute(CONFIG.TRIGGER_MINUTE_JST)
    .inTimezone('Asia/Tokyo')
    .create();
  Logger.log(
    `ADR終了トリガーを設定しました（JST ${CONFIG.TRIGGER_HOUR_JST}:${String(
      CONFIG.TRIGGER_MINUTE_JST
    ).padStart(2, '0')}）`
  );
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    const fn = t.getHandlerFunction();
    if (fn === 'runAfterAdrClose' || fn === 'updateAdrRanking') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function removePipelineContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'processHybridPipelineBatch_') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** 時間トリガーから呼ばれるエントリポイント（ADR取引終了後） */
function runAfterAdrClose() {
  startAdrRankingPipeline({ notifySlack: true });
}

/** 手動実行用（パイプライン経由） */
function updateAdrRanking(options) {
  startAdrRankingPipeline(options || {});
}

function testSlackNotification() {
  startAdrRankingPipeline({
    notifySlack: true,
    testSlack: true,
    relaxedFreshness: true,
  });
  Logger.log('Slack テスト通知パイプラインを開始しました');
}

/**
 * stale 銘柄のチャート取得が全件終わってから Slack 通知する。
 * 1 回 6 分で終わらない場合は processHybridPipelineBatch_ で自動続行。
 */
function startAdrRankingPipeline(options) {
  options = options || {};
  Logger.log('更新開始（パイプライン）');
  removePipelineContinuationTriggers_();
  clearPipelineState_();

  Logger.log('nikkei225jp.com から ADR データ取得中…');
  const listText = fetchAdrListText_();
  const now = new Date();
  const sessionKey = getAdrSessionDateKey_(now);
  const allRows = parseAdrRows_(listText);
  if (allRows.length < 50) {
    throw new Error('ADR データが不足しています: ' + allRows.length + ' 件');
  }

  const useHybrid = options.hybridChart !== false && CONFIG.HYBRID_CHART_ENABLED;
  const pending = useHybrid ? collectStaleCodes_(allRows, sessionKey) : [];

  if (pending.length === 0) {
    Logger.log('チャート JSON 補完: 対象なし — 即時集計');
    deliverAdrRankingResult_(
      buildRankingFromRows_(allRows, sessionKey, now, options, {}),
      options
    );
    return;
  }

  Logger.log('チャート JSON 補完: 対象 ' + pending.length + ' 銘柄 — パイプライン開始');
  savePipelineState_({
    pending: pending,
    quotes: {},
    options: options,
    sessionKey: sessionKey,
  });
  processHybridPipelineBatch_();
}

/** 続行トリガーから呼ばれる。全 stale 銘柄の取得完了後に Slack 通知。 */
function processHybridPipelineBatch_() {
  const state = loadPipelineState_();
  if (!state) {
    Logger.log('パイプライン状態なし — 終了');
    return;
  }

  const now = new Date();
  const startedMs = Date.now();
  const budgetMs = CONFIG.PIPELINE_EXECUTION_BUDGET_MS;
  let pending = state.pending.slice();
  const quotes = Object.assign({}, state.quotes);
  Logger.log('チャート JSON 補完バッチ: 残り ' + pending.length + ' 銘柄');

  while (pending.length > 0 && Date.now() - startedMs < budgetMs) {
    const chunk = pending.splice(0, CONFIG.HYBRID_FETCH_CHUNK_SIZE);
    const batchQuotes = fetchAdrChartQuotes_(chunk, state.sessionKey, now, state.options);
    chunk.forEach((code) => {
      quotes[code] = batchQuotes[code] || null;
    });
  }

  savePipelineState_({
    pending: pending,
    quotes: quotes,
    options: state.options,
    sessionKey: state.sessionKey,
  });

  const rescued = Object.keys(quotes).filter((code) => quotes[code]).length;
  Logger.log(
    'チャート JSON 補完進捗: 取得試行 ' +
      Object.keys(quotes).length +
      ' / 対象、有効クォート ' +
      rescued +
      '、残り ' +
      pending.length
  );

  if (pending.length > 0) {
    Logger.log(
      'チャート JSON 補完: ' +
        pending.length +
        ' 銘柄残 — ' +
        Math.round(CONFIG.PIPELINE_CONTINUE_DELAY_MS / 1000) +
        ' 秒後に続行'
    );
    scheduleNextPipelineBatch_();
    return;
  }

  Logger.log('チャート JSON 補完: 全対象銘柄の取得完了');
  finalizeAdrRankingAndNotify_();
}

function finalizeAdrRankingAndNotify_() {
  const state = loadPipelineState_();
  if (!state) {
    throw new Error('パイプライン状態がありません');
  }

  const now = new Date();
  const listText = fetchAdrListText_();
  const allRows = parseAdrRows_(listText);
  const validQuotes = {};
  Object.keys(state.quotes).forEach((code) => {
    if (state.quotes[code]) {
      validQuotes[code] = state.quotes[code];
    }
  });

  const data = buildRankingFromRows_(
    allRows,
    state.sessionKey,
    now,
    state.options,
    validQuotes
  );

  clearPipelineState_();
  removePipelineContinuationTriggers_();
  deliverAdrRankingResult_(data, state.options);
}

function deliverAdrRankingResult_(data, options) {
  options = options || {};
  Logger.log(
    `取得完了: 全 ${data.allRows.length} 銘柄 / 有効 ${data.activeRows.length} 銘柄` +
      (data.hybridRescued ? ` / チャート補完 ${data.hybridRescued} 銘柄` : '')
  );

  if (
    options.notifySlack &&
    data.activeRows.length < CONFIG.MIN_ACTIVE_ROWS &&
    !options.testSlack
  ) {
    Logger.log(
      `有効銘柄が ${data.activeRows.length} 件のため Slack 通知をスキップ`
    );
    return;
  }

  if (options.notifySlack) {
    Logger.log('Slack 通知中…');
    notifySlack_({
      updatedAt: buildUpdatedAt_(),
      topUp: data.topUp,
      topDown: data.topDown,
      activeCount: data.activeRows.length,
      hybridRescued: data.hybridRescued || 0,
      sessionDate: data.sessionDateLabel,
      isTest: !!options.testSlack,
    });
    Logger.log('Slack 通知完了');
  }

  Logger.log('実行完了');
}

function loadPipelineState_() {
  const props = PropertiesService.getScriptProperties();
  const pendingJson = props.getProperty(PIPELINE.PENDING);
  if (!pendingJson) {
    return null;
  }
  return {
    pending: JSON.parse(pendingJson),
    quotes: JSON.parse(props.getProperty(PIPELINE.QUOTES) || '{}'),
    options: JSON.parse(props.getProperty(PIPELINE.OPTIONS) || '{}'),
    sessionKey: parseInt(props.getProperty(PIPELINE.SESSION_KEY), 10),
  };
}

function savePipelineState_(state) {
  PropertiesService.getScriptProperties().setProperties({
    [PIPELINE.PENDING]: JSON.stringify(state.pending),
    [PIPELINE.QUOTES]: JSON.stringify(state.quotes),
    [PIPELINE.OPTIONS]: JSON.stringify(state.options),
    [PIPELINE.SESSION_KEY]: String(state.sessionKey),
  });
}

function clearPipelineState_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PIPELINE.PENDING);
  props.deleteProperty(PIPELINE.QUOTES);
  props.deleteProperty(PIPELINE.OPTIONS);
  props.deleteProperty(PIPELINE.SESSION_KEY);
}

function scheduleNextPipelineBatch_() {
  removePipelineContinuationTriggers_();
  ScriptApp.newTrigger('processHybridPipelineBatch_')
    .timeBased()
    .after(CONFIG.PIPELINE_CONTINUE_DELAY_MS)
    .create();
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

const SLACK = {
  USERNAME: 'ADR Watcher',
  ICON_EMOJI: ':us:',
  COLOR_UP: '#36a64f',
  COLOR_DOWN: '#e01e5a',
  COLOR_FLAT: '#949494',
};

function notifySlack_(data) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty(
    'SLACK_WEBHOOK_URL'
  );
  if (!webhookUrl) {
    throw new Error(
      'SLACK_WEBHOOK_URL が未設定です。setupProperties() を実行してください。'
    );
  }

  const topUpRow = data.topUp[0];
  const topDownRow = data.topDown[0];
  const isTest = !!data.isTest;

  const headline =
    topUpRow && topDownRow
      ? `📊 ${isTest ? 'テスト通知: ' : 'ADR終了: '}ADR-東証 *${formatPct_(
          topUpRow.adrTsePct
        )}*（${formatStockLabel_(topUpRow)}）` +
        ` / *${formatPct_(topDownRow.adrTsePct)}*（${formatStockLabel_(
          topDownRow
        )}）`
      : '📊 日本株 ADR ADR-東証レポート';

  const metaLine =
    '🏷️ 日本株 ADR · 📅 ' +
    formatSlackDate_(data.updatedAt + (isTest ? '（テスト）' : '')) +
    ` · セッション ${data.sessionDate || '—'} · 有効 ${data.activeCount} 銘柄` +
    (data.hybridRescued
      ? ` · チャート補完 ${data.hybridRescued} 銘柄`
      : '') +
    ' · 基準: 東証前日終値 vs ADR終了直前';

  const bodyLines = [
    metaLine,
    '',
    '*📈 ADR-東証 上昇 Top 10*',
    formatSlackRank_(data.topUp),
    '',
    '*📉 ADR-東証 下落 Top 10*',
    formatSlackRank_(data.topDown),
    '',
    `<${CONFIG.ADR_PAGE_URL}|📋 nikkei225jp.com ADR 一覧>`,
  ];

  const topPct = topUpRow ? topUpRow.adrTsePct : 0;
  const attachment = {
    color: slackColorForChange_(topPct),
    title: '📊 日本株 ADR ADR-東証 Top 10',
    title_link: CONFIG.ADR_PAGE_URL,
    text: bodyLines.join('\n'),
    mrkdwn_in: ['text'],
    footer: 'nikkei225jp.com | ADR Watcher',
    ts: Math.floor(Date.now() / 1000),
  };

  const payload = {
    username: SLACK.USERNAME,
    icon_emoji: SLACK.ICON_EMOJI,
    text: headline,
    attachments: [attachment],
  };

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 400) {
    throw new Error(
      'Slack 通知失敗: ' + response.getResponseCode() + ' ' + response.getContentText()
    );
  }
}

function formatSlackRank_(rows) {
  if (!rows || rows.length === 0) return '_—_';
  return rows
    .map((r, i) => {
      const exchange = formatExchangeMark_(r.exchange);
      return (
        `${String(i + 1).padStart(2, ' ')}. ${formatStockLabel_(r)}` +
        `\n     \`ADR-東証 ${formatPct_(r.adrTsePct)}\`  ADR¥${formatNumber_(r.adrYen)}  ADR% ${formatPct_(r.adrPct)}  更新 ${r.adrMark}  ${exchange}`
      );
    })
    .join('\n');
}

function formatStockLabel_(row) {
  if (!row) return '—';
  const code = row.code;
  if (!code) return '—';
  const name = shortenCompanyName_(row.company || code);
  return `*${code}*（${name}）`;
}

function formatExchangeMark_(exchange) {
  if (exchange === 'NYSE') return 'N';
  if (exchange === 'NASDAQ') return 'Q';
  if (exchange === 'OTC') return 'OTC';
  return exchange || '';
}

function shortenCompanyName_(name) {
  return String(name)
    .replace(/（株）/g, '')
    .replace(/\(株\)/g, '')
    .replace(/株式会社/g, '')
    .replace(/ホールディングス/g, 'HD')
    .replace(/グループ/g, 'G')
    .replace(/\s+Common Stock$/i, '')
    .replace(/\s+Capital Stock$/i, '')
    .trim();
}

function formatSlackDate_(updatedAt) {
  const cleaned = String(updatedAt).replace('（テスト）', '').trim();
  const m = cleaned.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : cleaned;
}

function slackColorForChange_(pct) {
  if (pct > 0) return SLACK.COLOR_UP;
  if (pct < 0) return SLACK.COLOR_DOWN;
  return SLACK.COLOR_FLAT;
}

function formatNumber_(value) {
  return Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 0 });
}

function formatPct_(value) {
  const sign = value >= 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

// ---------------------------------------------------------------------------
// Data fetching (nikkei225jp.com)
// ---------------------------------------------------------------------------

function fetchAdrListText_() {
  const url = CONFIG.DATA_BASE_URL + CONFIG.PATH_ADR_ALL;
  const response = UrlFetchApp.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: CONFIG.DATA_REFERER,
    },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 400) {
    throw new Error('データ取得失敗: ' + url + ' (' + response.getResponseCode() + ')');
  }

  return response.getContentText('UTF-8');
}

function buildRankingFromRows_(allRows, sessionKey, now, options, quotesByCode) {
  options = options || {};
  quotesByCode = quotesByCode || {};
  const hybridRescued = applyChartQuotesToRows_(allRows, quotesByCode);
  const rows = allRows.map((row) =>
    Object.assign({}, row, { adrTsePct: computeAdrTseSpreadPct_(row, now) })
  );
  const activeRows = rows.filter((row) =>
    isActiveAdrRow_(row, sessionKey, now, options)
  );
  const ranked = activeRows.slice().sort((a, b) => b.adrTsePct - a.adrTsePct);
  const topUp = ranked.slice(0, 10);
  const topDown = ranked.slice().sort((a, b) => a.adrTsePct - b.adrTsePct).slice(0, 10);

  return {
    allRows: rows,
    activeRows: activeRows,
    topUp: topUp,
    topDown: topDown,
    sessionKey: sessionKey,
    sessionDateLabel: formatAdrSessionDateLabel_(sessionKey),
    hybridRescued: hybridRescued,
  };
}

function collectStaleCodes_(rows, sessionKey) {
  return rows
    .filter((row) => isStaleListGreyoutRow_(row, sessionKey))
    .sort((a, b) => {
      const dateKeyA = parseAdrDateKey_(a.adrMark) || 0;
      const dateKeyB = parseAdrDateKey_(b.adrMark) || 0;
      return dateKeyB - dateKeyA;
    })
    .map((row) => row.code)
    .filter(Boolean);
}

function applyChartQuotesToRows_(rows, quotesByCode) {
  let rescued = 0;
  rows.forEach((row) => {
    const quote = quotesByCode[row.code];
    if (!quote) {
      return;
    }
    row.adrYen = quote.adrYen;
    row.adrMark = quote.adrMark;
    row.hybridFromChart = true;
    rescued++;
  });
  return rescued;
}

function isStaleListGreyoutRow_(row, sessionKey) {
  const mark = String(row.adrMark || '');
  if (mark.indexOf('/') === -1) {
    return false;
  }
  const dateKey = parseAdrDateKey_(mark);
  return dateKey != null && dateKey !== sessionKey;
}

function fetchAdrChartQuotes_(codes, sessionKey, now, options) {
  const quotes = {};
  if (!codes.length) {
    return quotes;
  }

  const requests = codes.map((code) => ({
    url:
      CONFIG.DATA_BASE_URL +
      CONFIG.PATH_ADR_CHART +
      encodeURIComponent(code) +
      '.json',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer:
        CONFIG.DATA_BASE_URL + '/adr/adr.php?a=' + encodeURIComponent(code),
      Range: 'bytes=-' + CONFIG.HYBRID_RANGE_TAIL_BYTES,
    },
    muteHttpExceptions: true,
  }));

  const responses = UrlFetchApp.fetchAll(requests);
  codes.forEach((code, index) => {
    const response = responses[index];
    if (response.getResponseCode() >= 400) {
      return;
    }
    const quote = parseAdrChartCloseQuote_(
      response.getContentText('UTF-8'),
      sessionKey,
      now,
      options
    );
    if (quote) {
      quotes[code] = quote;
    }
  });

  return quotes;
}

/**
 * 個別チャート ADRm から ADR 終了直前の ADR¥（列 index 2）を抽出。
 */
function parseAdrChartCloseQuote_(text, sessionKey, now, options) {
  options = options || {};
  const tail =
    text.length > CONFIG.HYBRID_CHART_TAIL_BYTES
      ? text.slice(-CONFIG.HYBRID_CHART_TAIL_BYTES)
      : text;
  const sessionYmd = sessionKeyToJstYmd_(sessionKey, now);
  const sessionEnd = getAdrSessionEndMinute_(now);
  const minFresh = options.relaxedFreshness
    ? 0
    : sessionEnd - CONFIG.ADR_QUOTE_MAX_AGE_MINUTES;
  const maxFresh = options.relaxedFreshness
    ? 24 * 60 - 1
    : sessionEnd + CONFIG.ADR_QUOTE_GRACE_MINUTES;
  const tz = 'Asia/Tokyo';
  const re = /\[(\d+),([^\]]*)\]/g;
  let best = null;
  let match;

  while ((match = re.exec(tail)) !== null) {
    const ts = parseInt(match[1], 10);
    if (Number.isNaN(ts)) {
      continue;
    }
    const dt = new Date(ts);
    const tickMonth = parseInt(Utilities.formatDate(dt, tz, 'M'), 10) - 1;
    const tickDay = parseInt(Utilities.formatDate(dt, tz, 'd'), 10);
    if (tickMonth !== sessionYmd.month || tickDay !== sessionYmd.day) {
      continue;
    }

    const parts = String(match[2]).split(',');
    const adrYen = toNumber_(parts[2]);
    if (adrYen <= 0) {
      continue;
    }

    const tickMin =
      parseInt(Utilities.formatDate(dt, tz, 'H'), 10) * 60 +
      parseInt(Utilities.formatDate(dt, tz, 'm'), 10);
    if (tickMin < minFresh || tickMin > maxFresh) {
      continue;
    }

    if (!best || ts > best.ts) {
      best = {
        ts: ts,
        adrYen: adrYen,
        adrMark: Utilities.formatDate(dt, tz, 'HH:mm'),
      };
    }
  }

  return best;
}

function sessionKeyToJstYmd_(sessionKey, referenceDate) {
  return {
    year: parseInt(Utilities.formatDate(referenceDate, 'Asia/Tokyo', 'yyyy'), 10),
    month: Math.floor(sessionKey / 31) - 1,
    day: sessionKey % 31,
  };
}

function parseAdrRows_(text) {
  const re = /A0\[q\]="([^"]+)"/g;
  const rows = [];
  let match;
  let index = 0;
  while ((match = re.exec(text)) !== null) {
    rows.push(parseAdrRow_(index, match[1]));
    index++;
  }
  return rows;
}

function parseAdrRow_(index, raw) {
  const fields = (index + '_' + raw).split('_');
  if (fields.length < 19) {
    throw new Error('ADR 行データの形式が不正です: index=' + index);
  }

  return {
    code: fields[1],
    adrTicker: fields[2],
    company: fields[3],
    exchange: fields[6],
    tseTime: fields[8],
    tsePrice: toNumber_(fields[9]),
    tseChange: toNumber_(fields[10]),
    adrMark: fields[13],
    adrPct: toNumber_(fields[16]),
    adrYen: toNumber_(fields[18]),
  };
}

/**
 * nikkei225jp.com/adr/ と同じ ADR-東証 % を算出。
 * (ADR円換算 - 東証基準値) / 東証基準値 * 100
 */
function computeAdrTseSpreadPct_(row, now) {
  const tz = 'Asia/Tokyo';
  const hour = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
  const minute = parseInt(Utilities.formatDate(now, tz, 'm'), 10);
  const minOfDay = hour * 60 + minute;
  const overnight = minOfDay < 480 || minOfDay >= 1260;

  const tsti = String(row.tseTime || '');
  const isTokyoToday = tsti.indexOf(':') !== -1;
  let prev;

  if (!isTokyoToday) {
    prev = row.tsePrice;
  } else if (overnight) {
    prev = row.tsePrice;
  } else {
    prev = row.tsePrice - row.tseChange;
  }

  if (prev <= 0 || row.adrYen <= 0) {
    return null;
  }

  return ((row.adrYen - prev) / prev) * 100;
}

/**
 * nikkei225jp.com/adr/ と同じセッション日キー。
 * 平日 21 時 JST でリセット。土日は金曜セッションへ巻き戻す。
 */
function getAdrSessionDateKey_(date) {
  const h = new Date(date.getTime());
  h.setHours(h.getHours() - 21);
  if (h.getDay() === 6) {
    h.setHours(h.getHours() - 24);
  }
  if (h.getDay() === 0) {
    h.setHours(h.getHours() - 48);
  }
  return (h.getMonth() + 1) * 31 + h.getDate();
}

function parseAdrDateKey_(mmdd) {
  if (!mmdd || String(mmdd).indexOf('/') === -1) {
    return null;
  }
  const parts = String(mmdd).split('/');
  if (parts.length < 2) {
    return null;
  }
  return parseInt(parts[0], 10) * 31 + parseInt(parts[1], 10);
}

function formatAdrSessionDateLabel_(sessionKey) {
  const month = Math.floor(sessionKey / 31);
  const day = sessionKey % 31;
  return month + '/' + day;
}

function isActiveAdrRow_(row, sessionKey, now, options) {
  options = options || {};
  if (!row.code) {
    return false;
  }
  if (!isNotGreyedOutOnSite_(row, sessionKey)) {
    return false;
  }
  if (!options.relaxedFreshness && !isAdrQuoteFreshForClose_(row, now)) {
    return false;
  }
  return row.adrTsePct != null && !Number.isNaN(row.adrTsePct);
}

/**
 * nikkei225jp.com/adr/ のグレーアウト判定。
 * [13] が MM/DD のときだけ日付比較。HH:MM のときは日付グレー対象外。
 */
function isNotGreyedOutOnSite_(row, sessionKey) {
  const mark = String(row.adrMark || '');
  if (mark.indexOf('/') === -1) {
    return true;
  }
  const dateKey = parseAdrDateKey_(mark);
  return dateKey != null && dateKey === sessionKey;
}

/**
 * ADR 終了通知向け: [13] が終了直前（既定2時間以内）の更新のみ採用。
 * 23:00 台など古い ADR 価格が東証前日終値と突合されて上位化するのを防ぐ。
 */
function isAdrQuoteFreshForClose_(row, now) {
  const mark = String(row.adrMark || '');
  if (mark.indexOf(':') === -1) {
    return false;
  }

  const updateMin = parseTimeToMinutes_(mark);
  if (updateMin == null) {
    return false;
  }

  const sessionEnd = getAdrSessionEndMinute_(now);
  const minFresh = sessionEnd - CONFIG.ADR_QUOTE_MAX_AGE_MINUTES;
  const maxFresh = sessionEnd + CONFIG.ADR_QUOTE_GRACE_MINUTES;

  return updateMin >= minFresh && updateMin <= maxFresh;
}

function parseTimeToMinutes_(hhmm) {
  const parts = String(hhmm).split(':');
  if (parts.length < 2) {
    return null;
  }
  const hour = parseInt(parts[0], 10);
  const minute = parseInt(parts[1], 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

/** 米国サマータイム: ADR 終了 05:00 JST / 通常 06:00 JST */
function getAdrSessionEndMinute_(now) {
  return isUsDaylightSaving_(now) ? 300 : 360;
}

function isUsDaylightSaving_(date) {
  const jan = Utilities.formatDate(new Date(date.getFullYear(), 0, 1), 'America/New_York', 'Z');
  const current = Utilities.formatDate(date, 'America/New_York', 'Z');
  return current !== jan;
}

function buildUpdatedAt_() {
  const dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const time = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
  return dateStr + ' ' + time + ':00 JST';
}

function toNumber_(value) {
  if (value === '' || value == null) return 0;
  if (typeof value === 'string' && value.charAt(0) === '#') return 0;
  const normalized = String(value).replace(/,/g, '').replace(/\+/g, '');
  const n = Number(normalized);
  return Number.isNaN(n) ? 0 : n;
}
