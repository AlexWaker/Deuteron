"use client";

import { useEffect, useState } from "react";

type Locale = "zh" | "en";
type Theme = "light" | "dark";

const content = {
  zh: {
    nav: {
      architecture: "架构",
      security: "安全模型",
      commands: "CLI",
      cta: "开始集成",
      themeLight: "亮",
      themeDark: "暗",
      languageLabel: "语言切换",
      themeLabel: "主题切换",
    },
    hero: {
      eyebrow: "Agent-native Web3 Wallet",
      title: "Deuteron Wallet",
      lead: "专为 AI Agent 设计的 CLI-first Web3 钱包。把私钥留在本地守护进程和 Keychain，把可组合、可审查、可脚本化的钱包能力交给命令行。",
      primary: "查看命令能力",
      secondary: "理解架构",
    },
    terminal: {
      statusA: "unsigned transaction",
      statusB: "ready for review",
    },
    ticker: ["CLI 控制", "Rust daemon", "macOS Keychain", "JSON-first output", "Jupiter Lend ready"],
    architecture: {
      eyebrow: "Architecture",
      title: "为 Agent 重写钱包边界",
      body: "Deuteron 采用客户端 CLI 与本地守护进程的双层架构。Agent 看到的是稳定命令；私钥看到的是本地系统安全边界。",
      layers: [
        {
          title: "deuteron CLI",
          body: "面向 AI Agent 和脚本的命令行入口。查询、构建、上下文切换都保持稳定 JSON 输出。",
        },
        {
          title: "Unix Domain Socket",
          body: "需要签名的操作走本地 socket 交给守护进程，命令侧不直接触碰私钥材料。",
        },
        {
          title: "deuteron-agent",
          body: "Rust 守护进程负责敏感签名动作，并用 macOS Code Signing 限定 Keychain 访问主体。",
        },
        {
          title: "macOS Keychain",
          body: "助记词和私钥保存在系统级安全容器里，日常签名不需要重复导出明文。",
        },
      ],
    },
    features: [
      {
        label: "Agent-friendly",
        title: "为命令调用而生",
        body: "没有浏览器插件和弹窗依赖。Agent 通过 `deu` 命令完成钱包创建、网络管理、当前上下文确认、交易构建与签名请求。",
      },
      {
        label: "Secure by default",
        title: "私钥隔离在守护进程",
        body: "敏感资料不通过命令行参数传入，避免 shell history、进程列表和日志泄漏。高风险导出与销毁走单独授权流程。",
      },
      {
        label: "Composable",
        title: "先审查，再执行",
        body: "Jupiter Lend 等 DeFi 能力拆成 read、build、execute 三层，让 Agent 在签名前检查 unsigned transaction 或 instructions。",
      },
      {
        label: "Multi-chain",
        title: "统一网络映射层",
        body: "内置 EVM、Solana、Bitcoin 生态映射，也支持自定义网络注册，保持命令输入自然、底层处理稳定。",
      },
    ],
    security: {
      eyebrow: "Security Model",
      title: "每条命令都有风险等级",
      body: "从只读查询到敏感资料销毁，Deuteron 把命令风险分层，让 Agent、脚本和人类用户都能在关键动作前建立相同预期。",
      rows: [
        ["0", "只读或本地状态", "network ls, wallet current"],
        ["1", "访问敏感资料但不暴露", "send, swap, execute"],
        ["2", "导出敏感资料", "export mnemonic"],
        ["3", "新增或写入敏感资料", "wallet create, import, derive"],
        ["4", "销毁敏感资料", "remove, uninstall"],
      ],
    },
    commands: {
      eyebrow: "CLI Surface",
      title: "给 Agent 的稳定操作面",
      body: "所有命令都支持 `--json`，错误输出到 stderr，并使用非 0 退出码。自然语言是给人看的，结构化输出才是给 Agent 绑定的契约。",
      rows: [
        ["deu init", "首次引导、安全声明与本地初始化"],
        ["deu wallet create --alias agent-vault", "创建不暴露助记词的 HD 钱包"],
        ["deu wallet current --json", "读取 Agent 可验证的当前上下文"],
        ["deu lend earn tokens --source auto", "查询 Jupiter Earn 可用资产"],
        ["deu lend borrow deposit build ...", "构建签名前可审查的交易指令"],
      ],
    },
    start: {
      eyebrow: "Build with Deuteron",
      title: "让 Agent 拥有自己的本地钱包执行层",
      body: "初始化 CLI、展示安全声明，并写入本地首次运行状态。",
    },
  },
  en: {
    nav: {
      architecture: "Architecture",
      security: "Security",
      commands: "CLI",
      cta: "Start building",
      themeLight: "Light",
      themeDark: "Dark",
      languageLabel: "Language switcher",
      themeLabel: "Theme switcher",
    },
    hero: {
      eyebrow: "Agent-native Web3 Wallet",
      title: "Deuteron Wallet",
      lead: "A CLI-first Web3 wallet built for AI agents. Keep private keys inside a local daemon and Keychain, while exposing composable, auditable wallet actions through the command line.",
      primary: "Explore commands",
      secondary: "See architecture",
    },
    terminal: {
      statusA: "unsigned transaction",
      statusB: "ready for review",
    },
    ticker: ["CLI control", "Rust daemon", "macOS Keychain", "JSON-first output", "Jupiter Lend ready"],
    architecture: {
      eyebrow: "Architecture",
      title: "A wallet boundary rebuilt for agents",
      body: "Deuteron uses a two-layer model: a client CLI and a local daemon. Agents get stable commands; private keys stay behind local system security boundaries.",
      layers: [
        {
          title: "deuteron CLI",
          body: "The command-line surface for AI agents and scripts. Queries, builders, and context switches all provide stable JSON output.",
        },
        {
          title: "Unix Domain Socket",
          body: "Signing requests move through a local socket to the daemon, so the CLI never handles private key material directly.",
        },
        {
          title: "deuteron-agent",
          body: "A Rust daemon handles sensitive signing operations and uses macOS Code Signing to scope Keychain access.",
        },
        {
          title: "macOS Keychain",
          body: "Mnemonics and private keys live in the system security container. Routine signing does not require plaintext export.",
        },
      ],
    },
    features: [
      {
        label: "Agent-friendly",
        title: "Built for command calls",
        body: "No browser extensions or pop-up workflows. Agents use `deu` to create wallets, manage networks, confirm context, build transactions, and request signatures.",
      },
      {
        label: "Secure by default",
        title: "Keys stay isolated",
        body: "Sensitive material is never passed through command-line arguments, avoiding shell history, process list, and log leaks.",
      },
      {
        label: "Composable",
        title: "Review before execution",
        body: "DeFi integrations such as Jupiter Lend are split into read, build, and execute layers so agents can inspect unsigned transactions before signing.",
      },
      {
        label: "Multi-chain",
        title: "Unified network mapping",
        body: "Built-in mappings cover EVM, Solana, and Bitcoin ecosystems, with custom network registration for stable low-level handling.",
      },
    ],
    security: {
      eyebrow: "Security Model",
      title: "Every command has a risk level",
      body: "From read-only queries to sensitive data destruction, Deuteron gives agents, scripts, and humans the same expectations before critical actions.",
      rows: [
        ["0", "Read-only or local state", "network ls, wallet current"],
        ["1", "Accesses secrets without exposing them", "send, swap, execute"],
        ["2", "Exports sensitive material", "export mnemonic"],
        ["3", "Creates or writes sensitive material", "wallet create, import, derive"],
        ["4", "Destroys sensitive material", "remove, uninstall"],
      ],
    },
    commands: {
      eyebrow: "CLI Surface",
      title: "A stable action surface for agents",
      body: "Every command supports `--json`, sends errors to stderr, and exits non-zero on failure. Natural language is for humans; structured output is the agent contract.",
      rows: [
        ["deu init", "First-run onboarding, safety notice, and local initialization"],
        ["deu wallet create --alias agent-vault", "Create an HD wallet without exposing the mnemonic"],
        ["deu wallet current --json", "Read the active context an agent can verify"],
        ["deu lend earn tokens --source auto", "List available Jupiter Earn assets"],
        ["deu lend borrow deposit build ...", "Build instructions that can be reviewed before signing"],
      ],
    },
    start: {
      eyebrow: "Build with Deuteron",
      title: "Give agents their own local wallet execution layer",
      body: "Initialize the CLI, show the safety notice, and write first-run state locally.",
    },
  },
};

export default function Home() {
  const [locale, setLocale] = useState<Locale>("zh");
  const [theme, setTheme] = useState<Theme>("light");
  const t = content[locale];

  useEffect(() => {
    const savedLocale = window.localStorage.getItem("deuteron-locale");
    const savedTheme = window.localStorage.getItem("deuteron-theme");

    if (savedLocale === "zh" || savedLocale === "en") {
      setLocale(savedLocale);
    }

    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem("deuteron-theme", theme);
    window.localStorage.setItem("deuteron-locale", locale);
  }, [locale, theme]);

  return (
    <main>
      <header className="siteHeader">
        <a className="brand" href="#top" aria-label="Deuteron Wallet">
          <span className="brandMark">D</span>
          <span>Deuteron</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#architecture">{t.nav.architecture}</a>
          <a href="#security">{t.nav.security}</a>
          <a href="#commands">{t.nav.commands}</a>
        </nav>
        <div className="headerControls">
          <div className="segmented" aria-label={t.nav.languageLabel}>
            <button
              className={locale === "zh" ? "active" : ""}
              type="button"
              onClick={() => setLocale("zh")}
            >
              中
            </button>
            <button
              className={locale === "en" ? "active" : ""}
              type="button"
              onClick={() => setLocale("en")}
            >
              EN
            </button>
          </div>
          <div className="segmented themeSwitch" aria-label={t.nav.themeLabel}>
            <button
              className={theme === "light" ? "active" : ""}
              type="button"
              onClick={() => setTheme("light")}
            >
              {t.nav.themeLight}
            </button>
            <button
              className={theme === "dark" ? "active" : ""}
              type="button"
              onClick={() => setTheme("dark")}
            >
              {t.nav.themeDark}
            </button>
          </div>
          <a className="headerCta" href="#start">
            {t.nav.cta}
          </a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="heroCopy">
          <p className="eyebrow">{t.hero.eyebrow}</p>
          <h1>{t.hero.title}</h1>
          <p className="heroLead">{t.hero.lead}</p>
          <div className="heroActions">
            <a className="primaryButton" href="#commands">
              {t.hero.primary}
            </a>
            <a className="secondaryButton" href="#architecture">
              {t.hero.secondary}
            </a>
          </div>
        </div>

        <div className="terminal" aria-label="Deuteron CLI preview">
          <div className="terminalTop">
            <span />
            <span />
            <span />
            <strong>agent-session</strong>
          </div>
          <div className="terminalBody">
            <p className="prompt">$ deu wallet current --json</p>
            <pre>{`{
  "ok": true,
  "data": {
    "alias": "agent-vault",
    "chain": "solana",
    "address": "9V...xQ",
    "mode": "keychain-signed"
  }
}`}</pre>
            <p className="prompt">$ deu lend earn deposit build --asset SOL --amount 1.5</p>
            <div className="statusLine">
              <span>{t.terminal.statusA}</span>
              <span>{t.terminal.statusB}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="tickerBand" aria-label="Product pillars">
        {t.ticker.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </section>

      <section className="section" id="architecture">
        <div className="sectionIntro">
          <p className="eyebrow">{t.architecture.eyebrow}</p>
          <h2>{t.architecture.title}</h2>
          <p>{t.architecture.body}</p>
        </div>
        <div className="architectureGrid">
          {t.architecture.layers.map((layer, index) => (
            <article className="layerCard" key={layer.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{layer.title}</h3>
              <p>{layer.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="featureBand">
        {t.features.map((feature) => (
          <article className="feature" key={feature.title}>
            <p>{feature.label}</p>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </article>
        ))}
      </section>

      <section className="section split" id="security">
        <div className="sectionIntro compact">
          <p className="eyebrow">{t.security.eyebrow}</p>
          <h2>{t.security.title}</h2>
          <p>{t.security.body}</p>
        </div>
        <div className="riskTable" role="table" aria-label="Deuteron security levels">
          {t.security.rows.map(([level, name, example]) => (
            <div className="riskRow" role="row" key={level}>
              <strong>[{level}]</strong>
              <span>{name}</span>
              <code>{example}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="commands">
        <div className="sectionIntro">
          <p className="eyebrow">{t.commands.eyebrow}</p>
          <h2>{t.commands.title}</h2>
          <p>{t.commands.body}</p>
        </div>
        <div className="commandList">
          {t.commands.rows.map(([command, description]) => (
            <div className="commandRow" key={command}>
              <code>{command}</code>
              <span>{description}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="start" id="start">
        <div>
          <p className="eyebrow">{t.start.eyebrow}</p>
          <h2>{t.start.title}</h2>
        </div>
        <div className="installBox">
          <code>pnpm deu init</code>
          <span>{t.start.body}</span>
        </div>
      </section>
    </main>
  );
}
