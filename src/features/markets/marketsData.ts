import type { Language } from "../../types";
import { decimalToNumber } from "../../domain/decimal";
import { findMockHolding, findMockQuote } from "../../domain/mockBroker";
import { formatCurrency, formatSignedCurrency } from "../../formatters";
import type { DataStatus } from "../../domain/contracts";

export type MarketPeriod = "1D" | "1W" | "1M" | "6M" | "1Y";

export const MARKET_PERIODS: readonly MarketPeriod[] = ["1D", "1W", "1M", "6M", "1Y"];

interface MarketStats {
  volume: string;
  marketCap: string;
  averageVolume: string;
  dayRange: string;
  yearRange: string;
  peRatio: string;
  dividendYield: string;
}

export interface MarketStory {
  tagEn: string;
  tagZh: string;
  titleEn: string;
  titleZh: string;
  bodyEn: string;
  bodyZh: string;
}

export interface MarketSecurity {
  symbol: string;
  companyEn: string;
  companyZh: string;
  price: number;
  change: number;
  changePct: number;
  sparkline: readonly number[];
  chart: Record<MarketPeriod, readonly number[]>;
  shares: number;
  averageCost: number;
  holdingValue: number;
  holdingPnl: number;
  status?: DataStatus;
  stats: MarketStats;
  news: readonly MarketStory[];
}

export interface MarketOverview {
  symbol: string;
  labelEn: string;
  labelZh: string;
  value: string;
  changePct: number;
  sparkline: readonly number[];
}

export interface MarketsCopy {
  title: string;
  subtitle: string;
  marketDesk: string;
  marketStatus: string;
  marketStatusNote: string;
  fictionalData: string;
  fictionalDataDescription: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchHint: string;
  clearSearch: string;
  results: string;
  watchlistKicker: string;
  watchlistTitle: string;
  watchlistDescription: string;
  symbol: string;
  company: string;
  price: string;
  change: string;
  changePct: string;
  trend: string;
  action: string;
  noResults: string;
  noResultsBody: string;
  marketOverviewKicker: string;
  marketOverviewTitle: string;
  marketOverviewDescription: string;
  topMoversKicker: string;
  topMoversTitle: string;
  gainers: string;
  losers: string;
  openInstrument: string;
  trade: string;
  demo: string;
  backToMarkets: string;
  instrumentKicker: string;
  instrumentNoDataTitle: string;
  instrumentNoDataBody: string;
  quoteFreshness: string;
  quoteFreshnessValue: string;
  today: string;
  priceHistoryKicker: string;
  priceHistoryTitle: string;
  priceHistoryDescription: string;
  chartDescription: string;
  chartInteractionHint: string;
  holdingsKicker: string;
  holdingsTitle: string;
  holdingsDescription: string;
  shares: string;
  holdingValue: string;
  averageCost: string;
  unrealizedPnl: string;
  keyStatsKicker: string;
  keyStatsTitle: string;
  volume: string;
  marketCap: string;
  averageVolume: string;
  dayRange: string;
  yearRange: string;
  peRatio: string;
  dividendYield: string;
  newsKicker: string;
  newsTitle: string;
  newsDescription: string;
  demoContext: string;
  demoContextTime: string;
}

export const MARKET_COPY: Record<Language, MarketsCopy> = {
  en: {
    title: "Markets",
    subtitle: "A calm view of a fictional market session.",
    marketDesk: "Market desk",
    marketStatus: "US session · Demo",
    marketStatusNote: "Snapshot mode · no live feed",
    fictionalData: "Fictional data only",
    fictionalDataDescription: "Every quote on this page is invented for interface exploration.",
    searchLabel: "Search demo market",
    searchPlaceholder: "Search symbol or company",
    searchHint: "Try AAPL, NVDA, MSFT, SPY, or TSLA",
    clearSearch: "Clear search",
    results: "results",
    watchlistKicker: "Demo watchlist",
    watchlistTitle: "Watchlist",
    watchlistDescription: "A small set of familiar names in one fictional snapshot.",
    symbol: "Symbol",
    company: "Company",
    price: "Price",
    change: "Change",
    changePct: "Change %",
    trend: "Trend",
    action: "Action",
    noResults: "No matching symbols",
    noResultsBody: "Try a symbol or company name from the fictional watchlist.",
    marketOverviewKicker: "Market overview",
    marketOverviewTitle: "Major indices",
    marketOverviewDescription: "Index snapshots are fictional demo values.",
    topMoversKicker: "Top movers",
    topMoversTitle: "Gainers & losers",
    gainers: "Gainers",
    losers: "Losers",
    openInstrument: "Open instrument",
    trade: "Trade demo",
    demo: "Demo",
    backToMarkets: "Back to markets",
    instrumentKicker: "Fictional instrument",
    instrumentNoDataTitle: "No demo data for this symbol",
    instrumentNoDataBody: "This address does not map to one of the local fictional instruments. Return to Markets and choose a listed symbol. No quote, holding, chart, or trade action is available.",
    quoteFreshness: "Quote freshness",
    quoteFreshnessValue: "Demo snapshot · fictional",
    today: "Today",
    priceHistoryKicker: "Demo price history",
    priceHistoryTitle: "Price movement",
    priceHistoryDescription: "Mock SVG chart · no live market connection",
    chartDescription: "fictional price chart",
    chartInteractionHint: "Move over the chart to inspect a price · scroll to adjust the time span",
    holdingsKicker: "Your demo holding",
    holdingsTitle: "Position summary",
    holdingsDescription: "Fictional position summary · not an account statement.",
    shares: "Shares",
    holdingValue: "Market value",
    averageCost: "Average cost",
    unrealizedPnl: "Unrealized P&L",
    keyStatsKicker: "Instrument details",
    keyStatsTitle: "Key stats",
    volume: "Volume",
    marketCap: "Market cap",
    averageVolume: "Average volume",
    dayRange: "Day range",
    yearRange: "52-week range",
    peRatio: "P/E ratio",
    dividendYield: "Dividend yield",
    newsKicker: "Fictional market context",
    newsTitle: "Context notes",
    newsDescription: "Invented context cards included for this interface demo.",
    demoContext: "Fictional context",
    demoContextTime: "Demo note · no source",
  },
  zh: {
    title: "市场",
    subtitle: "用于浏览虚构行情时段的简洁视图。",
    marketDesk: "市场工作台",
    marketStatus: "美股时段 · 演示",
    marketStatusNote: "快照模式 · 无实时行情",
    fictionalData: "仅虚构数据",
    fictionalDataDescription: "页面中的每个报价都为界面探索而虚构。",
    searchLabel: "搜索演示市场",
    searchPlaceholder: "搜索股票代码或公司",
    searchHint: "试试 AAPL、NVDA、MSFT、SPY 或 TSLA",
    clearSearch: "清除搜索",
    results: "项结果",
    watchlistKicker: "演示自选列表",
    watchlistTitle: "自选列表",
    watchlistDescription: "多个熟悉标的的虚构快照。",
    symbol: "代码",
    company: "公司",
    price: "价格",
    change: "涨跌",
    changePct: "涨跌幅",
    trend: "趋势",
    action: "操作",
    noResults: "没有匹配的标的",
    noResultsBody: "请尝试虚构自选列表中的代码或公司名称。",
    marketOverviewKicker: "市场概览",
    marketOverviewTitle: "主要指数",
    marketOverviewDescription: "指数快照均为虚构演示数值。",
    topMoversKicker: "涨跌榜",
    topMoversTitle: "涨幅与跌幅",
    gainers: "涨幅榜",
    losers: "跌幅榜",
    openInstrument: "打开证券详情",
    trade: "交易演示",
    demo: "演示",
    backToMarkets: "返回市场",
    instrumentKicker: "虚构证券",
    instrumentNoDataTitle: "此代码暂无演示数据",
    instrumentNoDataBody: "这个地址不对应本地虚构证券。请返回市场页选择列表中的代码；当前没有报价、持仓、图表或交易操作可用。",
    quoteFreshness: "报价新鲜度",
    quoteFreshnessValue: "演示快照 · 虚构数据",
    today: "今日",
    priceHistoryKicker: "演示价格历史",
    priceHistoryTitle: "价格走势",
    priceHistoryDescription: "模拟 SVG 图表 · 无实时行情连接",
    chartDescription: "虚构价格图表",
    chartInteractionHint: "悬浮查看价格 · 滚动调整时间跨度",
    holdingsKicker: "你的演示持仓",
    holdingsTitle: "持仓摘要",
    holdingsDescription: "虚构持仓摘要 · 不是账户对账单。",
    shares: "持股数量",
    holdingValue: "持仓市值",
    averageCost: "平均成本",
    unrealizedPnl: "未实现盈亏",
    keyStatsKicker: "证券详情",
    keyStatsTitle: "关键统计",
    volume: "成交量",
    marketCap: "市值",
    averageVolume: "平均成交量",
    dayRange: "日内区间",
    yearRange: "52 周区间",
    peRatio: "市盈率",
    dividendYield: "股息率",
    newsKicker: "虚构市场背景",
    newsTitle: "背景笔记",
    newsDescription: "仅为本界面演示准备的虚构背景卡片。",
    demoContext: "虚构背景",
    demoContextTime: "演示笔记 · 无来源",
  },
};

export const MARKET_OVERVIEW: readonly MarketOverview[] = [
  {
    symbol: "SPX",
    labelEn: "S&P 500",
    labelZh: "标普 500",
    value: "5,248.30",
    changePct: 0.86,
    sparkline: [46, 48, 47, 52, 51, 54, 57, 56, 60, 63],
  },
  {
    symbol: "IXIC",
    labelEn: "Nasdaq",
    labelZh: "纳斯达克",
    value: "16,462.11",
    changePct: 1.24,
    sparkline: [41, 43, 42, 45, 49, 48, 53, 55, 54, 59],
  },
  {
    symbol: "DJI",
    labelEn: "Dow",
    labelZh: "道琼斯",
    value: "39,872.44",
    changePct: -0.18,
    sparkline: [58, 57, 59, 56, 55, 56, 54, 53, 55, 54],
  },
];

const COMMON_STATS: MarketStats = {
  volume: "48.2M",
  marketCap: "$2.86T",
  averageVolume: "52.4M",
  dayRange: "$221.57 – $226.34",
  yearRange: "$178.34 – $226.34",
  peRatio: "31.4",
  dividendYield: "0.52%",
};

const LEGACY_MARKET_SECURITIES: readonly MarketSecurity[] = [
  {
    symbol: "AAPL",
    companyEn: "Apple Inc.",
    companyZh: "苹果公司",
    price: 184.28,
    change: 2.68,
    changePct: 1.47,
    sparkline: [177, 179, 178, 181, 180, 182, 181, 184, 183, 184],
    chart: {
      "1D": [180.4, 181.6, 180.9, 182.8, 181.7, 183.1, 182.6, 184.1, 183.5, 184.28],
      "1W": [176.2, 177.8, 176.9, 179.6, 180.4, 179.8, 182.3, 184.28],
      "1M": [169.8, 172.5, 171.1, 175.9, 174.4, 178.2, 176.8, 182.7, 184.28],
      "6M": [158.7, 163.4, 160.9, 166.8, 171.5, 168.2, 175.4, 180.8, 184.28],
      "1Y": [145.2, 151.6, 148.8, 157.4, 162.1, 158.9, 169.2, 176.8, 181.2, 184.28],
    },
    shares: 24,
    averageCost: 161.78,
    holdingValue: 4422.72,
    holdingPnl: 540.0,
    stats: COMMON_STATS,
    news: [
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "Large-cap tech tone stays constructive in the demo",
        titleZh: "演示中的大型科技股情绪保持积极",
        bodyEn: "This invented note describes a steady session without making a real-world claim.",
        bodyZh: "这条虚构笔记描述了平稳时段，不代表任何真实世界判断。",
      },
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "A quiet product-cycle placeholder",
        titleZh: "安静的产品周期占位背景",
        bodyEn: "A fictional placeholder for how a context card can sit beside a quote.",
        bodyZh: "用于演示背景卡如何与报价并列的虚构占位内容。",
      },
    ],
  },
  {
    symbol: "NVDA",
    companyEn: "NVIDIA Corporation",
    companyZh: "英伟达",
    price: 121.54,
    change: 3.12,
    changePct: 2.63,
    sparkline: [110, 112, 111, 115, 116, 114, 118, 119, 121, 122],
    chart: {
      "1D": [117.2, 118.9, 117.8, 119.7, 120.2, 119.5, 121.1, 120.6, 121.8, 121.54],
      "1W": [111.4, 113.2, 112.7, 115.5, 114.9, 117.6, 119.3, 121.54],
      "1M": [98.6, 101.4, 104.2, 102.8, 108.7, 111.5, 109.4, 116.8, 121.54],
      "6M": [72.8, 78.4, 76.2, 86.1, 91.5, 97.8, 103.2, 111.7, 121.54],
      "1Y": [46.2, 52.8, 49.7, 63.5, 67.4, 78.6, 82.9, 94.4, 109.7, 121.54],
    },
    shares: 18,
    averageCost: 84.16,
    holdingValue: 2187.72,
    holdingPnl: 673.56,
    stats: {
      volume: "132.6M",
      marketCap: "$2.98T",
      averageVolume: "148.1M",
      dayRange: "$117.80 – $122.40",
      yearRange: "$39.23 – $132.80",
      peRatio: "52.1",
      dividendYield: "0.03%",
    },
    news: [
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "Demo momentum signal remains the strongest of the set",
        titleZh: "演示动能信号仍是列表中最强的一项",
        bodyEn: "The interface uses this invented context to show a higher-volatility mover.",
        bodyZh: "界面用这段虚构背景展示波动较高的标的。",
      },
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "A placeholder for theme-driven attention",
        titleZh: "主题驱动关注度的占位背景",
        bodyEn: "No live headline is being reported; this is only a mock market note.",
        bodyZh: "这里没有报道实时新闻，仅是虚构市场笔记。",
      },
    ],
  },
  {
    symbol: "MSFT",
    companyEn: "Microsoft Corporation",
    companyZh: "微软",
    price: 414.72,
    change: -1.86,
    changePct: -0.45,
    sparkline: [419, 418, 420, 417, 418, 416, 417, 415, 416, 415],
    chart: {
      "1D": [416.8, 417.4, 416.1, 415.9, 417.1, 416.4, 415.2, 415.7, 414.4, 414.72],
      "1W": [420.8, 419.4, 421.1, 418.6, 417.3, 416.5, 415.8, 414.72],
      "1M": [408.3, 412.2, 410.9, 416.8, 413.4, 419.1, 417.7, 415.5, 414.72],
      "6M": [347.8, 354.2, 369.8, 365.4, 382.6, 390.8, 404.3, 411.2, 414.72],
      "1Y": [303.4, 315.1, 306.8, 332.4, 347.6, 366.5, 381.7, 393.8, 406.4, 414.72],
    },
    shares: 8,
    averageCost: 361.9,
    holdingValue: 3317.76,
    holdingPnl: 422.56,
    stats: {
      volume: "18.7M",
      marketCap: "$3.08T",
      averageVolume: "20.9M",
      dayRange: "$412.80 – $418.10",
      yearRange: "$309.45 – $468.35",
      peRatio: "35.8",
      dividendYield: "0.72%",
    },
    news: [
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "A measured pullback keeps the demo tape balanced",
        titleZh: "适度回调让演示行情保持平衡",
        bodyEn: "This invented note is included to represent a softer daily move.",
        bodyZh: "这条虚构笔记用于展示日内较温和的下跌。",
      },
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "Enterprise theme placeholder",
        titleZh: "企业主题占位背景",
        bodyEn: "The detail is fictional and exists only to demonstrate the news layout.",
        bodyZh: "详情为虚构内容，仅用于演示新闻布局。",
      },
    ],
  },
  {
    symbol: "SPY",
    companyEn: "S&P 500 ETF",
    companyZh: "标普 500 ETF",
    price: 542.18,
    change: 1.04,
    changePct: 0.19,
    sparkline: [536, 537, 538, 537, 539, 540, 539, 541, 541, 542],
    chart: {
      "1D": [539.6, 540.1, 539.8, 541.2, 540.7, 541.8, 541.1, 542.4, 542.18],
      "1W": [535.9, 537.4, 536.8, 539.2, 538.6, 540.4, 541.7, 542.18],
      "1M": [526.4, 529.8, 528.2, 532.7, 535.4, 533.8, 539.6, 542.18],
      "6M": [461.2, 470.8, 478.4, 486.7, 499.2, 510.6, 521.8, 531.4, 542.18],
      "1Y": [413.6, 426.5, 438.8, 447.2, 459.9, 475.8, 488.7, 505.3, 522.6, 542.18],
    },
    shares: 12,
    averageCost: 487.5,
    holdingValue: 6506.16,
    holdingPnl: 656.16,
    stats: {
      volume: "31.4M",
      marketCap: "$514.2B",
      averageVolume: "36.8M",
      dayRange: "$539.20 – $543.00",
      yearRange: "$394.70 – $548.90",
      peRatio: "24.6",
      dividendYield: "1.28%",
    },
    news: [
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "Broad-market placeholder remains gently positive",
        titleZh: "大盘占位背景保持温和正向",
        bodyEn: "A fictional index note gives the diversified instrument a calm context card.",
        bodyZh: "这条虚构指数笔记为分散型标的提供平稳背景。",
      },
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "Range-bound session placeholder",
        titleZh: "区间震荡时段占位背景",
        bodyEn: "This is not a live market update; it is a visual example only.",
        bodyZh: "这不是实时行情更新，仅是视觉示例。",
      },
    ],
  },
  {
    symbol: "TSLA",
    companyEn: "Tesla, Inc.",
    companyZh: "特斯拉",
    price: 196.33,
    change: -4.72,
    changePct: -2.35,
    sparkline: [205, 204, 207, 202, 203, 200, 201, 198, 199, 196],
    chart: {
      "1D": [201.4, 202.8, 200.6, 201.1, 199.7, 200.4, 198.2, 197.6, 196.9, 196.33],
      "1W": [210.5, 207.8, 209.4, 204.1, 205.2, 201.9, 199.8, 196.33],
      "1M": [226.7, 221.4, 224.1, 216.8, 214.2, 207.9, 203.6, 201.4, 196.33],
      "6M": [248.8, 241.6, 235.1, 229.7, 218.4, 225.8, 211.2, 203.5, 196.33],
      "1Y": [268.2, 259.7, 245.9, 251.6, 236.8, 228.5, 219.1, 212.4, 204.7, 196.33],
    },
    shares: 10,
    averageCost: 218.4,
    holdingValue: 1963.3,
    holdingPnl: -220.7,
    stats: {
      volume: "92.5M",
      marketCap: "$626.4B",
      averageVolume: "104.2M",
      dayRange: "$194.70 – $201.90",
      yearRange: "$138.80 – $299.29",
      peRatio: "45.7",
      dividendYield: "—",
    },
    news: [
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "Higher-volatility placeholder adds contrast to the list",
        titleZh: "较高波动占位背景为列表增加对比",
        bodyEn: "This invented note demonstrates how a negative mover can be framed without a live headline.",
        bodyZh: "这条虚构笔记展示如何在没有实时新闻时呈现下跌标的。",
      },
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "A demo-only sentiment placeholder",
        titleZh: "仅用于演示的情绪占位背景",
        bodyEn: "All context here is fictional and should not be read as market research.",
        bodyZh: "这里的所有背景均为虚构，不应被理解为市场研究。",
      },
    ],
  },
  {
    symbol: "AMD",
    companyEn: "Advanced Micro Devices",
    companyZh: "超威半导体",
    price: 168.44,
    change: 1.94,
    changePct: 1.16,
    sparkline: [160, 162, 161, 164, 165, 164, 166, 167, 168, 168],
    chart: {
      "1D": [165.1, 166.7, 165.9, 167.2, 166.4, 168.1, 167.5, 168.44],
      "1W": [160.4, 162.1, 161.7, 164.8, 163.2, 166.5, 168.44],
      "1M": [151.7, 154.9, 153.4, 158.8, 160.1, 164.3, 168.44],
      "6M": [125.8, 132.2, 129.4, 140.6, 145.8, 151.2, 159.4, 168.44],
      "1Y": [96.4, 104.7, 101.6, 116.8, 124.4, 136.1, 145.6, 153.4, 168.44],
    },
    shares: 6,
    averageCost: 143.2,
    holdingValue: 1010.64,
    holdingPnl: 151.44,
    stats: {
      volume: "41.7M",
      marketCap: "$272.6B",
      averageVolume: "48.5M",
      dayRange: "$165.90 – $169.20",
      yearRange: "$93.12 – $227.30",
      peRatio: "42.2",
      dividendYield: "—",
    },
    news: [
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "A secondary demo gainer rounds out the board",
        titleZh: "第二个演示涨幅标的补全行情板",
        bodyEn: "An invented context card keeps the movers panel varied and self-contained.",
        bodyZh: "虚构背景卡让涨跌榜保持变化，同时不依赖外部信息。",
      },
    ],
  },
  {
    symbol: "AMZN",
    companyEn: "Amazon.com, Inc.",
    companyZh: "亚马逊",
    price: 181.27,
    change: -1.12,
    changePct: -0.61,
    sparkline: [185, 184, 185, 183, 184, 182, 183, 181, 182, 181],
    chart: {
      "1D": [183.4, 184.1, 183.7, 182.9, 183.6, 182.1, 182.7, 181.9, 181.27],
      "1W": [187.2, 185.6, 186.4, 184.3, 183.1, 182.6, 181.27],
      "1M": [179.5, 181.8, 183.2, 182.1, 186.4, 184.7, 182.8, 181.27],
      "6M": [144.1, 149.4, 153.2, 159.7, 163.6, 171.8, 176.4, 181.27],
      "1Y": [118.6, 126.3, 134.1, 139.8, 147.5, 155.4, 163.2, 171.6, 177.4, 181.27],
    },
    shares: 9,
    averageCost: 152.8,
    holdingValue: 1631.43,
    holdingPnl: 256.23,
    stats: {
      volume: "29.8M",
      marketCap: "$1.91T",
      averageVolume: "43.3M",
      dayRange: "$180.20 – $184.10",
      yearRange: "$118.35 – $201.20",
      peRatio: "42.8",
      dividendYield: "—",
    },
    news: [
      {
        tagEn: "Fictional context",
        tagZh: "虚构背景",
        titleEn: "A small demo dip keeps the downside list readable",
        titleZh: "小幅演示回落让跌幅榜保持易读",
        bodyEn: "This fictional context is a layout sample, not a report of current events.",
        bodyZh: "这段虚构背景是布局样例，不是当前事件报道。",
      },
    ],
  },
];

function alignSeriesToQuote(points: readonly number[], currentPrice: number): readonly number[] {
  if (points.length === 0) return [currentPrice];
  if (!Number.isFinite(currentPrice)) return [...points];
  const lastPoint = points[points.length - 1]!;
  if (!Number.isFinite(lastPoint) || lastPoint === 0) {
    const delta = Number.isFinite(lastPoint) ? currentPrice - lastPoint : 0;
    return points.map((point, index) =>
      index === points.length - 1 ? currentPrice : Number((point + delta).toFixed(2)),
    );
  }

  const ratio = currentPrice / lastPoint;
  return points.map((point, index) =>
    index === points.length - 1 ? currentPrice : Number((point * ratio).toFixed(2)),
  );
}

function formatPriceRange(points: readonly number[], currentPrice: number): string {
  const finite = points.filter(Number.isFinite);
  if (Number.isFinite(currentPrice)) finite.push(currentPrice);
  if (finite.length === 0) return "—";
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  return `${formatPrice(low)} – ${formatPrice(high)}`;
}

const EMPTY_MARKET_CHART: Record<MarketPeriod, readonly number[]> = {
  "1D": [],
  "1W": [],
  "1M": [],
  "6M": [],
  "1Y": [],
};

const EMPTY_MARKET_STATS: MarketStats = {
  volume: "—",
  marketCap: "—",
  averageVolume: "—",
  dayRange: "—",
  yearRange: "—",
  peRatio: "—",
  dividendYield: "—",
};

function noDataSecurity(symbol: string, companyEn: string, companyZh: string): MarketSecurity {
  return {
    symbol,
    companyEn,
    companyZh,
    price: Number.NaN,
    change: Number.NaN,
    changePct: Number.NaN,
    sparkline: [],
    chart: { ...EMPTY_MARKET_CHART },
    shares: Number.NaN,
    averageCost: Number.NaN,
    holdingValue: Number.NaN,
    holdingPnl: Number.NaN,
    status: "no-data",
    stats: { ...EMPTY_MARKET_STATS },
    news: [],
  };
}

/**
 * View data adapter. Chart/news/stat presentation remains local to this
 * feature, while quote and holding facts come from the canonical Mock Broker.
 */
function adaptMarketSecurity(security: MarketSecurity): MarketSecurity {
  const canonicalQuote = findMockQuote(security.symbol);
  const canonicalHolding = findMockHolding(security.symbol);
  if (!canonicalQuote) return noDataSecurity(security.symbol, security.companyEn, security.companyZh);

  const priceValue = decimalToNumber(canonicalQuote.price);
  const alignedChart = Object.fromEntries(
    Object.entries(security.chart).map(([period, points]) => [period, alignSeriesToQuote(points, priceValue)]),
  ) as Record<MarketPeriod, readonly number[]>;
  return {
    ...security,
    price: priceValue,
    change: decimalToNumber(canonicalQuote.change),
    changePct: decimalToNumber(canonicalQuote.changePct),
    sparkline: alignSeriesToQuote(security.sparkline, priceValue),
    chart: alignedChart,
    shares: canonicalHolding ? decimalToNumber(canonicalHolding.quantity) : 0,
    averageCost: canonicalHolding ? decimalToNumber(canonicalHolding.averageCost) : 0,
    holdingValue: canonicalHolding ? decimalToNumber(canonicalHolding.marketValue) : 0,
    holdingPnl: canonicalHolding ? decimalToNumber(canonicalHolding.totalPnl) : 0,
    status: canonicalQuote.status,
    stats: {
      ...security.stats,
      dayRange: formatPriceRange(alignedChart["1D"], priceValue),
      yearRange: formatPriceRange(alignedChart["1Y"], priceValue),
    },
  };
}

/** Stable fixture-shaped export retained for tests; use getMarketSecurities in views. */
export const MARKET_SECURITIES: readonly MarketSecurity[] = LEGACY_MARKET_SECURITIES.map(adaptMarketSecurity);

/** Rebuilds the view model from the current local broker scenario. */
export function getMarketSecurities(): readonly MarketSecurity[] {
  return LEGACY_MARKET_SECURITIES.map(adaptMarketSecurity);
}

export function getMarketSecurity(symbol: string): MarketSecurity {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const securities = getMarketSecurities();
  const match = securities.find((security) => security.symbol === normalizedSymbol);

  if (match) return match;

  const displaySymbol = normalizedSymbol || "DEMO";
  return noDataSecurity(
    displaySymbol,
    normalizedSymbol ? `No demo data for ${normalizedSymbol}` : "No demo instrument selected",
    normalizedSymbol ? `${normalizedSymbol} 暂无演示数据` : "尚未选择演示证券",
  );
}

export function companyForLanguage(security: MarketSecurity, language: Language): string {
  return language === "zh" ? security.companyZh : security.companyEn;
}

export function formatPrice(value: number, language: Language = "en"): string {
  return formatCurrency(value, language);
}

export function formatSignedPrice(value: number, language: Language = "en"): string {
  return formatSignedCurrency(value, language);
}

export function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function chartLinePath(points: readonly number[], width: number, height: number): string {
  if (points.length === 0) return "";

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const verticalPadding = height * 0.1;
  const denominator = Math.max(points.length - 1, 1);

  return points
    .map((point, index) => {
      const x = (index / denominator) * width;
      const y = verticalPadding + ((max - point) / range) * (height - verticalPadding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function chartAreaPath(points: readonly number[], width: number, height: number): string {
  const linePath = chartLinePath(points, width, height);
  if (!linePath) return "";

  return `${linePath} L ${width} ${height} L 0 ${height} Z`;
}

/**
 * Converts a sparse mock series into a denser series so pointer inspection and
 * wheel interpolation feel continuous instead of jumping between raw samples.
 */
export function resampleSeries(points: readonly number[], targetLength = 36): number[] {
  if (targetLength <= 0 || points.length === 0) return [];
  if (points.length === 1) return Array.from({ length: targetLength }, () => points[0]);

  const lastIndex = points.length - 1;
  return Array.from({ length: targetLength }, (_, index) => {
    const sourcePosition = (index / Math.max(targetLength - 1, 1)) * lastIndex;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, lastIndex);
    const fraction = sourcePosition - leftIndex;
    return points[leftIndex] + (points[rightIndex] - points[leftIndex]) * fraction;
  });
}

export function blendSeries(left: readonly number[], right: readonly number[], amount: number): number[] {
  const length = Math.max(left.length, right.length);
  if (length === 0) return [];

  const normalizedAmount = Math.min(1, Math.max(0, amount));
  const leftSeries = resampleSeries(left, length);
  const rightSeries = resampleSeries(right, length);

  return leftSeries.map((value, index) => value + (rightSeries[index] - value) * normalizedAmount);
}
