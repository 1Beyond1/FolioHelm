import type { Language } from "./types";

export interface Copy {
  home: string;
  markets: string;
  trade: string;
  portfolio: string;
  orders: string;
  automation: string;
  searchSymbol: string;
  marketOpen: string;
  demoNotice: string;
  demoHint: string;
  account: string;
  settings: string;
  totalPortfolioValue: string;
  today: string;
  allTime: string;
  individualBrokerage: string;
  updatedJustNow: string;
  quickActions: string;
  search: string;
  watchlist: string;
  portfolioPerformance: string;
  portfolioChartHint: string;
  periods: string[];
  yourInvestingYear: string;
  consistencyHint: string;
  activity: string;
  dailyReturn: string;
  year: string;
  weekdays: string[];
  activeDays: string;
  ordersFilled: string;
  netChange: string;
  less: string;
  more: string;
  loss: string;
  gain: string;
  percent: string;
  usd: string;
  yourPositions: string;
  viewAll: string;
  recentActivity: string;
  moreActivity: string;
  tradeDemoTitle: string;
  tradeDemoBody: string;
  close: string;
  language: string;
  english: string;
  chinese: string;
  portfolioTooltip: string;
  actions: string;
  action: string;
  bestDay: string;
  downDays: string;
  noData: string;
  dataAvailable: string;
  demoFooter: string;
}

const COPY: Record<Language, Copy> = {
  en: {
    home: "Home",
    markets: "Markets",
    trade: "Trade",
    portfolio: "Portfolio",
    orders: "Orders",
    automation: "Automation",
    searchSymbol: "Search a symbol or company",
    marketOpen: "Market open",
    demoNotice: "Demo data · No brokerage connection",
    demoHint: "This preview uses fictional data only.",
    account: "•••• 1234",
    settings: "Settings",
    totalPortfolioValue: "Total portfolio value",
    today: "Today",
    allTime: "all time",
    individualBrokerage: "Individual brokerage · •••• 1234",
    updatedJustNow: "Updated just now",
    quickActions: "Quick actions",
    search: "Search",
    watchlist: "Watchlist",
    portfolioPerformance: "Portfolio performance",
    portfolioChartHint: "Move over the chart to inspect a value · scroll to adjust the time span",
    periods: ["1D", "1W", "1M", "6M", "1Y"],
    yourInvestingYear: "Your investing year",
    consistencyHint: "Small, consistent decisions add up.",
    activity: "Activity",
    dailyReturn: "Daily return",
    year: "2026",
    weekdays: ["Mon", "Wed", "Fri"],
    activeDays: "active days",
    ordersFilled: "orders filled",
    netChange: "net change",
    less: "Less",
    more: "More",
    loss: "Loss",
    gain: "Gain",
    percent: "%",
    usd: "USD",
    yourPositions: "Your positions",
    viewAll: "View all",
    recentActivity: "Recent activity",
    moreActivity: "More activity",
    tradeDemoTitle: "Trade is demo-only",
    tradeDemoBody: "This preview has no brokerage connection and cannot submit orders.",
    close: "Close",
    language: "Language",
    english: "English",
    chinese: "简体中文",
    portfolioTooltip: "Portfolio",
    actions: "investing actions",
    action: "investing action",
    bestDay: "best day",
    downDays: "down days",
    noData: "No data",
    dataAvailable: "Mock data",
    demoFooter: "FolioHelm demo · Fictional data only · Apache-2.0",
  },
  zh: {
    home: "首页",
    markets: "市场",
    trade: "交易",
    portfolio: "投资组合",
    orders: "订单",
    automation: "自动化",
    searchSymbol: "搜索股票代码或公司",
    marketOpen: "市场开放",
    demoNotice: "演示数据 · 未连接券商",
    demoHint: "此预览仅使用虚构数据。",
    account: "•••• 1234",
    settings: "设置",
    totalPortfolioValue: "投资组合总价值",
    today: "今日",
    allTime: "全部期间",
    individualBrokerage: "个人证券账户 · •••• 1234",
    updatedJustNow: "刚刚更新",
    quickActions: "快捷操作",
    search: "搜索",
    watchlist: "自选列表",
    portfolioPerformance: "组合表现",
    portfolioChartHint: "悬浮查看组合值 · 滚动调整时间跨度",
    periods: ["1日", "1周", "1月", "6月", "1年"],
    yourInvestingYear: "你的投资年度",
    consistencyHint: "持续做出小决定，也会积累成长期结果。",
    activity: "活动",
    dailyReturn: "每日收益",
    year: "2026",
    weekdays: ["一", "三", "五"],
    activeDays: "活跃天数",
    ordersFilled: "已成交订单",
    netChange: "净变化",
    less: "少",
    more: "多",
    loss: "亏损",
    gain: "收益",
    percent: "%",
    usd: "美元",
    yourPositions: "你的持仓",
    viewAll: "查看全部",
    recentActivity: "近期活动",
    moreActivity: "更多活动",
    tradeDemoTitle: "交易功能仅为演示",
    tradeDemoBody: "此预览未连接券商，不能提交真实订单。",
    close: "关闭",
    language: "语言",
    english: "English",
    chinese: "简体中文",
    portfolioTooltip: "组合",
    actions: "次投资操作",
    action: "次投资操作",
    bestDay: "最佳日",
    downDays: "下跌日",
    noData: "暂无数据",
    dataAvailable: "模拟数据",
    demoFooter: "FolioHelm 演示 · 仅虚构数据 · Apache-2.0",
  },
};

function readNavigatorLanguages(): string[] {
  if (typeof navigator === "undefined") return [];

  return [...navigator.languages, navigator.language];
}

export function detectInitialLanguage(languages: readonly string[] = readNavigatorLanguages()): Language {
  return languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

export function getCopy(language: Language): Copy {
  return COPY[language];
}
